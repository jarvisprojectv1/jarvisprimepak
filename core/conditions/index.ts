// core/conditions - the Condition Engine (Phase 3 / Identity & Events).
//
// HARD SECURITY REQUIREMENT: conditions are DATA, never code. This module
// NEVER uses eval, new Function, or any other dynamic code execution to
// evaluate a condition. A condition is a plain JSON tree of `all`/`any`/`not`
// combinators over a small fixed operator set, walked field-by-field with
// literal property lookups (see `getField` below, which explicitly refuses
// to traverse `__proto__`/`prototype`/`constructor` keys to block prototype-
// pollution-style payloads). Malformed or unknown-operator conditions FAIL
// CLOSED (evaluate to false, logged as a warning) - they never throw
// uncaught and never silently evaluate to true.
import { log } from "../../security/logger";

export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

export interface FieldCondition {
  field: string; // dot-path into the event, e.g. "payload.status"
  op: ConditionOperator;
  value: unknown;
}

export interface AllCondition {
  all: ConditionNode[];
}
export interface AnyCondition {
  any: ConditionNode[];
}
export interface NotCondition {
  not: ConditionNode;
}

export type ConditionNode = FieldCondition | AllCondition | AnyCondition | NotCondition;

const OPERATORS: Record<ConditionOperator, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => typeof a === "number" && typeof b === "number" && a > b,
  gte: (a, b) => typeof a === "number" && typeof b === "number" && a >= b,
  lt: (a, b) => typeof a === "number" && typeof b === "number" && a < b,
  lte: (a, b) => typeof a === "number" && typeof b === "number" && a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  contains: (a, b) => (typeof a === "string" && typeof b === "string" && a.includes(b)) || (Array.isArray(a) && a.includes(b)),
};

// Keys that must never be traversed - blocks prototype-pollution-style
// condition payloads such as { field: "__proto__.polluted", ... }.
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function getField(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) {
      log("SECURITY", "conditions.forbidden_key_blocked", { path, segment });
      return undefined;
    }
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isFieldCondition(node: unknown): node is FieldCondition {
  return (
    typeof node === "object" &&
    node !== null &&
    "field" in node &&
    "op" in node &&
    "value" in (node as Record<string, unknown>)
  );
}

/**
 * Evaluates a condition tree against `context` (typically a PersistedEvent).
 * Never executes any part of `node` as code - every branch is a structural
 * walk over plain data. Unknown operators, malformed nodes, or a field path
 * that hits a forbidden key all fail CLOSED (return false) rather than throw.
 */
export function evaluateCondition(node: unknown, context: unknown): boolean {
  try {
    if (node === null || typeof node !== "object") {
      log("WARNING", "conditions.malformed_node", { node: typeof node });
      return false;
    }

    const obj = node as Record<string, unknown>;

    if (Array.isArray(obj.all)) {
      return obj.all.every((child) => evaluateCondition(child, context));
    }
    if (Array.isArray(obj.any)) {
      return obj.any.some((child) => evaluateCondition(child, context));
    }
    if ("not" in obj) {
      return !evaluateCondition(obj.not, context);
    }
    if (isFieldCondition(obj)) {
      const { field, op, value } = obj;
      if (typeof field !== "string") {
        log("WARNING", "conditions.malformed_field", { field });
        return false;
      }
      const operator = OPERATORS[op as ConditionOperator];
      if (!operator) {
        log("WARNING", "conditions.unknown_operator", { op });
        return false;
      }
      const actual = getField(context, field);
      return operator(actual, value);
    }

    log("WARNING", "conditions.malformed_node", { keys: Object.keys(obj) });
    return false;
  } catch (err) {
    // Defense in depth: any unexpected error during evaluation still fails
    // closed rather than propagating.
    log("WARNING", "conditions.evaluation_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Parses a JSON string into a condition tree, or returns null (fail closed) if it's not valid JSON. */
export function parseConditionJson(json: string): unknown | null {
  try {
    return JSON.parse(json);
  } catch {
    log("WARNING", "conditions.invalid_json", {});
    return null;
  }
}
