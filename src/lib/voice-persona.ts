/*
 * WHO A VOICE CALL IS, in one of the person's agents' threads.
 *
 * A typed turn in an agent's thread answers as the agent — its name, brief,
 * goals and notes ride the system prompt (src/lib/agents/prompt.ts). A voice
 * call in the same thread answered as Juno, because the relay's instructions
 * were fixed: the thread was the agent's until someone pressed the microphone.
 *
 * HOW IT TRAVELS — the way memory does (src/lib/voice-memory.ts). The app
 * resolves the conversation to its agent, owner-scoped, and signs only the id
 * into the call's token; the relay asks for the persona server to server
 * (src/app/api/voice/persona/route.ts). The browser names the conversation it
 * is in, never the agent and never the words, so no page can make a call be
 * someone it is not. A retired agent is nobody: the call is Juno.
 *
 * SHAPED FOR SPEECH. The block is the chat's own, built without `start_task`
 * (a call has no tools), with its Markdown flattened, cut at a line under the
 * cap, and one line added that the cap never cuts: this is a call, and nothing
 * gets started from it.
 *
 * Pure — no Prisma — so every one of those rules is testable.
 */

import { cutAtLine, plain } from "@/lib/voice-memory";

/** Room the persona may take in a voice model's instructions, beside memory's own 3 500. */
export const VOICE_PERSONA_MAX_CHARS = 3_500;

/**
 * How many voice slots an id spreads over. Divisible by every list length the
 * relay vets (10 and 8 today), so no voice is likelier than another.
 */
export const VOICE_SLOT_COUNT = 240;

/** The line that says what a call cannot do, so the agent never offers it. */
function onTheCall(person: string): string {
  return `You are on a voice call with ${person} in your thread. You cannot start tasks or use tools from a call, so never say you have started or done something; when something needs real work, suggest ${person} asks for it in your thread after the call.`;
}

export function voicePersonaInstructions(block: string | null | undefined, userName?: string | null): string | null {
  const body = block?.trim() ? plain(block) : "";
  if (!body) return null;
  const call = onTheCall(userName?.trim() || "the person you work for");
  return `${cutAtLine(body, VOICE_PERSONA_MAX_CHARS - call.length - 2)}\n\n${call}`;
}

/**
 * Which of a provider's voices an agent speaks in, as a number the relay maps
 * to a name (relay/src/providers/registry.ts owns the names; only it knows the
 * provider). FNV-1a over the id, as the default face is seeded
 * (src/lib/agents/avatar.ts), so an agent keeps its voice across calls,
 * devices and provider switches without a column to store it in.
 */
export function agentVoiceSlot(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % VOICE_SLOT_COUNT;
}

/**
 * The conversation a relay token is minted for, read from the mint request.
 *
 * Only a cuid, or nothing: it is looked up owner-scoped before anything is
 * signed, but a shape check keeps garbage out of the query. Absent is the
 * default every older client and surface keeps — a call that is Juno.
 */
export function parseVoiceConversationRequest(params: URLSearchParams): string | null {
  const conversationId = params.get("conversationId")?.trim() || null;
  return conversationId && /^[a-z0-9]{20,40}$/i.test(conversationId) ? conversationId : null;
}
