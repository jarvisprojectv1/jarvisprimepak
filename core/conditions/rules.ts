// core/conditions/rules.ts - loads ConditionRule rows for an event type and
// runs matching rules' actions. Rules are DATA (stored via Prisma), never
// hardcoded branches in TypeScript - see database/schema.prisma's
// ConditionRule model.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";
import { evaluateCondition, parseConditionJson } from "./index";
import type { PersistedEvent } from "../events";

export type ActionType = "create_task";

export interface CreateTaskActionParams {
  title: string;
  description?: string;
  priority?: "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
  /** Phase 5: lets a condition rule create a task pre-tagged for direct tool/agent execution by the worker. */
  toolName?: string;
  agentName?: string;
}

/** Runs every enabled ConditionRule whose eventType matches `event.type`, executing the action for each match. */
export async function runConditionRulesForEvent(event: PersistedEvent): Promise<void> {
  const rules = await prisma.conditionRule.findMany({ where: { eventType: event.type, enabled: true } });

  for (const rule of rules) {
    const condition = parseConditionJson(rule.conditionJson);
    if (condition === null) {
      log("WARNING", "conditions.rule_invalid_json", { ruleId: rule.id, ruleName: rule.name });
      continue;
    }

    const matched = evaluateCondition(condition, event);
    if (!matched) continue;

    log("INFO", "conditions.rule_matched", { ruleId: rule.id, ruleName: rule.name, eventId: event.id });

    try {
      await runAction(rule.actionType as ActionType, rule.actionParams, event);
    } catch (err) {
      log("ERROR", "conditions.rule_action_failed", {
        ruleId: rule.id,
        ruleName: rule.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runAction(actionType: ActionType, actionParamsJson: string, event: PersistedEvent): Promise<void> {
  if (actionType !== "create_task") {
    log("WARNING", "conditions.unknown_action_type", { actionType });
    return;
  }

  let params: CreateTaskActionParams;
  try {
    params = JSON.parse(actionParamsJson);
  } catch {
    log("WARNING", "conditions.invalid_action_params", { actionType });
    return;
  }
  if (!params || typeof params.title !== "string") {
    log("WARNING", "conditions.invalid_action_params", { actionType, reason: "missing title" });
    return;
  }

  // Lazy import avoids a core/conditions <-> core/planner <-> core/events
  // load-order cycle (planner itself publishes "task.created").
  const { planTask } = await import("../planner");
  await planTask({
    title: params.title,
    description: params.description ?? `Auto-created by condition rule from event ${event.type} (${event.id}).`,
    priority: params.priority,
    toolName: params.toolName,
    agentName: params.agentName,
  });
}

/**
 * Seeds the two example condition rules described in Phase 3's spec, as
 * DATA rows (never hardcoded branches). Idempotent: upserts by unique name.
 */
export async function seedExampleConditionRules(): Promise<void> {
  await prisma.conditionRule.upsert({
    where: { name: "crm-new-hot-lead-research" },
    update: {},
    create: {
      name: "crm-new-hot-lead-research",
      eventType: "CRM.lead.created",
      conditionJson: JSON.stringify({
        all: [
          { field: "payload.status", op: "eq", value: "NEW" },
          { field: "payload.score", op: "gt", value: 50 },
        ],
      }),
      actionType: "create_task",
      actionParams: JSON.stringify({
        title: "Research new hot lead",
        priority: "HIGH",
      }),
    },
  });

  // Phase 5 (#8/#11): the evening half of the Autonomous Daily Cycle. The
  // created task is tagged toolName:"reports" so the worker (core/worker)
  // executes it DIRECTLY through the guarded tool registry (tools/reports.ts
  // -> core/reports/dailyReport.ts), without needing a Brain planning round
  // trip for a deterministic, always-the-same action.
  await prisma.conditionRule.upsert({
    where: { name: "daily-report" },
    update: {},
    create: {
      name: "daily-report",
      eventType: "SCHEDULE.fired",
      conditionJson: JSON.stringify({
        all: [{ field: "payload.jobName", op: "eq", value: "daily-report" }],
      }),
      actionType: "create_task",
      actionParams: JSON.stringify({
        title: "Generate daily executive report",
        priority: "NORMAL",
        toolName: "reports",
      }),
    },
  });

  await prisma.conditionRule.upsert({
    where: { name: "morning-briefing" },
    update: {},
    create: {
      name: "morning-briefing",
      eventType: "SCHEDULE.fired",
      conditionJson: JSON.stringify({
        all: [{ field: "payload.jobName", op: "eq", value: "morning-briefing" }],
      }),
      actionType: "create_task",
      actionParams: JSON.stringify({
        title: "Prepare morning briefing",
        priority: "NORMAL",
      }),
    },
  });
}
