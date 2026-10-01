/**
 * The wire shapes of rooms (`/api/agents/rooms/**`). Client-safe: types only.
 */

import type { ClientAgent } from "@/lib/agents/types";

export interface ClientRoom {
  /** A room is a conversation; its id is the conversation's. */
  conversationId: string;
  title: string;
  members: ClientAgent[];
  lastMessageAt: string;
  createdAt: string;
}

/** One agent turn in the room, as the transcript needs it to name the speaker. */
export interface ClientRoomTurn {
  id: string;
  userMessageId: string;
  agentId: string;
  fromAgentId: string | null;
  reason: "addressed" | "routed" | "asked";
  /** Only for an asked turn: "Mira asked Scout to check the pricing". */
  handoffSentence: string | null;
  status: "pending" | "running" | "answered" | "failed" | "skipped";
  messageId: string | null;
}

export interface ClientRoomDetail {
  room: ClientRoom;
  /** The turns of the last few messages, oldest first. */
  turns: ClientRoomTurn[];
  /** The agent that should answer next, when a turn is waiting; the web client runs it. */
  next: { agentId: string; userMessageId: string } | null;
}
