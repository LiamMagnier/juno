/**
 * "Move to crew": an assistant becomes a crew member (DECISIONS D-007).
 *
 * An assistant was a persona with a prompt, apps, a model and starter prompts.
 * A crew member is that plus a thread and standing work. The move copies what
 * carries over and invents nothing:
 *
 *   name              -> name (cut to the member limit)
 *   description       -> role, its first sentence
 *   system prompt     -> brief (cut to the member limit, and the cut is said)
 *   preferred model   -> model, when it is a chat model the plan includes
 *   reasoning effort  -> reasoning effort, when it is one
 *   enabled apps      -> apps, only the ones the account has linked
 *   first project     -> project, when the account still owns it
 *   starter prompts   -> ideas: suggestions the member offers, started only
 *                        when the person presses Start
 *
 * A moved member is not proactive: an assistant never reflected on its own,
 * and moving one must not start spending in the background.
 *
 * The assistant row is not deleted or rewritten. It is marked moved
 * (`WorkSkill.movedToAgentId`), stays readable by id for the apps that shipped
 * with Assistants, and leaves the lists. The member records where it came from
 * (`Agent.sourceAssistantId` and a `moved_from_assistant` event).
 *
 * The mapping is pure and tested in `tests/agents-move-from-assistant.test.ts`.
 */

import { createHash } from "node:crypto";
import {
  MAX_AGENT_INSTRUCTIONS_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_ROLE_CHARS,
  MAX_GOAL_TITLE_CHARS,
  agentModelChoice,
  agentReasoningEffort,
} from "@/lib/agents/domain";

/** The most starter prompts that become ideas. More than this is a list nobody reads. */
export const MAX_MOVED_IDEAS = 6;

export interface AssistantForMove {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  starterPrompts: readonly string[];
  enabledConnectors?: readonly string[];
  attachedProjectIds?: readonly string[];
  preferredModelId?: string;
  reasoningEffort?: string | null;
}

export interface MemberFromAssistant {
  name: string;
  role: string;
  instructions: string;
  instructionsCut: boolean;
  model: string | null;
  reasoningEffort: string | null;
  connectorIds: string[];
  projectId: string | null;
  ideas: Array<{ title: string; prompt: string }>;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipAtWord(value: string, max: number): string {
  const text = oneLine(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** The description's first sentence, as a one-line role. */
export function roleFromDescription(description: string): string {
  const text = oneLine(description);
  if (!text) return "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return clipAtWord(sentence.replace(/[.!?]+$/, ""), MAX_AGENT_ROLE_CHARS);
}

/** What the member is made from. Pure: the plan and the linked apps are checked by the caller. */
export function memberFromAssistant(assistant: AssistantForMove): MemberFromAssistant {
  const name = clipAtWord(assistant.name, MAX_AGENT_NAME_CHARS).replace(/…$/, "").trim() || "Moved assistant";
  const prompt = assistant.systemPrompt.trim();
  const cutNote = "\n\n(This brief was longer and was cut when it moved from Assistants.)";
  const instructionsCut = prompt.length > MAX_AGENT_INSTRUCTIONS_CHARS;
  const instructions = instructionsCut
    ? `${prompt.slice(0, MAX_AGENT_INSTRUCTIONS_CHARS - cutNote.length).trimEnd()}${cutNote}`
    : prompt;
  const model = assistant.preferredModelId ? agentModelChoice(assistant.preferredModelId) : null;
  const reasoningEffort = agentReasoningEffort(assistant.reasoningEffort ?? null);
  const connectorIds = [...new Set((assistant.enabledConnectors ?? []).map((id) => id.trim()).filter(Boolean))];
  const projectId = assistant.attachedProjectIds?.find((id) => typeof id === "string" && id.trim()) ?? null;
  const seen = new Set<string>();
  const ideas = assistant.starterPrompts
    .map((prompt) => prompt.trim())
    .filter((prompt) => {
      const key = oneLine(prompt).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_MOVED_IDEAS)
    .map((prompt) => ({ title: clipAtWord(prompt, MAX_GOAL_TITLE_CHARS), prompt: prompt.slice(0, 4_000) }));
  return { name, role: roleFromDescription(assistant.description), instructions, instructionsCut, model, reasoningEffort, connectorIds, projectId, ideas };
}

/**
 * A stable creation key for one assistant's move, as the UUID `createAgentSchema`
 * takes. Two presses of Move (or a retried request) land on the same member
 * through `createAgentTransaction`'s own idempotency, not on two.
 */
export function moveCreationKey(userId: string, assistantId: string): string {
  const hex = createHash("sha256").update(`juno-move-to-crew\0${userId}\0${assistantId}`).digest("hex");
  // RFC 4122 shape: version 5 nibble, variant 10xx.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
