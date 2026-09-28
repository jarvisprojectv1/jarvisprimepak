// core/context - builds a lightweight conversational context window from
// recent memory. Phase 1 interface + a naive implementation (most-recent-N
// CONVERSATION memories); richer context assembly (summarization, relevance
// ranking across namespaces) is a later phase.
import { Memory, type MemoryEntry } from "../memory";

export interface ContextWindow {
  conversationId: string;
  entries: MemoryEntry[];
}

export async function buildConversationContext(
  conversationId: string,
  limit = 10
): Promise<ContextWindow> {
  const entries = await Memory.search({
    namespace: "CONVERSATION",
    query: conversationId,
    limit,
  });
  return { conversationId, entries };
}
