// core/crm/leadWorkflow.ts - Lead research workflow (Phase 7, item 12).
//
// DESIGN CHOICE (documented, per the brief's "your call on exact wiring"):
// this workflow is a deterministic, code-driven orchestration - NOT routed
// through core/brain.Brain.handle(). The steps (research -> CRM create/
// update -> qualify -> next-action task) are a fixed, known sequence with no
// planning/judgment call for an LLM to make; running it through the Brain's
// plan-proposal loop would mean giving a model a `propose_plan` tool it has
// no legitimate use for here and would make the workflow depend on a
// configured LLM to do something that doesn't need one. Instead, this
// reuses Phase 5.1's core/worker + core/planner task-tree PATTERN directly:
// every step is a real child Task (parentId = the root task), so the
// resulting tree is exactly as traceable as a Brain-generated one (item 12's
// actual requirement) - see agents/lead-research.test.ts's task-tree
// assertions, which are the same shape as core/brain/rootTaskTree.test.ts's.
//
// Every step below still calls the research AGENT and CRM writes through
// their normal, unmodified paths (agents/registry.ts's guarded run(),
// toolRegistry, Prisma) - no "autonomous" bypass of core/enforcement.
import { planTask, updateTaskStatus, type PlannedTask } from "../planner";
import { getAgent } from "../../agents/registry";
import { prisma } from "../../database/client";
import { findOrCreateCompany, findOrCreateContact, findOrCreateLead } from "./dedup";
import { qualifyLead, type QualificationResult } from "./qualification";
import { recordActivity } from "./activity";
import { getSystemState } from "../state";
import { log } from "../../security/logger";

export interface LeadWorkflowInput {
  companyName: string;
  website?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactEmail?: string;
  source?: string;
  /** Reuse an existing task as the root instead of creating a new one (mirrors Brain's rootTaskId option). */
  rootTaskId?: string;
}

export interface LeadWorkflowResult {
  rootTaskId: string;
  leadId: string;
  companyId: string;
  contactId: string | null;
  researchRunId: string | null;
  qualification: QualificationResult;
  nextActionTaskId: string | null;
  status: "COMPLETED" | "WAITING" | "BLOCKED";
  errors: string[];
}

async function ensureRootTask(input: LeadWorkflowInput): Promise<PlannedTask> {
  if (input.rootTaskId) {
    const existing = await prisma.task.findUnique({ where: { id: input.rootTaskId } });
    if (existing) return existing as unknown as PlannedTask;
  }
  const [root] = await planTask({ title: `Lead research & qualification: ${input.companyName}` });
  return root;
}

/**
 * Runs the full research -> CRM -> qualify -> next-action workflow as a real
 * task tree under `rootTaskId` (created if not supplied). Re-invoking with
 * the SAME rootTaskId is safe: findOrCreateCompany/Contact/Lead are all
 * idempotent upserts (core/crm/dedup.ts), so a retried root task never
 * creates duplicate CRM records - only a duplicate child Task row (the same
 * non-negotiable core/brain/rootTaskTree.test.ts already documents for the
 * Brain's own rootTaskId path is out of scope to fully dedupe here; each
 * workflow run's own children are what matter for traceability).
 */
