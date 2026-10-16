/**
 * Stage: persistence — how an assistant turn is written.
 *
 * A normal turn appends a Message row. A regenerate PRESERVES the previous
 * answer instead of destroying it: the new answer is written as a new row, a
 * SIBLING of the old one (src/lib/chat/branches.ts), and the old answer stays
 * whole — its reasoning steps, activity, sources, receipt, artifacts and
 * everything the conversation went on to say after it — on a branch the
 * "‹ 2/3 ›" pager returns to. Before branches the row was overwritten in place
 * and only its text was kept, as a MessageVersion; those older versions are
 * adopted into the pager the first time their message branches.
 *
 * The Prisma calls stay in the route — this is the part of the decision that
 * can be stated without a database, and it is the part that was getting quietly
 * broken.
 */

import { settleToolCallRecord } from "@/lib/chat/run-record";
import { normalizeSources } from "@/lib/chat/source-registry";
import type { ChatFinishReason, ClientActivityEvent, ClientSource } from "@/types/chat";

/**
 * What to do with the `reasoningParts` column.
 *
 * Every write is a fresh row now — a regenerate adds a sibling rather than
 * overwriting — so a turn with no parts simply omits the column, and NULL
 * keeps meaning "this provider streamed unbroken prose". (When a regenerate
 * overwrote the row in place, an empty write had to CLEAR the column, or the
 * new answer showed the previous one's steps.)
 */
export type ReasoningPartsColumn =
  | { action: "set"; values: string[] }
  | { action: "omit" };

/**
 * Each part is encrypted individually, exactly like the flat `reasoning` text —
 * same key, same path. The array shape stays in plaintext because the count of
 * steps is not the secret; their contents are.
 */
export function reasoningPartsColumn(
  parts: readonly string[],
  encrypt: (value: string) => string,
): ReasoningPartsColumn {
  if (parts.length) return { action: "set", values: parts.map(encrypt) };
  return { action: "omit" };
}

/** A new row after the last one, or a new sibling of the answer being regenerated. */
export type AssistantWriteMode = "append" | "branch";

/**
 * Whether this turn adds an alternative to an answer or simply adds one.
 *
 * The answer being regenerated can vanish mid-generation — deleted with the
 * whole conversation from another tab — and when it does the turn appends
 * rather than failing. The user asked for an answer; losing the request
 * because the thing it was an alternative to is gone helps nobody.
 */
export function assistantWriteMode(
  staleAssistantId: string | null,
  staleRowExists: boolean
): AssistantWriteMode {
  return staleAssistantId && staleRowExists ? "branch" : "append";
}

export interface AssistantTurnFields {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * The prompt-cache split of `promptTokens`, as the provider reported it.
   *
   * EXPLICIT `null`, NEVER `undefined`, and that is the whole reason these are
   * normalised here rather than passed through. Prisma reads `undefined` as
   * "leave this column alone", which only an update can get wrong — and the
   * record is written whole either way, so an absent split is always stated
   * as unknown rather than left to whatever a column held before.
   *
   * `null` itself still means "unknown", never "zero" — no reader may coalesce.
   */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Exact generation cost (tokens + cache + tool fees), micro-USD. */
  costMicroUsd: number | null;
}

/** The columns common to both write modes, with the text already encrypted. */
export function assistantTurnFields(
  data: {
    content: string;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costMicroUsd?: number | null;
  },
  encrypt: (value: string) => string
): AssistantTurnFields {
  return {
    content: encrypt(data.content),
    model: data.model,
    promptTokens: data.promptTokens,
    completionTokens: data.completionTokens,
    cacheReadTokens: data.cacheReadTokens ?? null,
    cacheWriteTokens: data.cacheWriteTokens ?? null,
    costMicroUsd: data.costMicroUsd ?? null,
  };
}

/**
 * What a finished chat turn persists, before encryption (SPEC §12.4 WS4).
 *
 * The pure end of the turn pipeline: `TurnStream.finish()`'s answer and
 * activity plus what the accumulator gathered become the one assistant record
 * the route writes at the terminal state (INV-13), and the same record the
 * end-to-end tests read back through `serializeActivity` and `buildRunView`.
 */
export interface AssistantTurnRecordInput {
  /** `TurnStream.finish().answer`: the answer rounds plus every preserved block. */
  answer: string;
  /** `TurnStream.finish().activity`, in emission order. */
  activity: ClientActivityEvent[];
  reasoning: string;
  reasoningParts: readonly string[];
  sources: readonly ClientSource[];
  model: string;
  finishReason: ChatFinishReason;
}

export interface AssistantTurnRecord {
  content: string;
  reasoning: string | null;
  reasoningParts: string[];
  activity: ClientActivityEvent[];
  sources: ClientSource[];
  model: string;
  finishReason: ChatFinishReason;
}

/**
 * The row a persisted turn is, and must read back as.
 *
 * - `content` is the split answer (SPEC §2.8): every round's answer text plus
 *   every preserved block, so memory, artifacts and the wizard survive
 *   wherever the model wrote them (INV-12).
 * - `activity` gets the read-time rewrites of SPEC §2.5 at write time too: a
 *   persisted turn cannot still be running, so a call that never ended is
 *   `cancelled`, an approval that never settled `expired`, and a detail still
 *   `pending` is `unfinished`. The database then already says what a reload
 *   shows. The events are copied, never mutated: the live log is the route's.
 * - `sources` are normalised once more (INV-3), so a source that reached the
 *   list by any other path cannot make a native build refuse the message.
 */
export function assistantTurnRecord(input: AssistantTurnRecordInput): AssistantTurnRecord {
  const activity = input.activity.map((event): ClientActivityEvent => {
    const call = event.call ? settleToolCallRecord(event.call) : undefined;
    const pending = event.tool?.resultNote === "pending";
    if (call === event.call && !pending) return event;
    return {
      ...event,
      ...(call ? { call } : {}),
      ...(pending && event.tool ? { tool: { ...event.tool, resultNote: "unfinished" as const } } : {}),
    };
  });
  return {
    content: input.answer,
    reasoning: input.reasoning ? input.reasoning : null,
    reasoningParts: [...input.reasoningParts],
    activity,
    sources: normalizeSources(input.sources),
    model: input.model,
    finishReason: input.finishReason,
  };
}
