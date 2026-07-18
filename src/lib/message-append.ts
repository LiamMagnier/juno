import { z } from "zod";
import { MAX_EDIT_MESSAGE_CHARS } from "@/lib/prompt-limits";

/*
 * Request contract for the native transcript push
 * (POST /api/conversations/[id]/messages) — shapes only, no server imports
 * beyond prompt-limits (pure constants), so the hermetic test suite can
 * exercise the contract without a database.
 *
 * Each turn carries a client-generated `clientId`; persistence is idempotent
 * on (conversationId, clientId), so a retried batch reuses the rows the first
 * attempt created. Server-assigned Message ids stay cuid-generated and can
 * therefore never collide with the deterministic `codetask_<taskId>` ids the
 * Juno Code outcome path writes.
 */

export const MAX_APPEND_TURNS = 100;

/** @deprecated use MAX_EDIT_MESSAGE_CHARS — kept as alias for native clients. */
export const MAX_APPEND_CONTENT_CHARS = MAX_EDIT_MESSAGE_CHARS;

export const appendTurnSchema = z.object({
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  role: z.enum(["USER", "ASSISTANT"]),
  content: z.string().min(1).max(MAX_APPEND_CONTENT_CHARS),
  createdAt: z.string().datetime({ offset: true }).optional(),
  model: z.string().min(1).max(200).optional(),
  promptTokens: z.number().int().min(0).optional(),
  completionTokens: z.number().int().min(0).optional(),
}).strict();

export const appendRequestSchema = z.object({
  turns: z.array(appendTurnSchema).min(1).max(MAX_APPEND_TURNS),
}).strict().superRefine((body, ctx) => {
  const seen = new Set<string>();
  for (const [index, turn] of body.turns.entries()) {
    if (seen.has(turn.clientId)) {
      ctx.addIssue({ code: "custom", path: ["turns", index, "clientId"], message: "Duplicate clientId in batch." });
    }
    seen.add(turn.clientId);
    // Model/token metadata describes a generation — user turns have none.
    if (turn.role === "USER" && (turn.model !== undefined || turn.promptTokens !== undefined || turn.completionTokens !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["turns", index, "role"], message: "USER turns cannot carry model or token metadata." });
    }
  }
});

export type AppendTurn = z.infer<typeof appendTurnSchema>;

/**
 * Timestamp for a turn: the client's own clock wins (finalized turns are
 * pushed after the fact) but never runs ahead of the server, and turns
 * without a timestamp backfill a compact monotonic range ending at `now` so
 * request order survives same-millisecond writes (same trick as the voice
 * transcript save).
 */
export function appendTurnCreatedAt(turn: AppendTurn, index: number, total: number, now: number): Date {
  if (turn.createdAt) {
    const requested = Date.parse(turn.createdAt);
    return new Date(Math.min(requested, now));
  }
  return new Date(now - total + index + 1);
}
