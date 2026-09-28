// core/memory - the JARVIS memory system (spec section 6, extended Phase 4).
//
// Backed by the Prisma `memory` table. Memories are namespaced and
// append-only: writing to an existing (namespace, key) pair does NOT
// overwrite the row - it archives the previous ACTIVE entry and inserts a
// new one that records what it superseded. `search`/`retrieve` only return
// ACTIVE, non-expired entries by default, but the full history is always
// retrievable via `history`.
//
// Phase 4 design note (documented per the task spec's "pick one coherent
// design"): `content` is the primary, human-readable field a caller sets
// (e.g. "The client prefers matte lamination"); `value` remains the
// JSON-encoded structured payload, kept for backward compatibility with
// every Phase 1-3 caller that only ever passed `value`. Both are stored;
// `content` may be omitted (falls back to a stringified `value` when read),
// and `value` may be omitted (defaults to `null`) when a caller only has
// free-text content. This avoids a breaking rename of `value` while still
// giving Phase 4 callers a real human-readable field.
import { prisma } from "../../database/client";
import { log } from "../../security/logger";

export const MEMORY_NAMESPACES = [
  "PERSONAL",
  "BUSINESS",
  "CLIENT",
  "PROJECT",
  "PREFERENCE",
  "KNOWLEDGE",
  "TASK",
  "CONVERSATION",
  "EVENT",
  "DECISION",
] as const;

export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[number];

