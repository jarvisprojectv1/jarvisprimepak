// core/context - Context Builder (Phase 4 / Brain & Memory).
//
// Assembles a bounded, relevant context object for the Brain. Deliberately
// NOT vector/embedding search (per explicit instruction) - relevance is
// deterministic keyword/category/entity matching over core/memory.search()
// and simple heuristics elsewhere. Every category is capped (documented
// inline) so this never dumps the whole database into a prompt.
import { Memory, type MemoryEntry } from "../memory";
import { listTasks, type PlannedTask } from "../planner";
import { getSystemState, isToolDisabled, type SystemStateRecord } from "../state";
import { toolRegistry } from "../../tools/registry";
import { prisma } from "../../database/client";

const CONVERSATION_HISTORY_LIMIT = 10; // last N CONVERSATION memory turns
const RELEVANT_MEMORY_LIMIT = 10; // top N relevant memories (importance + recency, already core/memory's order)
const ACTIVE_TASK_LIMIT = 10; // most recent non-terminal tasks
const RECENT_LEADS_LIMIT = 5; // recent CRM leads, only when the request looks business-related

const TERMINAL_TASK_STATUSES = new Set(["DONE", "FAILED", "CANCELLED"]);

// Simple, deterministic keyword heuristic - no ML/embeddings.
const BUSINESS_KEYWORDS = [
  "lead",
  "client",
  "customer",
  "prospect",
  "quote",
  "order",
  "sale",
  "crm",
  "packaging",
  "vendor",
  "supplier",
  "business",
  "company",
];

export interface AvailableToolSummary {
  name: string;
  description: string;
}

export interface BrainContext {
  request: string;
  conversationId: string;
  conversationHistory: MemoryEntry[];
  relevantMemories: MemoryEntry[];
  activeTasks: PlannedTask[];
  recentLeads: Array<{ id: string; status: string; companyId: string | null; updatedAt: Date }>;
  systemState: SystemStateRecord;
  availableTools: AvailableToolSummary[];
}

function looksBusinessRelated(request: string): boolean {
  const lower = request.toLowerCase();
  return BUSINESS_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Extracts simple keyword terms from the request for relevance filtering (deterministic, no embeddings). */
function extractKeywords(request: string): string[] {
  return Array.from(
    new Set(
      request
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    )
  ).slice(0, 8);
}

export async function buildBrainContext(
  request: string,
  conversationId = "default"
): Promise<BrainContext> {
  const [conversationHistoryRaw, allActiveTasks, systemState] = await Promise.all([
    Memory.search({ namespace: "CONVERSATION", query: conversationId, limit: CONVERSATION_HISTORY_LIMIT }),
    listTasks(),
    getSystemState(),
  ]);

  const keywords = extractKeywords(request);
  const relevantMemoriesRaw = await Promise.all(
    keywords.length > 0
      ? keywords.map((kw) => Memory.search({ query: kw, limit: RELEVANT_MEMORY_LIMIT }))
      : [Memory.search({ limit: RELEVANT_MEMORY_LIMIT })]
  );
  const relevantMemoryMap = new Map<string, MemoryEntry>();
  for (const batch of relevantMemoriesRaw) {
    for (const entry of batch) relevantMemoryMap.set(entry.id, entry);
  }
  const relevantMemories = Array.from(relevantMemoryMap.values())
    .sort((a, b) => b.importance - a.importance || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, RELEVANT_MEMORY_LIMIT);

  const activeTasks = allActiveTasks
    .filter((t) => !TERMINAL_TASK_STATUSES.has(t.status))
    .slice(0, ACTIVE_TASK_LIMIT);

  let recentLeads: BrainContext["recentLeads"] = [];
  if (looksBusinessRelated(request)) {
    const leads = await prisma.lead.findMany({
      orderBy: { updatedAt: "desc" },
      take: RECENT_LEADS_LIMIT,
    });
    recentLeads = leads.map((l) => ({
      id: l.id,
      status: l.status,
      companyId: l.companyId,
      updatedAt: l.updatedAt,
    }));
  }

  // "Available" here means "not administratively disabled". Whether a tool
  // is genuinely NOT_IMPLEMENTED/CONFIGURATION_REQUIRED is only knowable at
  // call time (that's the tool's own honest ToolResult.status) - the context
  // builder cannot pre-determine that without calling every tool speculatively,
  // so it lists every enabled tool and the Brain must handle a
  // NOT_IMPLEMENTED/CONFIGURATION_REQUIRED result from an actual call honestly.
  const allTools = toolRegistry.list();
  const disabledFlags = await Promise.all(allTools.map((t) => isToolDisabled(t.name)));
  const availableTools: AvailableToolSummary[] = allTools
    .filter((_, i) => !disabledFlags[i])
    .map((t) => ({ name: t.name, description: t.description }));

  return {
    request,
    conversationId,
    conversationHistory: conversationHistoryRaw,
    relevantMemories,
    activeTasks,
    recentLeads,
    systemState,
    availableTools,
  };
}

// Backward-compatible Phase 1 shape/API, kept for any existing caller.
export interface ContextWindow {
  conversationId: string;
  entries: MemoryEntry[];
}

export async function buildConversationContext(
  conversationId: string,
  limit = 10
): Promise<ContextWindow> {
  const entries = await Memory.search({ namespace: "CONVERSATION", query: conversationId, limit });
  return { conversationId, entries };
}
