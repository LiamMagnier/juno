/**
 * Rooms in the web client: who wrote each reply, who is answering now, and
 * whether a follow-up turn should be dispatched. Pure and client-safe, so
 * `tests/agents-room-client.test.ts` covers the dispatch bound and reload.
 *
 * The server owns the plan (src/lib/agents/room-store.ts). The client only
 * runs `ClientRoomDetail.next` one turn at a time, and never more than
 * `ROOM_MAX_TURNS_PER_MESSAGE` times for one message of the person's, however
 * often the detail is reloaded. The server refuses anything else anyway (a
 * second tab racing the same turn gets a 409); this bound is what stops one
 * tab asking.
 */

import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientRoomDetail, ClientRoomTurn } from "@/lib/agents/room-types";

export const ROOM_CLIENT_MAX_DISPATCHES_PER_MESSAGE = 3;

export interface RoomSpeaker {
  agentId: string;
  name: string;
  avatar: AgentAvatar;
  state: AgentState;
  /** "Mira asked Scout to check the pricing", above an asked member's reply. */
  handoff: string | null;
}

function speakerFor(detail: ClientRoomDetail, turn: ClientRoomTurn): RoomSpeaker | null {
  const member = detail.room.members.find((agent) => agent.id === turn.agentId);
  if (!member) return null;
  return {
    agentId: member.id,
    name: member.name,
    avatar: member.avatar,
    state: member.state,
    handoff: turn.handoffSentence,
  };
}

/** Every answered reply's speaker, keyed by the assistant message id. */
export function roomSpeakersByMessage(detail: ClientRoomDetail | null): Map<string, RoomSpeaker> {
  const map = new Map<string, RoomSpeaker>();
  if (!detail) return map;
  for (const turn of detail.turns) {
    if (!turn.messageId) continue;
    const speaker = speakerFor(detail, turn);
    if (speaker) map.set(turn.messageId, speaker);
  }
  return map;
}

/**
 * Who is answering right now: the running turn of the newest message, or the
 * member this tab just dispatched (the detail may not have caught up yet).
 */
export function liveRoomSpeaker(detail: ClientRoomDetail | null, dispatchedAgentId: string | null): RoomSpeaker | null {
  if (!detail) return null;
  if (dispatchedAgentId) {
    const turn = [...detail.turns].reverse().find((t) => t.agentId === dispatchedAgentId && t.status !== "answered");
    const member = detail.room.members.find((agent) => agent.id === dispatchedAgentId);
    if (member) {
      return { agentId: member.id, name: member.name, avatar: member.avatar, state: "working", handoff: turn?.handoffSentence ?? null };
    }
  }
  const lastUserMessageId = detail.turns.at(-1)?.userMessageId;
  const running = detail.turns.find((t) => t.userMessageId === lastUserMessageId && t.status === "running");
  const speaker = running ? speakerFor(detail, running) : null;
  return speaker ? { ...speaker, state: "working" } : null;
}

/** The key one dispatch is remembered by, so a reload never asks twice. */
export function roomDispatchKey(next: { agentId: string; userMessageId: string }): string {
  return `${next.userMessageId}:${next.agentId}`;
}

/**
 * The follow-up turn to dispatch now, or null.
 *
 * Null while the chat is busy (one agent at a time), when the server says
 * nothing is next, when this tab already dispatched exactly this turn, and
 * once this tab has dispatched the per-message bound for that message.
 */
export function roomTurnToDispatch(input: {
  detail: ClientRoomDetail | null;
  busy: boolean;
  dispatched: ReadonlySet<string>;
}): { agentId: string; userMessageId: string; key: string } | null {
  const next = input.detail?.next;
  if (!next || input.busy) return null;
  const key = roomDispatchKey(next);
  if (input.dispatched.has(key)) return null;
  let forMessage = 0;
  for (const done of input.dispatched) if (done.startsWith(`${next.userMessageId}:`)) forMessage += 1;
  if (forMessage >= ROOM_CLIENT_MAX_DISPATCHES_PER_MESSAGE) return null;
  return { ...next, key };
}

/** "Mira, Scout and Quill" for the room's header line. */
export function roomMembersLine(detail: ClientRoomDetail | null): string {
  const names = detail?.room.members.map((member) => member.name.trim()).filter(Boolean) ?? [];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
