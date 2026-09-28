// core/business/intelligence/memoryIntegration.ts - Phase 11, sections
// 38-40, 69: writing CONFIRMED facts (and, separately, explicitly-labeled
// assumptions) into the existing Memory system - never a parallel store.
//
// Discipline (matching every prior phase's memory-writing code): only a
// statement whose `type` is "FACT" (a direct, current DB read - see
// core/business/intelligence/types.ts's taxonomy doc comment) is ever
// written with confidence 1 into the BUSINESS namespace as a "confirmed
// fact". A FORECAST/INFERENCE/RECOMMENDATION is written, if at all, into a
// DISTINCT key prefix ("assumption:") with an explicit, lower confidence -
// so a reader (human or the Brain) can always tell a confirmed fact from a
// speculative one from the memory key/confidence alone, never conflating
// them. remember()/supersede() are used exactly as core/memory/index.ts
// defines them - append-only, never a bare overwrite.
import { Memory } from "../../memory";
import type { IntelligenceStatement } from "./types";

const NAMESPACE = "BUSINESS" as const;

function keyFor(statement: IntelligenceStatement): string {
  const prefix = statement.type === "FACT" ? "fact" : "assumption";
  return `bi:${prefix}:${statement.id}`;
}

export interface MemoryWriteOutcome {
  written: boolean;
  key: string | null;
  reason: string;
}

/**
 * Writes ONE statement to Memory, applying the FACT-vs-assumption
 * distinction above. UNKNOWN statements are never written (there is nothing
 * confirmed or even speculative to record). RECOMMENDATION/FORECAST/
 * INFERENCE are written as low-confidence assumptions only if the caller
 * explicitly opts in (`includeAssumptions`) - a caller building a
 * confirmed-facts-only briefing memory should never pass that flag.
 */
export async function recordStatementToMemory(statement: IntelligenceStatement, options: { includeAssumptions?: boolean; source?: string } = {}): Promise<MemoryWriteOutcome> {
  if (statement.type === "UNKNOWN") {
    return { written: false, key: null, reason: "UNKNOWN statements are never written to memory (nothing confirmed or asserted)." };
  }
  const isFact = statement.type === "FACT";
  if (!isFact && !options.includeAssumptions) {
    return { written: false, key: null, reason: `Statement type ${statement.type} is not a confirmed FACT and includeAssumptions was not set - skipped.` };
  }

  const key = keyFor(statement);
  await Memory.remember({
    namespace: NAMESPACE,
    key,
    content: statement.narrative,
    value: { type: statement.type, label: statement.label, value: statement.value, provenance: statement.provenance },
    source: options.source ?? "business_intelligence",
    // FACT is fully confirmed (confidence 1); every other written type is
    // explicitly a lower-confidence assumption, never silently equated with
    // a confirmed fact.
    confidence: isFact ? 1 : 0.4,
  });
  return { written: true, key, reason: isFact ? "Confirmed FACT recorded." : "Recorded as a lower-confidence assumption (not a confirmed fact)." };
}

/** Convenience: records only the FACT-typed statements from a snapshot/briefing - the confirmed-facts-only path most callers want. */
export async function recordConfirmedFacts(statements: IntelligenceStatement[], source = "business_intelligence"): Promise<MemoryWriteOutcome[]> {
  const facts = statements.filter((s) => s.type === "FACT");
  const outcomes: MemoryWriteOutcome[] = [];
  for (const s of facts) {
    // eslint-disable-next-line no-await-in-loop -- append-only writes, small bounded set, order doesn't matter but sequential keeps this simple/testable.
    outcomes.push(await recordStatementToMemory(s, { source }));
  }
  return outcomes;
}
