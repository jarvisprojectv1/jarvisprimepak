// core/email/ingest.ts - inbound email ingestion (Phase 7, items 3-5).
//
// Idempotent upsert-by-provider-id (item 5): Email.providerMessageId has a
// DB unique constraint, so processing the same provider message twice (e.g.
// a retried "check inbox" task) upserts the same row rather than duplicating
// it - proven by core/email/ingest.test.ts's item AK.
//
// Retention discipline (item 3-4, section 23): the full email body IS stored
// in the Email row (with clear ownership - it's the row's own reason to
// exist), but NOTHING from the raw body is written into Memory directly.
// Only a durable, deterministic-classification-derived FACT (the category +
// a short summary) is written to Memory, with `relatedEntity` pointing at
// the real Email row id - matching the same provenance discipline
// core/research uses (Memory -> Evidence, here Memory -> Email).
import { prisma } from "../../database/client";
import { normalizeEmail } from "../crm/dedup";
import { classifyEmailDeterministic } from "../business/emailClassification";
import { logInjectionSignalsIfAny } from "../research/trustBoundary";
import { createMemory } from "../memory";
import type { EmailMessage } from "../../tools/email/types";

export interface IngestedEmail {
  id: string;
  providerMessageId: string;
  isNew: boolean;
  classification: string;
}

/**
 * Ingests one inbound EmailMessage: idempotent upsert by providerMessageId,
 * links/creates a Contact by normalized from-address (dedup-aware),
 * deterministically classifies it, best-effort logs any injection-signal
 * flags (log-only, never blocking - see trustBoundary.ts), and writes one
 * durable Memory fact.
 */
export async function ingestInboundEmail(msg: EmailMessage): Promise<IngestedEmail> {
  const normalizedFrom = normalizeEmail(msg.from);
  let contactId: string | null = null;
  if (normalizedFrom) {
    const contact = await prisma.contact.findFirst({ where: { normalizedEmail: normalizedFrom } });
    contactId = contact?.id ?? null;
  }

  const classification = classifyEmailDeterministic(msg.subject, msg.body);

  // Best-effort, log-only signal scan (never blocks ingestion or classification).
  logInjectionSignalsIfAny(msg.body, { url: `email:${msg.providerMessageId}` });

  const existing = await prisma.email.findUnique({ where: { providerMessageId: msg.providerMessageId } });
  const row = await prisma.email.upsert({
    where: { providerMessageId: msg.providerMessageId },
    update: {
      subject: msg.subject,
      body: msg.body,
      threadId: msg.threadId,
      fromAddress: msg.from,
      toAddress: msg.to.join(", "),
      classification: classification.category,
      classificationReasons: JSON.stringify(classification.reasons),
    },
    create: {
      contactId,
      direction: "inbound",
      subject: msg.subject,
      body: msg.body,
      status: "RECEIVED",
      providerMessageId: msg.providerMessageId,
      threadId: msg.threadId,
      fromAddress: msg.from,
      toAddress: msg.to.join(", "),
      classification: classification.category,
      classificationReasons: JSON.stringify(classification.reasons),
    },
  });

  if (!existing) {
    await createMemory({
      namespace: "CLIENT",
      key: `email:${row.id}:classification`,
      content: `Inbound email from ${msg.from} classified as ${classification.category}.`,
      source: "email-ingest",
      confidence: classification.confidence,
      relatedEntity: row.id,
      metadata: { category: classification.category, reasons: classification.reasons },
    });
  }

  return { id: row.id, providerMessageId: row.providerMessageId!, isNew: !existing, classification: classification.category };
}
