// core/business/intelligence/executiveBriefing.ts - Phase 11, section 31:
// executive briefing content, deterministic-first. Assembles the snapshot's
// statements + recommendations; an AI narrative (synthesis.ts) is entirely
// OPTIONAL and only ever runs AFTER all deterministic calculation is done
// (section 49/51's explicit ordering requirement) - callers that don't have
// an AIProvider configured, or that want a cheap/no-cost briefing, get a
// fully deterministic briefing with no AI call at all.
import type { AIProvider } from "../../ai/provider";
import type { IntelligenceStatement, Recommendation } from "./types";
import { resolveTimeWindow, type TimeWindowName } from "./timeWindows";
import { getOrCreateBusinessSnapshot, type SnapshotType } from "./snapshot";
import { generateRecommendations } from "./recommendations";
import { getCompanyProfile, checkForDisallowedClaims } from "./companyProfile";
import { synthesizeBusinessNarrative } from "./synthesis";
import { log } from "../../../security/logger";

export interface ExecutiveBriefing {
  periodLabel: string;
  companyName: string;
  statements: Record<string, IntelligenceStatement>;
  recommendations: Recommendation[];
  /** Present only if an AIProvider was supplied and synthesis succeeded (and passed the claim-safety check). */
  aiNarrative: string | null;
  aiNarrativeNote: string;
}

export interface BuildBriefingOptions {
  windowName: TimeWindowName;
  snapshotType: SnapshotType;
  now?: Date;
  /** Optional: when provided, attempts a bounded AI narrative synthesis after all deterministic work is done. */
  aiProvider?: AIProvider;
  taskId?: string | null;
}

/**
 * Builds a full executive briefing for the given window: a real
 * BusinessSnapshot (immutable, idempotent per period), structured
 * recommendations, and an optional AI narrative. Every piece of AI-authored
 * text is passed through checkForDisallowedClaims() (section 3's
 * "Prime Pak itself has 25+ years" guard) before being surfaced - a
 * violation is dropped, never silently included.
 */
export async function buildExecutiveBriefing(options: BuildBriefingOptions): Promise<ExecutiveBriefing> {
  const window = resolveTimeWindow(options.windowName, options.now);
  const [snapshot, recommendations, profile] = await Promise.all([
    getOrCreateBusinessSnapshot(options.snapshotType, window),
    generateRecommendations(window),
    getCompanyProfile(),
  ]);

  let aiNarrative: string | null = null;
  let aiNarrativeNote = "AI narrative not requested (no AIProvider supplied) - briefing is fully deterministic.";

  if (options.aiProvider) {
    const statementList = Object.values(snapshot.statements);
    const outcome = await synthesizeBusinessNarrative({
      aiProvider: options.aiProvider,
      requestDescription: `Write a concise executive-briefing narrative for ${profile.tradingAs} covering ${window.label}. Reference only the given statement ids.`,
      statements: statementList,
      taskId: options.taskId ?? null,
    });

    if (outcome.ok) {
      const claimCheck = checkForDisallowedClaims(outcome.result.narrative);
      if (claimCheck.ok) {
        aiNarrative = outcome.result.narrative;
        aiNarrativeNote = `AI narrative generated from ${outcome.result.claims.length} grounded claim(s)${outcome.result.rejectedClaims.length > 0 ? `; ${outcome.result.rejectedClaims.length} ungrounded claim(s) were rejected and excluded` : ""}.`;
      } else {
        log("SECURITY", "business_intelligence.disallowed_claim_blocked", { violations: claimCheck.violations });
        aiNarrativeNote = "AI narrative was generated but contained a disallowed company-history claim and was discarded; falling back to deterministic statements only.";
      }
    } else {
      aiNarrativeNote = `AI narrative unavailable (${outcome.code}) - briefing is deterministic-only for this run.`;
    }
  }

  return {
    periodLabel: window.label,
    companyName: profile.tradingAs,
    statements: snapshot.statements,
    recommendations,
    aiNarrative,
    aiNarrativeNote,
  };
}
