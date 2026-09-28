// agents/contract.ts - a runtime check on the AgentRunResult contract: an
// agent must never report SUCCESS with no real evidence. This is a
// best-effort runtime guard (it can only check "is `evidence` present and
// non-empty", not "is it TRUE evidence of a real action" - that half of the
// contract is enforced by convention + code review, documented honestly
// here). Every built-in agent's SUCCESS path is expected to pass this.
export interface EvidenceCheckResult {
  ok: boolean;
  reason?: string;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** Returns ok:false if `status` is SUCCESS but `evidence`/`data`/`result` are all empty. */
export function checkAgentResultContract(result: {
  status: string;
  evidence?: unknown;
  data?: unknown;
  result?: unknown;
}): EvidenceCheckResult {
  if (result.status !== "SUCCESS") return { ok: true };
  const hasEvidence = !isEmpty(result.evidence) || !isEmpty(result.data) || !isEmpty(result.result);
  if (!hasEvidence) {
    return {
      ok: false,
      reason: "Agent reported SUCCESS with no evidence/data/result populated - contract violation.",
    };
  }
  return { ok: true };
}
