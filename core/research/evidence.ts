// core/research/evidence.ts - Evidence classification (Phase 6, item 6).
// A source merely claiming something is SOURCE_CLAIM, never automatically
// FACT. This module holds the type and a small, honest heuristic classifier
// - a real NLP claim-classifier is out of scope; the heuristic is
// deliberately conservative (defaults to SOURCE_CLAIM/UNCERTAIN rather than
// ever over-claiming FACT).
export type EvidenceClassification = "FACT" | "SOURCE_CLAIM" | "ANALYSIS" | "UNCERTAINTY";

const UNCERTAINTY_MARKERS = /\b(may|might|could|reportedly|allegedly|unclear|unconfirmed|rumor(ed)?|possibly)\b/i;
const ANALYSIS_MARKERS = /\b(analysts? (say|believe|expect)|forecast|projected|estimate[sd]?|outlook|trend)\b/i;
const CLAIM_MARKERS = /\b(said|claims?|according to|stated|announced|reported)\b/i;

/**
 * Best-effort, conservative classification of one extracted snippet of
 * source text. Anything not clearly a first-party statistic/fact from a
 * single sentence defaults to SOURCE_CLAIM - the safer default per the
 * spec's "a source merely claiming something is SOURCE_CLAIM, not
 * automatically FACT" rule.
 */
export function classifyEvidence(text: string): EvidenceClassification {
  if (UNCERTAINTY_MARKERS.test(text)) return "UNCERTAINTY";
  if (ANALYSIS_MARKERS.test(text)) return "ANALYSIS";
  if (CLAIM_MARKERS.test(text)) return "SOURCE_CLAIM";
  // No claim/analysis/uncertainty marker found: still not automatically
  // FACT - a single unverified source is SOURCE_CLAIM by default. FACT is
  // reserved for cases where the caller has cross-checked multiple
  // independent sources agreeing (see compareAcrossSources()).
  return "SOURCE_CLAIM";
}

export interface SourceExcerpt {
  sourceId: string;
  domain: string;
  text: string;
}

export interface ComparisonResult {
  agreement: "AGREE" | "CONFLICT" | "SINGLE_SOURCE" | "NO_SOURCES";
  note: string;
}

/**
 * Compares excerpts across multiple sources on the same topic/claim.
 * Deliberately simple (keyword-overlap heuristic, not semantic NLP) - a real
 * agreement/conflict detector is future work; this is honest about that.
 * Multiple sources agreeing (by this heuristic) is the only path that
 * upgrades a claim toward FACT-level confidence in the research agent.
 */
export function compareAcrossSources(excerpts: SourceExcerpt[]): ComparisonResult {
  if (excerpts.length === 0) return { agreement: "NO_SOURCES", note: "No sources to compare." };
  if (excerpts.length === 1) return { agreement: "SINGLE_SOURCE", note: "Only one source found; not independently corroborated." };

  const domains = new Set(excerpts.map((e) => e.domain));
  if (domains.size < 2) {
    return { agreement: "SINGLE_SOURCE", note: "Multiple excerpts, but from the same domain - not independent corroboration." };
  }

  // Very rough token-overlap check across independent domains.
  const tokenSets = excerpts.map((e) => new Set(e.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4)));
  const [first, ...rest] = tokenSets;
  const overlapRatios = rest.map((set) => {
    const shared = [...first].filter((t) => set.has(t)).length;
    return first.size > 0 ? shared / first.size : 0;
  });
  const avgOverlap = overlapRatios.reduce((a, b) => a + b, 0) / Math.max(1, overlapRatios.length);

  if (avgOverlap > 0.15) {
    return { agreement: "AGREE", note: `${domains.size} independent sources show overlapping content on this topic.` };
  }
  return { agreement: "CONFLICT", note: `${domains.size} independent sources discuss this topic with little textual overlap - they may disagree; not silently resolved.` };
}
