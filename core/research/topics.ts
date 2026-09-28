// core/research/topics.ts - Business Intelligence topics (Phase 6, item 8).
// The example topics are DATA rows (ResearchTopic table), never hardcoded
// business logic in TypeScript - seeded once (idempotent, upsert by unique
// name) like core/conditions/rules.ts's seedExampleConditionRules(), and
// editable afterward via apps/api/src/routes/research.ts.
import { prisma } from "../../database/client";

export interface DefaultTopic {
  name: string;
  query: string;
  pollIntervalMinutes?: number;
}

export const DEFAULT_RESEARCH_TOPICS: DefaultTopic[] = [
  { name: "apparel-packaging", query: "apparel packaging industry news" },
  { name: "garment-trims", query: "garment trims manufacturing trends" },
  { name: "hang-tags", query: "hang tags apparel manufacturing" },
  { name: "woven-labels", query: "woven labels apparel manufacturing" },
  { name: "satin-labels", query: "satin labels apparel manufacturing" },
  { name: "fashion-brands", query: "fashion brand news packaging sourcing" },
  { name: "dtc-brands", query: "direct-to-consumer apparel brand news" },
  { name: "shopify-brands", query: "Shopify apparel brand packaging" },
  { name: "ecommerce-packaging", query: "e-commerce packaging industry trends" },
  { name: "sustainable-packaging", query: "sustainable packaging apparel industry" },
  { name: "packaging-competitors", query: "apparel packaging manufacturer competitors" },
  { name: "pakistan-textile-industry", query: "Pakistan textile apparel industry news" },
  { name: "international-apparel-buyers", query: "international apparel buyers sourcing news" },
  { name: "packaging-market-developments", query: "packaging market developments apparel industry" },
];

/** Idempotently seeds the default Business Intelligence topics as DATA rows. */
export async function seedResearchTopics(): Promise<void> {
  for (const topic of DEFAULT_RESEARCH_TOPICS) {
    await prisma.researchTopic.upsert({
      where: { name: topic.name },
      update: {},
      create: {
        name: topic.name,
        query: topic.query,
        pollIntervalMinutes: topic.pollIntervalMinutes ?? 1440,
      },
    });
  }
}