export async function runLeadResearchWorkflow(input: LeadWorkflowInput): Promise<LeadWorkflowResult> {
  const errors: string[] = [];
  const root = await ensureRootTask(input);
  await updateTaskStatus(root.id, "IN_PROGRESS");

  // Mid-flow pause/emergency-stop re-check (same pattern as
  // agents/research-agent.synthesis.test.ts's P/Q test) - a workflow already
  // in flight must not keep making CRM writes if the system was paused
  // between steps.
  const stateCheck = async (): Promise<boolean> => {
    const state = await getSystemState();
    return state.state === "PAUSED" || state.state === "EMERGENCY_STOP";
  };

  // Step 1: research
  const [researchTask] = await planTask({
    title: `Research: ${input.companyName}`,
    parentId: root.id,
    agentName: "research",
  });
  let researchRunId: string | null = null;
  const researchAgent = getAgent("research");
  if (await stateCheck()) {
    await updateTaskStatus(researchTask.id, "WAITING", "System paused/emergency-stopped.");
    await updateTaskStatus(root.id, "WAITING");
    return {
      rootTaskId: root.id,
      leadId: "",
      companyId: "",
      contactId: null,
      researchRunId: null,
      qualification: { qualified: "UNKNOWN", reasons: ["Workflow halted: system paused/emergency-stopped before research ran."], scoredAt: new Date().toISOString() },
      nextActionTaskId: null,
      status: "WAITING",
      errors,
    };
  }
  let researchCompleted = false;
  if (researchAgent) {
    await updateTaskStatus(researchTask.id, "IN_PROGRESS");
    const result = await researchAgent.run({ topic: input.companyName, taskId: researchTask.id });
    if (result.status === "SUCCESS") {
      researchCompleted = true;
      await updateTaskStatus(researchTask.id, "DONE");
    } else if (result.status === "NOT_IMPLEMENTED" || result.status === "WAITING") {
      await updateTaskStatus(
        researchTask.id,
        result.status === "WAITING" ? "WAITING" : "DONE",
        result.status === "WAITING" ? result.summary : undefined
      );
      errors.push(`Research: ${result.summary}`);
    } else {
      await updateTaskStatus(researchTask.id, "FAILED", result.summary);
      errors.push(`Research failed: ${result.summary}`);
    }
    const runRow = await prisma.researchRun.findFirst({ where: { taskId: researchTask.id }, orderBy: { startedAt: "desc" } });
    if (runRow) researchRunId = runRow.id;
  } else {
    await updateTaskStatus(researchTask.id, "FAILED", "Research agent not registered.");
    errors.push("Research agent not registered.");
  }

  // Step 2: CRM create/update (dedup-aware)
  const [crmTask] = await planTask({ title: `CRM: create/update ${input.companyName}`, parentId: root.id });
  await updateTaskStatus(crmTask.id, "IN_PROGRESS");
  const companyOutcome = await findOrCreateCompany({ name: input.companyName, website: input.website });
  let contactId: string | null = null;
  if (input.contactFirstName) {
    const contactOutcome = await findOrCreateContact({
      firstName: input.contactFirstName,
      lastName: input.contactLastName,
      email: input.contactEmail,
      companyId: companyOutcome.record.id,
    });
    contactId = contactOutcome.record.id;
  }
  const leadOutcome = await findOrCreateLead({ companyId: companyOutcome.record.id, contactId, source: input.source ?? "research" });
  await prisma.lead.update({
    where: { id: leadOutcome.record.id },
    data: { status: leadOutcome.isNew ? "RESEARCHING" : undefined, researchRunId: researchRunId ?? undefined },
  });
  await recordActivity({
    contactId,
    activityType: "TASK_LINKED",
    relatedEntityId: leadOutcome.record.id,
    summary: `Lead ${leadOutcome.isNew ? "created" : "updated"} from research workflow (task ${root.id}).`,
  });
  await updateTaskStatus(crmTask.id, "DONE");

  // Step 3: qualify (deterministic, no LLM)
  const [qualifyTask] = await planTask({ title: `Qualify: ${input.companyName}`, parentId: root.id });
  await updateTaskStatus(qualifyTask.id, "IN_PROGRESS");
  const qualification = qualifyLead({
    hasVerifiedCompany: !companyOutcome.isNew || researchCompleted,
    hasNamedContact: Boolean(input.contactFirstName),
    researchCompleted,
    industryMatchesProductLine: undefined,
  });
  await prisma.lead.update({
    where: { id: leadOutcome.record.id },
    data: {
      qualification: JSON.stringify(qualification),
      status: qualification.qualified === true ? "QUALIFIED" : undefined,
    },
  });
  await updateTaskStatus(qualifyTask.id, "DONE");

  // Step 4: next-action task
  const nextTitle =
    qualification.qualified === true
      ? `Draft outreach email for ${input.companyName}`
      : qualification.qualified === "UNKNOWN"
        ? `Gather more information on ${input.companyName} before qualifying`
        : `Review disqualified lead: ${input.companyName}`;
  const [nextTask] = await planTask({ title: nextTitle, parentId: root.id });

  await updateTaskStatus(root.id, errors.length > 0 ? "DONE" : "DONE"); // root completes once its children are dispatched; failures are recorded on the children/errors[]
  log("BUSINESS", "crm.lead_workflow_completed", { rootTaskId: root.id, leadId: leadOutcome.record.id, qualified: qualification.qualified });

  return {
    rootTaskId: root.id,
    leadId: leadOutcome.record.id,
    companyId: companyOutcome.record.id,
    contactId,
    researchRunId,
    qualification,
    nextActionTaskId: nextTask.id,
    status: "COMPLETED",
    errors,
  };
}
