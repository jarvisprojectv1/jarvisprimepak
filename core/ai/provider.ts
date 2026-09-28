// core/ai/provider.ts - AI provider abstraction.
//
// The orchestrator talks to `AIProvider`, never to a specific vendor SDK
// directly, so a different provider can be dropped in later without
// touching orchestration logic.
import Anthropic from "@anthropic-ai/sdk";
import { ConfigurationRequiredError, requireEnv } from "../../config/env";

export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AICompletionResult {
  ok: true;
  content: string;
  model: string;
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

export interface AIProvider {
  readonly name: string;
  complete(messages: AIMessage[]): Promise<AICompletionOutcome>;
}

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

/**
 * Anthropic-backed AIProvider. Never fabricates a response: if
 * ANTHROPIC_API_KEY is missing, `complete` returns a typed
 * CONFIGURATION_REQUIRED result instead of throwing or faking output.
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

  async complete(messages: AIMessage[]): Promise<AICompletionOutcome> {
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

    try {
      const response = await client.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: systemMessages.map((m) => m.content).join("\n\n") || undefined,
        messages: conversation.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return {
        ok: true,
        content: textBlock && "text" in textBlock ? textBlock.text : "",
        model: response.model,
      };
    } catch (err) {
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function createDefaultProvider(): AIProvider {
  return new AnthropicProvider();
}
