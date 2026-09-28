// core/brain - the JARVIS Core Brain (Phase 4).
//
// Implements, for one request: OBSERVE -> UNDERSTAND -> RETRIEVE -> PLAN ->
// POLICY CHECK -> EXECUTE -> VERIFY -> REMEMBER -> REPORT. The Brain NEVER
// calls a tool's execute() or an agent's run() directly outside
// tools/registry.execute()/agents/registry.getAgent().run() - both of which
// are the same objects core/enforcement wraps at registration time, so every
// step still passes the full state/limits/policy gate (POLICY CHECK is not
// duplicated here - see core/brain/brain.test.ts's no-bypass proof).
import type { AIMessage, AIToolDefinition } from "../ai/provider";
import { createDefaultProvider, type AIProvider } from "../ai/provider";
import { checkCostLimit } from "../ai/costControl";
import { buildBrainContext, type BrainContext } from "../context";
import { getBrainSystemPrompt } from "./systemPrompt";
import { validatePlan, type Plan } from "./plan";
import { planFromPlan } from "../planner";
import { runPlan } from "./runPlan";
import { getSystemState } from "../state";
import { Memory } from "../memory";
import { log } from "../../security/logger";
import type { Identity } from "../auth/identity";
import type { BrainResult, BrainResultStatus } from "./types";

export type { BrainResult, BrainResultStatus, BrainStepOutcome } from "./types";
export { validatePlan, parseAndValidatePlan } from "./plan";
export type { Plan, PlanStep } from "./plan";

export interface BrainRequest {
  message: string;
  conversationId?: string;
  toolCall?: { name: string; input?: Record<string, unknown> };
}

export interface BrainHandleOptions {
  /**
   * Hardening pass: when supplied, the Brain attaches its plan's step-tasks
   * as children of this EXISTING task (via `core/planner.planFromPlan`'s
   * `rootTaskId` option) instead of creating its own, unrelated parent task.
   * Lets a caller (the Worker) say "attach your plan under THIS task" so the
   * triggering task and the executed plan share one real, queryable tree.
   */
  rootTaskId?: string;
  /** Internal: set on the Brain's own single re-plan retry (see #11 below). */
  _replanAttempted?: boolean;
}

const PROPOSE_PLAN_TOOL: AIToolDefinition = {
  name: "propose_plan",
  description:
    "Propose a structured, verifiable plan when the request needs a real action (a tool call or " +
    "delegating to an agent) rather than a conversational answer. Only call this when action is " +
    "actually needed - answer in plain text otherwise.",
  input_schema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The overall goal this plan accomplishes." },
      reasoning_summary: {
        type: "string",
        description: "A short, user-facing summary of the approach (not internal chain-of-thought).",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stepId: { type: "string" },
            description: { type: "string" },
            agent: { type: "string", description: "Name of a registered agent to delegate to (mutually exclusive with tool)." },
            tool: { type: "string", description: "Name of a registered tool to call (mutually exclusive with agent)." },
            arguments: { type: "object" },
            expectedResult: { type: "string" },
            verification: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
          },
          required: ["stepId", "description", "expectedResult", "verification"],
        },
      },
      successCriteria: { type: "string" },
    },
    required: ["goal", "reasoning_summary", "steps", "successCriteria"],
  },
};

function renderContextForPrompt(ctx: BrainContext): string {
  return JSON.stringify(
    {
      conversationHistory: ctx.conversationHistory.map((m) => ({ key: m.key, value: m.value })),
      relevantMemories: ctx.relevantMemories.map((m) => ({
        namespace: m.namespace,
        key: m.key,
        content: m.content ?? m.value,
      })),
      activeTasks: ctx.activeTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      recentLeads: ctx.recentLeads,
      systemState: ctx.systemState.state,
      availableTools: ctx.availableTools,
    },
    null,
    2
  );
}

export class Brain {
  constructor(private aiProvider: AIProvider = createDefaultProvider()) {}

