/**
 * What an earlier tool-using turn tells the model on the next one (SPEC §4.9,
 * DECISIONS T7): a short, capped note of what was called and what came back,
 * inside the untrusted envelope, ahead of the persisted answer.
 *
 * Each row's note is a function of that row only, so a new turn never changes
 * an earlier row's bytes and the cached prompt prefix holds (INV-24). WS0
 * lands the signature; WS4 implements it.
 */

import type { ClientActivityEvent } from "@/types/chat";

export interface HistoryRow {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  /** Decrypted and serialized (serializeActivity). */
  activity: ClientActivityEvent[] | undefined;
}

export const HISTORY_NOTE_MAX_CHARS_PER_TURN = 1_200;

/** Returns the assistant content to send to the model for each row (same order, same length). */
export function withHistoryNotes(_rows: readonly HistoryRow[]): string[] {
  throw new Error("not implemented: WS4");
}
