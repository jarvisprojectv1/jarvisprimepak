// core/orchestrator - accepts a user message, optionally invokes a tool,
// talks to the AI provider, and logs the exchange to memory + system_logs.
// This is the piece that makes "User can communicate with JARVIS" real.
import type { AIProvider, AIMessage } from "../ai/provider";
import { createDefaultProvider } from "../ai/provider";
import { toolRegistry, type ToolResult } from "../../tools/registry";
import { Memory } from "../memory";
import { log } from "../../security/logger";

export interface ChatRequest {
  message: string;
  /** Optional: explicitly invoke a registered tool instead of/alongside the AI provider. */
  toolCall?: { name: string; input?: Record<string, unknown> };
  /** Conversation id used as the memory key so history threads together. */
  conversationId?: string;
}

export interface ChatResponse {
  reply: string;
  toolResult?: ToolResult;
  configurationRequired?: boolean;
  model?: string;
}

const SYSTEM_PROMPT =
  "You are JARVIS, the autonomous AI operating system for Prime Pak Packages, " +
  "a packaging manufacturer. You are in Phase 1 (Foundation): be honest about " +
  "what is and is not implemented yet, and never claim to have done something " +
  "you cannot actually do.";

export class Orchestrator {
  constructor(private aiProvider: AIProvider = createDefaultProvider()) {}

  async handleChat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId ?? "default";

    await Memory.create({
      namespace: "CONVERSATION",
      key: `${conversationId}:user`,
      value: { role: "user", message: request.message, at: new Date().toISOString() },
      importance: 3,
    });

    let toolResult: ToolResult | undefined;
    if (request.toolCall) {
      toolResult = await toolRegistry.execute(
        request.toolCall.name,
        request.toolCall.input ?? {}
      );
    }

    const messages: AIMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(toolResult
        ? [
            {
              role: "system" as const,
              content: `Tool "${request.toolCall!.name}" returned: ${JSON.stringify(toolResult)}`,
            },
          ]
        : []),
      { role: "user", content: request.message },
    ];

    const completion = await this.aiProvider.complete(messages);

    log("ACTION", "orchestrator.chat", {
      conversationId,
      toolCalled: request.toolCall?.name,
      outcome: completion.ok ? "ok" : completion.code,
    });

    if (!completion.ok) {
      const reply =
        completion.code === "CONFIGURATION_REQUIRED"
          ? completion.message
          : `JARVIS hit a provider error: ${completion.message}`;

      await Memory.create({
        namespace: "CONVERSATION",
        key: `${conversationId}:assistant`,
        value: { role: "assistant", message: reply, at: new Date().toISOString() },
        importance: 3,
      });

      return {
        reply,
        toolResult,
        configurationRequired: completion.code === "CONFIGURATION_REQUIRED",
      };
    }

    await Memory.create({
      namespace: "CONVERSATION",
      key: `${conversationId}:assistant`,
      value: { role: "assistant", message: completion.content, at: new Date().toISOString() },
      importance: 3,
    });

    return { reply: completion.content, toolResult, model: completion.model };
  }
}

export const orchestrator = new Orchestrator();
