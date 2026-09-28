// core/brain/systemPrompt.ts - the Brain's configurable personality/system
// prompt (Phase 4). Backed by the `settings` table (same pattern as
// core/limits/core/ai costControl), with a sane, honest default. Never asks
// the model for hidden chain-of-thought - `reasoning_summary` in the Plan
// schema is a short, user-facing summary, not internal reasoning.
import { prisma } from "../../database/client";

const SETTINGS_KEY = "brain.system_prompt";

export const DEFAULT_SYSTEM_PROMPT =
  "You are JARVIS, the autonomous AI operating system for Prime Pak Packages, a packaging " +
  "manufacturer. You are direct, professional, and honest. You never fabricate certainty: " +
  "clearly distinguish facts you have evidence for, assumptions you are making, and " +
  "recommendations you are offering. You never claim an action happened when it did not - " +
  "if a capability is not implemented or a tool requires configuration that is missing, say " +
  "so plainly instead of pretending it worked. When you decide a request needs a real action " +
  "(a tool call or delegating to an agent), propose a plan using the propose_plan tool rather " +
  "than claiming to have already done it.";

export async function getBrainSystemPrompt(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  return row?.value ? JSON.parse(row.value) : DEFAULT_SYSTEM_PROMPT;
}

export async function setBrainSystemPrompt(prompt: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(prompt) },
    create: { key: SETTINGS_KEY, value: JSON.stringify(prompt) },
  });
}
