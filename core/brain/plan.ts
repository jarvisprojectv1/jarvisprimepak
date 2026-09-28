// core/brain/plan.ts - the Structured Plan schema (Phase 4 / Brain & Memory).
//
// A Plan is PURE DATA, exactly like core/conditions' condition trees: it is
// never eval'd or executed as code. validatePlan() runs BEFORE any step
// executes; a plan that fails validation is rejected in full - no partial
// execution, ever (see core/brain/index.ts's runPlan()).
import { toolRegistry } from "../../tools/registry";
import { listAgents } from "../../agents/registry";

export interface PlanStep {
  stepId: string;
  description: string;
  /** Name of a registered agent to delegate this step to. Mutually exclusive with `tool`. */
  agent?: string;
  /** Name of a registered tool to call directly for this step. Mutually exclusive with `agent`. */
  tool?: string;
  /** Arguments passed to the agent's run() input or the tool's execute() input. */
  arguments?: Record<string, unknown>;
  /** What a successful outcome looks like, in plain language. */
  expectedResult: string;
  /** How to verify the step actually achieved expectedResult (checked after execution). */
  verification: string;
  /** Step ids this step depends on. An empty/absent list means it may run concurrently with siblings that also have none. */
  dependsOn?: string[];
}

export interface Plan {
  goal: string;
  /** Short, user-facing summary of the approach - NOT hidden chain-of-thought. */
  reasoning_summary: string;
  steps: PlanStep[];
  /** Plain-language description of what "done" means for the whole plan. */
  successCriteria: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a Plan's shape and cross-references every named tool/agent
 * against the live registries. Runs BEFORE any step executes - a plan that
 * fails validation must never partially execute (fail closed, exactly like
 * core/conditions).
 */
export function validatePlan(candidate: unknown): PlanValidationResult {
  const errors: string[] = [];

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, errors: ["Plan must be a JSON object."] };
  }
  const plan = candidate as Partial<Plan>;

  if (!plan.goal || typeof plan.goal !== "string") {
    errors.push("Plan.goal is required and must be a string.");
  }
  if (!plan.reasoning_summary || typeof plan.reasoning_summary !== "string") {
    errors.push("Plan.reasoning_summary is required and must be a string.");
  }
  if (!plan.successCriteria || typeof plan.successCriteria !== "string") {
    errors.push("Plan.successCriteria is required and must be a string.");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push("Plan.steps must be a non-empty array.");
    return { valid: false, errors };
  }

  const knownTools = new Set(toolRegistry.list().map((t) => t.name));
  const knownAgents = new Set(listAgents().map((a) => a.name));
  const seenStepIds = new Set<string>();

  plan.steps.forEach((step, index) => {
    const label = `steps[${index}]`;
    if (!step || typeof step !== "object") {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (!step.stepId || typeof step.stepId !== "string") {
      errors.push(`${label}.stepId is required and must be a string.`);
    } else if (seenStepIds.has(step.stepId)) {
      errors.push(`${label}.stepId "${step.stepId}" is duplicated.`);
    } else {
      seenStepIds.add(step.stepId);
    }
    if (!step.description || typeof step.description !== "string") {
      errors.push(`${label}.description is required and must be a string.`);
    }
    if (!step.expectedResult || typeof step.expectedResult !== "string") {
      errors.push(`${label}.expectedResult is required and must be a string.`);
    }
    if (!step.verification || typeof step.verification !== "string") {
      errors.push(`${label}.verification is required and must be a string.`);
    }
    const hasAgent = Boolean(step.agent);
    const hasTool = Boolean(step.tool);
    if (!hasAgent && !hasTool) {
      errors.push(`${label} must name exactly one of 'agent' or 'tool'.`);
    } else if (hasAgent && hasTool) {
      errors.push(`${label} must not name both 'agent' and 'tool'.`);
    } else if (hasAgent && !knownAgents.has(step.agent as string)) {
      errors.push(`${label}.agent "${step.agent}" is not a registered agent.`);
    } else if (hasTool && !knownTools.has(step.tool as string)) {
      errors.push(`${label}.tool "${step.tool}" is not a registered tool.`);
    }
    if (step.arguments !== undefined && (typeof step.arguments !== "object" || Array.isArray(step.arguments))) {
      errors.push(`${label}.arguments must be an object if present.`);
    }
    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn) || step.dependsOn.some((d) => typeof d !== "string")) {
        errors.push(`${label}.dependsOn must be an array of strings if present.`);
      }
    }
  });

  // Cross-check dependsOn references point at real step ids in this plan.
  plan.steps.forEach((step, index) => {
    for (const dep of step.dependsOn ?? []) {
      if (!seenStepIds.has(dep)) {
        errors.push(`steps[${index}].dependsOn references unknown stepId "${dep}".`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Parses the LLM's raw text output as JSON and validates it as a Plan.
 * Malformed JSON and a schema-invalid plan are both handled the same way:
 * fail closed, no partial execution, no arbitrary code execution.
 */
export function parseAndValidatePlan(raw: string): { plan: Plan } | { plan: null; errors: string[] } {
  let parsed: unknown;
  try {
    // Tolerate the model wrapping JSON in a fenced code block.
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const jsonText = fenceMatch ? fenceMatch[1] : raw;
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { plan: null, errors: [`Plan output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const validation = validatePlan(parsed);
  if (!validation.valid) {
    return { plan: null, errors: validation.errors };
  }
  return { plan: parsed as Plan };
}
