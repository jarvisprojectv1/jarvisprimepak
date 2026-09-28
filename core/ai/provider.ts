// core/ai/provider.ts - AI provider abstraction.
//
// The orchestrator/Brain talk to `AIProvider`, never to a specific vendor
// SDK directly, so a different provider can be dropped in later without
// touching orchestration logic. Phase 4 extends this with: a configurable
// request timeout, bounded retry with backoff on transient failures (429/5xx
// - never on 401/invalid-request), a structured response distinguishing
// plain text from a tool-call, native Anthropic tool-use support, and real
// token usage capture (never estimated/fabricated - see core/ai/usage.ts).
import Anthropic from "@anthropic-ai/sdk";
import { ConfigurationRequiredError, requireEnv, optionalEnv } from "../../config/env";
import { recordAiUsage } from "./usage";
import { log } from "../../security/logger";

export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** A tool definition passed to the model so it can choose to call one (Anthropic native tool-use). */
export interface AIToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** One requested tool call the model produced, alongside any text it also emitted. */
export interface AIToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AICompletionResult {
  ok: true;
  /** Plain text content, if the model responded with text (may be empty if it only requested a tool). */
  content: string;
  /** Populated when the model's response includes a tool_use block - the caller (the Brain) decides what to do with it. */
  toolUses: AIToolUse[];
  model: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

export interface AIConfigurationRequiredResult {
  ok: false;
  code: "CONFIGURATION_REQUIRED";
  message: string;
}

export interface AIProviderErrorResult {
  ok: false;
  code: "PROVIDER_ERROR";
  message: string;
}

export type AICompletionOutcome =
  | AICompletionResult
  | AIConfigurationRequiredResult
  | AIProviderErrorResult;

export interface CompleteOptions {
  /** Tool definitions the model may choose to call. Omit for a plain-text-only completion. */
  tools?: AIToolDefinition[];
  /** Request timeout in ms. Defaults to AI_REQUEST_TIMEOUT_MS env or 60000. */
  timeoutMs?: number;
  /** Max output tokens. Defaults to 1024 (4096 when tools are supplied, since structured plans need room). */
  maxTokens?: number;
  /** Attribution for AiUsage rows (does not affect the request itself). */
  taskId?: string | null;
  agentName?: string | null;
}

export interface AIProvider {
  readonly name: string;
  complete(messages: AIMessage[], options?: CompleteOptions): Promise<AICompletionOutcome>;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_TIMEOUT_MS = parseInt(optionalEnv("AI_REQUEST_TIMEOUT_MS", "60000"), 10);
const MAX_RETRIES = parseInt(optionalEnv("AI_MAX_RETRIES", "3"), 10);
const BASE_BACKOFF_MS = 500;

function isTransient(err: unknown): boolean {
  // Real Anthropic SDK error classes carry a `status` (HTTP code). Retry only
  // on 429 (rate limit) and 5xx (server-side) - never on 401/403/400/404,
  // which are permanent misconfigurations/invalid requests that a retry
  // cannot fix.
  const status = (err as { status?: number } | undefined)?.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Anthropic-backed AIProvider. Never fabricates a response: if
 * ANTHROPIC_API_KEY is missing, `complete` returns a typed
 * CONFIGURATION_REQUIRED result instead of throwing or faking output.
 *
 * Streaming: the Anthropic SDK supports `client.messages.stream(...)`, but
 * nothing built in this phase (the Brain needs a complete, parseable JSON
 * plan, not a token stream) consumes it. Rather than wire up an unused
 * feature, streaming is honestly left unimplemented here - see
 * docs/PHASE4_BRAIN_MEMORY.md.
 */
export class AnthropicProvider implements AIProvider {
  public readonly name = "anthropic";
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = requireEnv(
      "ANTHROPIC_API_KEY",
      "Set it in .env to enable the AI provider. See .env.example."
    );
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async complete(messages: AIMessage[], options: CompleteOptions = {}): Promise<AICompletionOutcome> {
    let client: Anthropic;
    try {
      client = this.getClient();
    } catch (err) {
      if (err instanceof ConfigurationRequiredError) {
        return { ok: false, code: "CONFIGURATION_REQUIRED", message: err.message };
      }
      throw err;
    }

    const systemMessages = messages.filter((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTokens = options.maxTokens ?? (options.tools?.length ? 4096 : 1024);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create(
          {
            model: DEFAULT_MODEL,
            max_tokens: maxTokens,
            system: systemMessages.map((m) => m.content).join("\n\n") || undefined,
            messages: conversation.map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content,
            })),
            tools: options.tools,
          },
          { timeout: timeoutMs }
        );

        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === "text"
        );
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        const inputTokens = response.usage?.input_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;

        const usageRecord = await recordAiUsage({
          provider: this.name,
          model: response.model,
          inputTokens,
          outputTokens,
          taskId: options.taskId,
          agentName: options.agentName,
        });

        return {
          ok: true,
          content: textBlocks.map((b) => b.text).join("\n"),
          toolUses: toolUseBlocks.map((b) => ({
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          })),
          model: response.model,
          usage: {
            inputTokens,
            outputTokens,
            estimatedCostUsd: usageRecord.estimatedCostUsd,
          },
        };
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isTransient(err)) {
          const backoff = BASE_BACKOFF_MS * 2 ** attempt;
          log("WARNING", "ai.provider_retry", {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            backoffMs: backoff,
            // Never log the raw error object (could include request bodies) -
            // only its message, which security/logger's log() redacts anyway.
            message: err instanceof Error ? err.message : String(err),
          });
          await delay(backoff);
          continue;
        }
        break;
      }
    }

    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
}

export function createDefaultProvider(): AIProvider {
  return new AnthropicProvider();
}
