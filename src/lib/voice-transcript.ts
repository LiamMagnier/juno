/**
 * The live voice transcript, as a pure reducer.
 *
 * WHY THIS IS ITS OWN MODULE. The reducer used to live inside a
 * `setTranscript` callback in `use-realtime-voice.ts`, where nothing could
 * test it — and it carried a bug that put every one of a caller's spoken
 * turns above every one of the model's replies. A four-turn conversation
 * rendered as U, U, A, A. That is the one ordering a conversation can never
 * have, and it was persisted: `/api/voice/transcript` stamps `createdAt` from
 * the array index, so a reload replayed the inversion faithfully.
 *
 * THE ORDERING PROBLEM, precisely. Input transcription resolves on its own
 * schedule and routinely lands AFTER the model has begun answering the turn it
 * belongs to. So a user line cannot simply be appended: at the moment it
 * arrives, the answer to it may already be on screen. The old code stepped
 * back over the trailing run of assistant lines to find its place — but with
 * no bound, so it stepped over completed exchanges too, and every later turn
 * was pushed further up.
 *
 * THE RULE THAT REPLACES IT. Order is carried, not inferred. Every line gets a
 * `turn` ordinal: a user line opens a turn, and assistant lines belong to the
 * turn that is open. A line is inserted at the end of its own turn, and never
 * crosses into an earlier one. Late transcription still lands in front of the
 * answer it preceded, because that answer shares its turn; a NEW user turn
 * appends, because its ordinal is higher than everything already there.
 *
 * The fallback still matters: some providers (OpenAI, Gemini) send no turn
 * identity at all on spoken lines, so the ordinal is derived here from the
 * shape of the conversation rather than trusted from the wire.
 */

import type { ClientAttachment } from "@/types/chat";

export interface RealtimeTranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  createdAt: string;
  attachments: ClientAttachment[];
  /**
   * Which exchange this line belongs to, counting from 1.
   *
   * A user line opens a turn; the assistant lines that answer it share its
   * number. This is what makes ordering a comparison rather than a heuristic,
   * and it is what `/api/voice/transcript` should stamp `createdAt` from.
   */
  turn: number;
}

/** Everything a transcript event carries, provider-independent. */
export interface TranscriptEvent {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  /** Present only on providers that transcribe client-side (MiniMax). */
  turnId?: string;
  attachments?: ClientAttachment[];
}

/** The mutable bits the reducer needs across calls, owned by the caller. */
export interface TranscriptCursor {
  /** Monotonic row id. */
  lineId: number;
  /** The turn currently being spoken or answered. */
  turn: number;
}

export function emptyCursor(): TranscriptCursor {
  return { lineId: 0, turn: 0 };
}

/**
 * The turn a new line belongs to.
 *
 * Three cases decide it, and the awkward one is the reason this is not simply
 * "a user line increments the counter":
 *
 *   CONTINUATION — the caller is still talking (the last row is a non-final
 *     user row), so the words join that turn.
 *   LATE TRANSCRIPTION — the open turn has no user row yet because the model
 *     started answering before the transcription resolved. The user's words
 *     belong to that turn, not to a new one; this is what puts them back in
 *     front of the answer instead of below it.
 *   A NEW EXCHANGE — anything else opens the next turn.
 *
 * The model's side mirrors it: a reply joins the open turn unless that turn
 * has already been answered in full, which means this is the answer to a turn
 * whose transcription has not landed yet.
 */
function turnFor(
  lines: readonly RealtimeTranscriptLine[],
  cursor: TranscriptCursor,
  role: "user" | "assistant"
): number {
  const open = cursor.turn;
  const inOpenTurn = (test: (line: RealtimeTranscriptLine) => boolean) =>
    lines.some((line) => line.turn === open && test(line));

  if (role === "user") {
    const last = lines[lines.length - 1];
    if (last && last.role === "user" && !last.final) return last.turn;
    // Late transcription for an answer that is STILL IN FLIGHT belongs to that
    // answer's turn. Once the answer is final the exchange is closed, and a
    // voice that speaks after it is opening a new one — which is also what
    // makes an unprompted greeting behave: the caller's first words come
    // after it, not above it.
    const answerInFlight = inOpenTurn((line) => line.role === "assistant" && !line.final);
    if (open > 0 && answerInFlight && !inOpenTurn((line) => line.role === "user")) return open;
    return open + 1;
  }

  // The model spoke with nothing open — a greeting. It opens its own turn so
  // the first real user turn appends after it rather than above it.
  if (open === 0) return 1;
  // The open turn already has a finished answer, so this is the reply to a
  // turn whose transcription is still in flight.
  if (inOpenTurn((line) => line.role === "assistant" && line.final)) return open + 1;
  return open;
}