  async handle(request: BrainRequest, identity?: Identity, options?: BrainHandleOptions): Promise<BrainResult> {
    const conversationId = request.conversationId ?? "default";
    const rootTaskId = options?.rootTaskId;
    const replanAttempted = options?._replanAttempted ?? false;

    // OBSERVE: check global state before doing any work at all.
    const state = await getSystemState();
    if (state.state === "PAUSED" || state.state === "EMERGENCY_STOP") {
      return {
        status: "BLOCKED",
        reply: `JARVIS is currently ${state.state}${state.reason ? ` (${state.reason})` : ""}. No action was taken.`,
      };
    }

    await Memory.create({
      namespace: "CONVERSATION",
      key: `${conversationId}:user`,
      value: { role: "user", message: request.message, at: new Date().toISOString() },
      content: request.message,
      source: "user",
      importance: 3,
    });

    // An explicit toolCall (legacy /chat shape) bypasses planning entirely -
    // still routed through the SAME guarded registry, never a new path.
    if (request.toolCall) {
      const { toolRegistry } = await import("../../tools/registry");
      const toolResult = await toolRegistry.execute(request.toolCall.name, request.toolCall.input ?? {}, identity);
      const reply = `Tool "${request.toolCall.name}" returned: ${toolResult.message}`;
      await this.remember(conversationId, reply);
      return { status: toolResult.status === "OK" ? "SUCCESS" : "PARTIAL", reply };
    }

    // UNDERSTAND + RETRIEVE
    const context = await buildBrainContext(request.message, conversationId);

    // Cost control: checked BEFORE the LLM call, per task/agentName-less
    // (chat-level) call - no taskId exists yet at this point.
    const costCheck = await checkCostLimit(null);
    if (!costCheck.allowed) {
      const reply = `JARVIS cannot respond right now: ${costCheck.reason}`;
      await this.remember(conversationId, reply);
      return { status: "WAITING", reply };
    }

    const systemPrompt = await getBrainSystemPrompt();
    const messages: AIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: `Context:\n${renderContextForPrompt(context)}` },
      { role: "user", content: request.message },
    ];

    const completion = await this.aiProvider.complete(messages, { tools: [PROPOSE_PLAN_TOOL] });

    if (!completion.ok) {
      const reply =
        completion.code === "CONFIGURATION_REQUIRED"
          ? completion.message
          : `JARVIS hit a provider error: ${completion.message}`;
      await this.remember(conversationId, reply);
      return {
        status: completion.code === "CONFIGURATION_REQUIRED" ? "REQUIRES_INFORMATION" : "FAILED",
        reply,
        configurationRequired: completion.code === "CONFIGURATION_REQUIRED",
      };
    }

    const planProposal = completion.toolUses.find((t) => t.name === "propose_plan");

    // No plan proposed: a plain conversational/informational reply - the
    // simple-chat path, functionally identical to the pre-Brain orchestrator.
    if (!planProposal) {
      await this.remember(conversationId, completion.content);
      return { status: "SUCCESS", reply: completion.content, model: completion.model };
    }

    // PLAN validation - fail closed, no partial execution, ever.
    const validation = validatePlan(planProposal.input);
    if (!validation.valid) {
      const reply =
        `JARVIS proposed a plan that failed validation and will not run it: ` +
        validation.errors.join("; ");
      log("WARNING", "brain.plan_rejected", { errors: validation.errors });
      await this.remember(conversationId, reply);
      return { status: "FAILED", reply };
    }
    const plan = planProposal.input as unknown as Plan;

    // Create real Task rows for the goal + one subtask per step (POLICY
    // CHECK happens per-step, inside core/enforcement, when each subtask is
    // actually executed below - not here). When rootTaskId is supplied, no
    // new parent row is created - the plan's steps become children of the
    // caller's own existing task (see planFromPlan's rootTaskId option).
    const { parent, subtasks } = await planFromPlan(plan, rootTaskId ? { rootTaskId } : undefined);
    const taskIdByStep = new Map(subtasks.filter((t) => t.stepId).map((t) => [t.stepId as string, t.id]));

    // EXECUTE (through the registry+enforcement gate only) + implicit VERIFY
    // (each step's own `verification` field is surfaced in the report; a
    // deeper automated verification pass is out of scope for this phase).
    const runResult = await runPlan(plan, taskIdByStep, identity);

    // When operating on a caller-supplied rootTaskId, the caller (the Worker)
    // owns that task's lifecycle - including retry accounting via
    // core/planner.retryOrFailTask on a FAILED outcome - so the Brain does
    // NOT also overwrite its status here (that would race the caller's own,
    // retry-aware status write with a plain one). For the Brain's own,
    // self-created task tree (no rootTaskId), this is still the only writer.
    if (!rootTaskId) {
      await updateParentTaskStatus(parent.id, runResult.status);
    }

    // REMEMBER: persist the plan + outcome to memory (DECISION namespace).
    const summary = `Plan for "${plan.goal}" finished with status ${runResult.status}.`;
    await Memory.remember({
      namespace: "DECISION",
      key: `plan:${parent.id}`,
      content: summary,
      value: { plan, outcomes: runResult.steps },
      source: "brain",
      relatedEntity: parent.id,
    });

    // REPORT: an honest, human-facing reply - never claims success a step
    // didn't actually achieve.
    const reply = buildReport(plan, runResult.status, runResult.steps);
    await this.remember(conversationId, reply);

    if (runResult.status === "FAILED" && !replanAttempted) {
      // Minimal, single documented re-plan attempt: give the Brain one more
      // try with the failure surfaced as context, never a full replanning
      // loop (see docs/PHASE4_BRAIN_MEMORY.md).
      const failureContext =
        `${request.message}\n\n(Note: a previous attempt at this failed. Failed steps: ` +
        `${runResult.steps
          .filter((s) => s.status === "FAILED")
          .map((s) => `${s.description} (${s.detail})`)
          .join("; ")}. Propose a different plan, or explain what information is missing.)`;
      return this.handle({ message: failureContext, conversationId }, identity, { rootTaskId, _replanAttempted: true });
    }

    return {
      status: runResult.status,
      reply,
      plan: { goal: plan.goal, reasoning_summary: plan.reasoning_summary, successCriteria: plan.successCriteria },
      steps: runResult.steps,
      taskId: parent.id,
      model: completion.model,
    };
  }

  private async remember(conversationId: string, reply: string): Promise<void> {
    await Memory.create({
      namespace: "CONVERSATION",
      key: `${conversationId}:assistant`,
      value: { role: "assistant", message: reply, at: new Date().toISOString() },
      content: reply,
      source: "brain",
      importance: 3,
    });
  }
}

async function updateParentTaskStatus(taskId: string, status: BrainResultStatus): Promise<void> {
  const { updateTaskStatus } = await import("../planner");
  const map: Record<BrainResultStatus, string> = {
    SUCCESS: "DONE",
    PARTIAL: "DONE",
    FAILED: "FAILED",
    WAITING: "WAITING",
    REQUIRES_INFORMATION: "WAITING",
    REQUIRES_TOOL: "WAITING",
    BLOCKED: "BLOCKED",
  };
  await updateTaskStatus(taskId, map[status] as never);
}

function buildReport(
  plan: Plan,
  status: BrainResultStatus,
  steps: { description: string; status: BrainResultStatus; detail: string }[]
): string {
  const lines = [`Goal: ${plan.goal}`, `Status: ${status}`, ""];
  for (const step of steps) {
    lines.push(`- [${step.status}] ${step.description}: ${step.detail}`);
  }
  if (status === "REQUIRES_TOOL") {
    lines.push("", "One or more steps need a capability that is not yet configured or implemented. No fabricated result was returned.");
  }
  if (status === "BLOCKED") {
    lines.push("", "Execution was halted because the system is paused or in emergency stop.");
  }
  return lines.join("\n");
}

export const brain = new Brain();
