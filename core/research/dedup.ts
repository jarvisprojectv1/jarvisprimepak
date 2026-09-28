// core/research/dedup.ts - deduplication helpers (Phase 6, item 16).
// Canonical URL normalization lives in tools/web/sourceResolver.ts (reused
// here, not duplicated). This module adds content hashing (to catch the same
// content republished at a different URL) and the refresh-interval check
// that stops a scheduled/polled topic from re-fetching an unchanged source
// before its configured window elapses.
import { createHash } from "node:crypto";
import { prisma } from "../../database/client";
import { getResearchLimitsConfig } from "./limits";

export function hashContent(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export interface RefetchDecision {
  shouldFetch: boolean;
  reason: string;
  existingSource?: { id: string; contentHash: string | null; retrievedAt: Date };
}

/**
 * Looks up the most recent ResearchSource for `canonicalUrl` and decides
 * whether it's still "fresh enough" to skip re-fetching, per the configured
 * research.limits refresh interval (reusing maxResearchDurationMs's sibling
 * setting, minTopicPollIntervalMinutes, as the default refresh window when
 * no more specific interval is supplied).
 */
export async function shouldRefetch(canonicalUrl: string, refreshIntervalMinutes?: number): Promise<RefetchDecision> {
  const existing = await prisma.researchSource.findFirst({
    where: { canonicalUrl },
    orderBy: { retrievedAt: "desc" },
  });
  if (!existing) {
    return { shouldFetch: true, reason: "No prior ResearchSource recorded for this URL." };
  }

  const limits = await getResearchLimitsConfig();
  const windowMinutes = refreshIntervalMinutes ?? limits.minTopicPollIntervalMinutes;
  const ageMs = Date.now() - existing.retrievedAt.getTime();
  const windowMs = windowMinutes * 60 * 1000;

  if (ageMs < windowMs) {
    return {
      shouldFetch: false,
      reason: `Last retrieved ${Math.round(ageMs / 60000)} min ago, within the ${windowMinutes}-min refresh window.`,
      existingSource: { id: existing.id, contentHash: existing.contentHash, retrievedAt: existing.retrievedAt },
    };
  }
  return {
    shouldFetch: true,
    reason: `Last retrieved ${Math.round(ageMs / 60000)} min ago, past the ${windowMinutes}-min refresh window.`,
    existingSource: { id: existing.id, contentHash: existing.contentHash, retrievedAt: existing.retrievedAt },
  };
}

/** True if `newHash` matches the most recent stored hash for `canonicalUrl` (same content, possibly a different URL/refetch). */
export async function isUnchanged(canonicalUrl: string, newHash: string): Promise<boolean> {
  const existing = await prisma.researchSource.findFirst({
    where: { canonicalUrl },
    orderBy: { retrievedAt: "desc" },
  });
  return Boolean(existing?.contentHash && existing.contentHash === newHash);
}

/** True if any ResearchSource (any URL) already has this exact content hash - catches the same text republished elsewhere. */
export async function isDuplicateContent(contentHash: string): Promise<boolean> {
  const existing = await prisma.researchSource.findFirst({ where: { contentHash } });
  return Boolean(existing);
}