/**
 * Where a line goes: at the end of its own turn.
 *
 * Scanning from the end and stopping at the first line whose turn is not
 * greater keeps the insert stable — among equals a line appends, so an
 * assistant continuation lands after the assistant lines already in its turn,
 * and a late user transcription lands in front of the answer that shares its
 * turn but after everything from earlier turns.
 */
function insertionIndex(lines: readonly RealtimeTranscriptLine[], turn: number, role: "user" | "assistant"): number {
  let at = lines.length;
  while (at > 0) {
    const prev = lines[at - 1];
    if (prev.turn < turn) break;
    // Inside its own turn a user line goes in front of the answer, and an
    // assistant line goes after everything already said in that turn.
    if (prev.turn === turn && (role === "assistant" || prev.role === "user")) break;
    at--;
  }
  return at;
}

/**
 * Fold one transcript event into the lines.
 *
 * Returns the same array reference when nothing changed, so a caller can skip
 * a re-render. `cursor` is mutated: it owns the row id and the open turn.
 */
export function applyTranscriptEvent(
  lines: readonly RealtimeTranscriptLine[],
  event: TranscriptEvent,
  cursor: TranscriptCursor
): RealtimeTranscriptLine[] {
  const { role, text, final, turnId } = event;
  const next = [...lines];

  // WHERE A PARTIAL GOES.
  //
  // First choice is the anchor: an empty, unsealed user row opened the moment
  // the caller started speaking (see `openUserTurn`). It is unambiguous —
  // an empty row exists only to receive text — so it wins even when the
  // model has already begun answering above it.
  //
  // Otherwise scan the tail for an unsealed row of the same voice, stopping at
  // the first sealed row. A sealed row closes what came before it, so a row
  // further up is finished, not pending; without that stop, a turn abandoned
  // mid-utterance would swallow the words of a turn spoken a minute later.
  let pendingIndex = -1;
  if (!turnId) {
    const anchor = next.findIndex(
      (line) => line.role === "user" && role === "user" && !line.final && !line.text && line.turn >= cursor.turn,
    );
    if (anchor >= 0) {
      pendingIndex = anchor;
    } else {
      for (let i = next.length - 1; i >= 0; i--) {
        const line = next[i];
        if (line.final) break;
        if (line.role === role) {
          pendingIndex = i;
          break;
        }
      }
    }
  }

  if (pendingIndex >= 0) {
    const pending = next[pendingIndex];
    // A final either replaces the accumulated partial (providers that send the
    // whole utterance again) or merely seals it (empty commit markers).
    next[pendingIndex] = {
      ...pending,
      text: final && text ? text : pending.text + (final ? "" : text),
      final,
    };
    return next;
  }

  // An empty final with nothing to seal is a commit marker for a row that was
  // never opened; there is nothing to record.
  if (!text && final) return next;

  const turn = turnFor(next, cursor, role);
  cursor.turn = Math.max(cursor.turn, turn);
  const line: RealtimeTranscriptLine = {
    id: ++cursor.lineId,
    role,
    text,
    final,
    createdAt: new Date().toISOString(),
    attachments: event.attachments ?? [],
    turn,
  };
  next.splice(insertionIndex(next, turn, role), 0, line);
  return next;
}

/**
 * The caller started speaking: open their turn now, before a word of it has
 * been transcribed.
 *
 * This is the anchor that makes ordering exact rather than inferred. Providers
 * resolve input transcription on their own schedule — often after the model has
 * already begun answering — so waiting for text to decide where a turn belongs
 * is guesswork. A voice-activity event, which every provider sends the instant
 * a caller speaks, is the real boundary; the empty row it plants is where the
 * words land whenever they arrive.
 *
 * Idempotent: a provider that fires speech-start twice, or fires it while the
 * caller is already mid-utterance, gets one row.
 */
export function openUserTurn(
  lines: readonly RealtimeTranscriptLine[],
  cursor: TranscriptCursor
): RealtimeTranscriptLine[] {
  const last = lines[lines.length - 1];
  if (last && last.role === "user" && !last.final) return lines as RealtimeTranscriptLine[];
  cursor.turn += 1;
  return [
    ...lines,
    {
      id: ++cursor.lineId,
      role: "user",
      text: "",
      final: false,
      createdAt: new Date().toISOString(),
      attachments: [],
      turn: cursor.turn,
    },
  ];
}

/**
 * Seal the open rows: drop empties and mark the rest final.
 *
 * Role-scoped so an interruption can close the model's line without claiming
 * the caller has finished speaking.
 */
export function sealTranscript(
  lines: readonly RealtimeTranscriptLine[],
  role?: "user" | "assistant"
): RealtimeTranscriptLine[] {
  return lines
    .filter((line) => line.final || line.text.trim())
    .map((line) => (!line.final && (!role || line.role === role) ? { ...line, final: true } : line));
}
