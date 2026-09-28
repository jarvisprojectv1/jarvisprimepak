// core/memory - the JARVIS memory system (spec section 6).
//
// Backed by the Prisma `memory` table. Memories are namespaced and
// append-only: writing to an existing (namespace, key) pair does NOT
// overwrite the row - it archives the previous ACTIVE entry and inserts a
// new one that records what it superseded. `search`/`read` only return
// ACTIVE entries by default, but the full history is always retrievable.
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
] as const;

export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[number];

export interface MemoryEntry {
  id: string;
  namespace: MemoryNamespace;
  key: string;
  value: unknown;
  importance: number;
  status: "ACTIVE" | "ARCHIVED";
  supersedes: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface CreateMemoryInput {
  namespace: MemoryNamespace;
  key: string;
  value: unknown;
  /** 1 (low) - 10 (critical). Defaults to 5. */
  importance?: number;
}

function toEntry(row: {
  id: string;
  namespace: string;
  key: string;
  value: string;
  importance: number;
  status: string;
  supersedes: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}): MemoryEntry {
  return {
    id: row.id,
    namespace: row.namespace as MemoryNamespace,
    key: row.key,
    value: JSON.parse(row.value),
    importance: row.importance,
    status: row.status as "ACTIVE" | "ARCHIVED",
    supersedes: row.supersedes,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Creates a new memory entry. If an ACTIVE entry already exists for the same
 * (namespace, key), it is archived first (append-only history / conflict
 * handling per spec section 6) rather than overwritten.
 */
export async function createMemory(
  input: CreateMemoryInput
): Promise<MemoryEntry> {
  const importance = input.importance ?? 5;
  if (importance < 1 || importance > 10) {
    throw new Error("importance must be between 1 and 10");
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
      value: JSON.stringify(input.value),
      importance,
      status: "ACTIVE",
      supersedes,
    },
  });

  log("ACTION", "memory.create", {
    namespace: input.namespace,
    key: input.key,
    supersedes,
  });

  return toEntry(created);
}

/** Reads the current ACTIVE entry for a (namespace, key) pair, if any. */
export async function readMemory(
  namespace: MemoryNamespace,
  key: string
): Promise<MemoryEntry | null> {
  const row = await prisma.memory.findFirst({
    where: { namespace, key, status: "ACTIVE" },
  });
  return row ? toEntry(row) : null;
}

/** Alias for createMemory - updating a memory key never overwrites, it appends. */
export async function updateMemory(
  input: CreateMemoryInput
): Promise<MemoryEntry> {
  return createMemory(input);
}

/** Full append-only history for a (namespace, key) pair, newest first. */
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

export interface SearchMemoryOptions {
  namespace?: MemoryNamespace;
  /** Case-insensitive substring match against the key and the JSON value. */
  query?: string;
  minImportance?: number;
  includeArchived?: boolean;
  limit?: number;
}

/** Simple substring search across ACTIVE memories (Phase 1: no embeddings/vector search yet). */
export async function searchMemory(
  options: SearchMemoryOptions = {}
): Promise<MemoryEntry[]> {
  const rows = await prisma.memory.findMany({
    where: {
      namespace: options.namespace,
      status: options.includeArchived ? undefined : "ACTIVE",
      importance: options.minImportance
        ? { gte: options.minImportance }
        : undefined,
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
      JSON.stringify(e.value).toLowerCase().includes(needle)
  );
}

export const Memory = {
  create: createMemory,
  read: readMemory,
  update: updateMemory,
  archive: archiveMemory,
  history: historyOf,
  search: searchMemory,
};