export interface MemoryEntry {
  id: string;
  namespace: MemoryNamespace;
  key: string;
  value: unknown;
  content: string | null;
  source: string | null;
  confidence: number;
  relatedEntity: string | null;
  metadata: unknown;
  expiresAt: Date | null;
  importance: number;
  status: "ACTIVE" | "ARCHIVED";
  supersedes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateMemoryInput {
  namespace: MemoryNamespace;
  key: string;
  /** JSON-encodable structured payload. Optional if `content` is given. */
  value?: unknown;
  /** Human-readable summary. Optional if `value` is given. */
  content?: string;
  /** 1 (low) - 10 (critical). Defaults to 5. */
  importance?: number;
  /** Who/what wrote this memory, e.g. "user", "agent:research", "brain". */
  source?: string;
  /** 0 (low confidence) - 1 (certain). Defaults to 1. */
  confidence?: number;
  /** e.g. a lead/company id this memory concerns. */
  relatedEntity?: string | null;
  /** Free-form JSON-encodable metadata. */
  metadata?: unknown;
  /** When this memory should be treated as expired ("forgotten"). */
  expiresAt?: Date | null;
}

type MemoryRow = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  content: string | null;
  source: string | null;
  confidence: number;
  relatedEntity: string | null;
  metadata: string | null;
  expiresAt: Date | null;
  importance: number;
  status: string;
  supersedes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    namespace: row.namespace as MemoryNamespace,
    key: row.key,
    value: row.value ? JSON.parse(row.value) : null,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    relatedEntity: row.relatedEntity,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    expiresAt: row.expiresAt,
    importance: row.importance,
    status: row.status as "ACTIVE" | "ARCHIVED",
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function isExpired(entry: { expiresAt: Date | null }, now = new Date()): boolean {
  return Boolean(entry.expiresAt && entry.expiresAt.getTime() <= now.getTime());
}

/**
 * Creates a new memory entry ("remember"). If an ACTIVE entry already exists
 * for the same (namespace, key), it is archived first (append-only history /
 * conflict handling per spec section 6) rather than overwritten.
 */
export async function createMemory(input: CreateMemoryInput): Promise<MemoryEntry> {
  const importance = input.importance ?? 5;
  if (importance < 1 || importance > 10) {
    throw new Error("importance must be between 1 and 10");
  }
  const confidence = input.confidence ?? 1;
  if (confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (input.value === undefined && input.content === undefined) {
    throw new Error("createMemory requires at least one of `value` or `content`");
  }

  const existing = await prisma.memory.findFirst({
    where: { namespace: input.namespace, key: input.key, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  let supersedes: string | null = null;
  if (existing) {
    await prisma.memory.update({
      where: { id: existing.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    supersedes = existing.id;
  }

  const created = await prisma.memory.create({
    data: {
      namespace: input.namespace,
      key: input.key,
      value: JSON.stringify(input.value ?? null),
      content: input.content ?? null,
      source: input.source ?? null,
      confidence,
      relatedEntity: input.relatedEntity ?? null,
      metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      expiresAt: input.expiresAt ?? null,
      importance,
      status: "ACTIVE",
      supersedes,
    },
  });

  log("ACTION", "memory.create", {
    namespace: input.namespace,
    key: input.key,
    supersedes,
    source: input.source,
  });

  return toEntry(created);
}

/** Reads the current ACTIVE, non-expired entry for a (namespace, key) pair, if any ("retrieve"). */
export async function readMemory(
  namespace: MemoryNamespace,
  key: string
): Promise<MemoryEntry | null> {
  const row = await prisma.memory.findFirst({
    where: { namespace, key, status: "ACTIVE" },
  });
  if (!row) return null;
  const entry = toEntry(row);
  return isExpired(entry) ? null : entry;
}

/** Alias for createMemory - updating a memory key never overwrites, it appends. */
export async function updateMemory(input: CreateMemoryInput): Promise<MemoryEntry> {
  return createMemory(input);
}

/**
 * Explicit "supersede" operation: same append-only archive-and-replace
 * semantics as update()/createMemory(), exposed as a first-class named
 * export per the Phase 4 spec's naming (`update` and `supersede` share one
 * internal implementation deliberately - there is exactly one way memories
 * are ever replaced).
 */
export const supersedeMemory = updateMemory;

/** Full append-only history for a (namespace, key) pair, newest first. Includes expired/archived entries. */
export async function historyOf(
  namespace: MemoryNamespace,
  key: string
): Promise<MemoryEntry[]> {
  const rows = await prisma.memory.findMany({
    where: { namespace, key },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toEntry);
}

/** Soft-deletes (archives) an ACTIVE memory entry without inserting a replacement. */
export async function archiveMemory(id: string): Promise<void> {
  await prisma.memory.update({
    where: { id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
  log("ACTION", "memory.archive", { id });
}

/**
 * "Forget" a memory: marks it expired (expiresAt = now) rather than deleting
 * it, matching the append-only/history-preserving design philosophy already
 * established for archive/supersede. An expired memory is excluded from
 * search()/retrieve() by default but its row (and full history) is never
 * physically deleted.
 */
export async function forgetMemory(id: string): Promise<MemoryEntry> {
  const row = await prisma.memory.update({
    where: { id },
    data: { expiresAt: new Date() },
  });
  log("ACTION", "memory.forget", { id });
  return toEntry(row);
}

export interface SearchMemoryOptions {
  namespace?: MemoryNamespace;
  /** Case-insensitive substring match against the key, content, and JSON value. */
  query?: string;
  minImportance?: number;
  includeArchived?: boolean;
  /** Include expired ("forgotten") entries. Defaults to false - matches "forget" semantics. */
  includeExpired?: boolean;
  relatedEntity?: string;
  limit?: number;
}

/** Simple substring search across ACTIVE, non-expired memories (no embeddings/vector search - deterministic keyword matching only, per design). */
export async function searchMemory(options: SearchMemoryOptions = {}): Promise<MemoryEntry[]> {
  const now = new Date();
  const rows = await prisma.memory.findMany({
    where: {
      namespace: options.namespace,
      status: options.includeArchived ? undefined : "ACTIVE",
      relatedEntity: options.relatedEntity,
      importance: options.minImportance ? { gte: options.minImportance } : undefined,
      ...(options.includeExpired
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: options.limit ?? 50,
  });

  const entries = rows.map(toEntry);
  if (!options.query) return entries;

  const needle = options.query.toLowerCase();
  return entries.filter(
    (e) =>
      e.key.toLowerCase().includes(needle) ||
      (e.content ?? "").toLowerCase().includes(needle) ||
      JSON.stringify(e.value).toLowerCase().includes(needle)
  );
}

export const Memory = {
  create: createMemory,
  remember: createMemory,
  read: readMemory,
  retrieve: readMemory,
  update: updateMemory,
  supersede: supersedeMemory,
  archive: archiveMemory,
  forget: forgetMemory,
  expire: forgetMemory,
  history: historyOf,
  search: searchMemory,
};
