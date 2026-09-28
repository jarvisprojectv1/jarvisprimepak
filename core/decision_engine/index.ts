// core/decision_engine - request classification (spec section 29).
//
// Every incoming request/action JARVIS considers is classified into exactly
// one of five categories, which determines whether it can run automatically,
// needs configuration, needs more information, or needs human approval.

export type DecisionCategory =
  | "ROUTINE"
  | "CONFIGURED_BUSINESS_ACTION"
  | "INFORMATION_MISSING"
  | "HIGH_IMPACT"
  | "CRITICAL_SYSTEM_FAILURE";

export interface DecisionInput {
  /** The tool name being invoked, if this decision concerns a tool call. */
  toolName?: string;
  /** Whether the tool/action requires third-party configuration that is missing. */
  configurationMissing?: boolean;
  /** Whether required input fields for the action are missing. */
  requiredFieldsMissing?: string[];
  /** Estimated monetary value affected, if any (e.g. an order/quote total). */
  monetaryValue?: number;
  /** Whether the action is irreversible (e.g. sending an email, placing an order). */
  irreversible?: boolean;
  /** Whether this represents a system-level failure (crash, data corruption, security breach). */
  systemFailure?: boolean;
  /** Explicit list of action names pre-approved as safe/routine (from settings). */
  autoApprovedActions?: string[];
  /** The action name being evaluated. */
  actionName?: string;
}

export interface Decision {
  category: DecisionCategory;
  reason: string;
  requiresHumanApproval: boolean;
}

const DEFAULT_HIGH_IMPACT_THRESHOLD = 500; // currency units; overridable via settings in Phase 2+

/**
 * Classifies a request/action into one of the five decision categories.
 * Pure function - no I/O - so it is easy to unit test and to call from the
 * orchestrator, agents, and the scheduler alike.
 */
export function classify(
  input: DecisionInput,
  highImpactThreshold: number = DEFAULT_HIGH_IMPACT_THRESHOLD
): Decision {
  if (input.systemFailure) {
    return {
      category: "CRITICAL_SYSTEM_FAILURE",
      reason: "A system-level failure was reported.",
      requiresHumanApproval: true,
    };
  }

  if (
    input.requiredFieldsMissing &&
    input.requiredFieldsMissing.length > 0
  ) {
    return {
      category: "INFORMATION_MISSING",
      reason: `Missing required fields: ${input.requiredFieldsMissing.join(", ")}`,
      requiresHumanApproval: false,
    };
  }

  if (input.configurationMissing) {
    return {
      category: "INFORMATION_MISSING",
      reason: "Required third-party configuration is missing.",
      requiresHumanApproval: false,
    };
  }

  const isIrreversible = Boolean(input.irreversible);
  const exceedsThreshold =
    typeof input.monetaryValue === "number" &&
    input.monetaryValue >= highImpactThreshold;

  if (isIrreversible || exceedsThreshold) {
    return {
      category: "HIGH_IMPACT",
      reason: isIrreversible
        ? "Action is irreversible and requires human approval."
        : `Monetary value ${input.monetaryValue} meets/exceeds the high-impact threshold (${highImpactThreshold}).`,
      requiresHumanApproval: true,
    };
  }

  const autoApproved = input.autoApprovedActions ?? [];
  if (input.actionName && autoApproved.includes(input.actionName)) {
    return {
      category: "ROUTINE",
      reason: `"${input.actionName}" is pre-approved as a routine action.`,
      requiresHumanApproval: false,
    };
  }

  if (input.toolName) {
    return {
      category: "CONFIGURED_BUSINESS_ACTION",
      reason: `"${input.toolName}" is a configured business action within normal bounds.`,
      requiresHumanApproval: false,
    };
  }

  return {
    category: "ROUTINE",
    reason: "No risk factors detected; treated as routine.",
    requiresHumanApproval: false,
  };
}
