/**
 * Stage: what a connector call is allowed to show the person who made it.
 *
 * The thought-process panel names the tool a run reached for; this module
 * decides what of the CALL ITSELF may follow the name onto the wire — the
 * arguments the model composed, and the text the connector answered with.
 *
 * It is deliberately pure: no `server-only`, no Prisma, no request scope. Every
 * decision here is a policy decision (redact / cut / refuse), and a policy that
 * can only be exercised inside a running route is a policy nobody tests. The
 * route owns the SSE and the budget's lifetime; this module owns the rules.
 *
 * Three rules, in the order they bind:
 *
 *   1. REDACTION IS BORROWED, NEVER REWRITTEN. Arguments go through
 *      `actionPreviewDetail` — the same function that builds the approval
 *      card's `detail`. That is the point: the card and the panel are then
 *      structurally incapable of disagreeing about what an argument looks like,
 *      and this feature ships zero new redaction logic to get wrong.
 *
 *   2. RESULTS ARE CUT, NOT MASKED. A result is flat text from a connector, so
 *      key-based masking does not apply, and value-level secret-sniffing over
 *      arbitrary prose is theatre: it mangles legitimate content and buys
 *      confidence it has not earned. A result shown in the panel may therefore
 *      contain anything the connector returned. That is acceptable — it is the
 *      user's own data, returned to the user, on their own message — but it is
 *      only acceptable while it is SAID, which is why the panel carries a
 *      permanent caption to that effect.
 *
 *   3. EVERY ABSENCE IS EXPLAINED. There is no state in which a payload is
 *      simply missing. A `ClientToolDetail` without `args` always carries an
 *      `argsNote` naming which of the four reasons applies, and the same for
 *      `result`. Absence with no explanation is the panel lying by omission.
 */

import { actionPreviewDetail } from "@/lib/action-approval";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/untrusted-content";
import type { ClientToolDetail } from "@/types/chat";

/**
 * Redacted arguments, pretty-printed. 2,000 chars is ~60 rendered lines in the
 * panel's code block — already more than a reader scans without scrolling, and
 * arguments are a MODEL-authored payload whose size we do not control.
 */
export const MAX_TOOL_ARGS_CHARS = 2_000;

/**
 * Result head. The MODEL gets 30,000 (`truncateConnectorResult`). The READER
 * gets 4,000: two screens of code block, enough to see the shape of the answer
 * and its first records, and the same order as `redactPreviewValue`'s existing
 * 4,000-char string cap, so the two client projections agree with each other.
 * Sending the model's full 30,000 would be ~7x the payload for content nobody
 * reads past the first screen of.
 */
export const MAX_TOOL_RESULT_CHARS = 4_000;

/**
 * THE ONLY REAL BOUND. Per-call caps do not bound a run: 6 rounds x parallel
 * calls is realistically 30 calls, i.e. 180,000 chars at the per-call caps
 * alone. This budget is spent in call order; once exhausted every later row
 * carries `argsNote` / `resultNote` = `"over_budget"` and SAYS SO.
 *
 * 32,000 is chosen to sit alongside the 30,000 the model itself already reads
 * for ONE call — one run's visible tool detail should not exceed one tool
 * result's worth of text on the SSE stream or in the `Message.activity` column.
 *
 * This is not belt-and-braces on top of an existing guard: `enforceStreamBudget`
 * projects micro-USD from token counts, so nothing else on this stream measures
 * bytes at all. Tool detail is the first payload that can grow without one.
 */
export const MAX_TOOL_DETAIL_CHARS_PER_RUN = 32_000;

export const TOOL_ARGS_NOTES = ["unavailable", "empty", "unparsable", "over_budget"] as const;
export const TOOL_RESULT_NOTES = ["pending", "unfinished", "empty", "over_budget"] as const;

/** One generation's remaining allowance. Created by the route, spent in order. */
export interface ToolDetailBudget {
  remaining: number;
}

export function createToolDetailBudget(limit: number = MAX_TOOL_DETAIL_CHARS_PER_RUN): ToolDetailBudget {
  return { remaining: Math.max(0, limit) };
}

/**
 * Spend `text` against the run's allowance.
 *
 * A payload that does not fit does not get a partial cut — it exhausts the
 * budget outright, so every later row reports `over_budget` too. Squeezing a
 * later small payload in past a large one that was refused would make the
 * budget's effect depend on call size rather than call order, and "the run ran
 * out here" is a fact a reader can hold; "some of the middle is missing" is not.
 */
function charge(budget: ToolDetailBudget, text: string): boolean {
  if (text.length > budget.remaining) {
    budget.remaining = 0;
    return false;
  }
  budget.remaining -= text.length;
  return true;
}

/**
 * Drop the untrusted-content envelope.
 *
 * The markers are a model-context construct — they exist so the model can tell
 * connector text from an instruction — and they mean nothing to a reader.
 * `McpToolset.execute` already hands back an unwrapped `body`; this stays as a
 * cheap idempotent backstop so no future caller can leak the envelope into the
 * panel by passing the model-facing string instead.
 */
export function stripUntrustedEnvelope(text: string): string {
  if (!text.startsWith(UNTRUSTED_OPEN)) return text;
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1) return "";
  const body = text.slice(firstBreak + 1);
  if (!body.endsWith(UNTRUSTED_CLOSE)) return body;
  return body.slice(0, body.length - UNTRUSTED_CLOSE.length).replace(/\n$/, "");
}

/**
 * Pretty-print a result body, but only when the WHOLE body is JSON.
 *
 * Done here, on the server, and never on the client: the client only ever sees
 * a possibly-truncated head, and `JSON.parse` on a head fails on exactly the
 * large results where formatting would help most. The server holds the whole
 * string and is the only place the attempt is meaningful.
 */
function prettyJsonIfPossible(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    return typeof pretty === "string" ? pretty : body;
  } catch {
    return body;
  }
}

/**
 * `actionPreviewDetail` is typed for a `Record`, but the walker behind it
 * (`redactPreviewValue`) branches on array / object / string and handles any
 * JSON value. Providers send an object in practice; this keeps a hand-rolled
 * array or scalar from falling through to a wrong note rather than a real
 * rendering.
 */
function redactArguments(parsed: unknown): unknown {
  return actionPreviewDetail(parsed as Record<string, unknown>);
}

/** What an adapter knows when the model reaches for a tool. */
export interface ToolCallInput {
  server: string;
  name: string;
  /** Raw JSON text exactly as the provider sent it. Absent on Anthropic. */
  args?: string;
}

/** What an adapter knows when `execute` returns. */
export interface ToolResultInput {
  server: string;
  name: string;
  /** Present only when the adapter could not attach it to the call. */
  args?: string;
  /** The connector's output, envelope already stripped. */
  result: string;
  ok: boolean;
  durationMs?: number;
}

function applyArgs(detail: ClientToolDetail, raw: string | undefined, budget: ToolDetailBudget): void {
  if (raw === undefined) {
    detail.argsNote = "unavailable";
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    // Every adapter dispatches `{}` for empty argument text (`v.args ? JSON.parse(v.args) : {}`),
    // so "empty" describes what the connector was actually called with — not a guess.
    detail.argsNote = "empty";
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    detail.argsNote = "unparsable";
    return;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
    detail.argsNote = "empty";
    return;
  }

  const printed = JSON.stringify(redactArguments(parsed), null, 2);
  if (typeof printed !== "string" || !printed) {
    detail.argsNote = "unparsable";
    return;
  }

  const head = printed.length > MAX_TOOL_ARGS_CHARS ? printed.slice(0, MAX_TOOL_ARGS_CHARS) : printed;
  if (!charge(budget, head)) {
    detail.argsNote = "over_budget";
    return;
  }
  detail.args = head;
  if (head.length < printed.length) detail.argsTruncated = true;
}

/**
 * The row as it looks the instant the model reaches for the tool — before the
 * network round trip, which is the only moment at which "Using Linear" is news.
 *
 * `resultNote: "pending"` is what makes the live row honest: it has no result
 * yet and says which of the reasons that is.
 */
export function openToolDetail(call: ToolCallInput, budget: ToolDetailBudget): ClientToolDetail {
  const detail: ClientToolDetail = { server: call.server, name: call.name, resultNote: "pending" };
  applyArgs(detail, call.args, budget);
  return detail;
}

/**
 * The same row, completed. Replaces the opened detail wholesale.
 *
 * `open` is passed in rather than re-derived because ARGUMENTS RIDE ON
 * WHICHEVER ACT HAS THEM and that differs by provider: OpenAI has the complete
 * argument JSON at the call and Anthropic only at the result (its call event is
 * yielded from `content_block_start`, before `input_json_delta` has begun). The
 * opened row is therefore the authority on args whenever it managed to resolve
 * them — including when it resolved them to `over_budget`, which must not be
 * silently retried and charged twice.
 */
export function closeToolDetail(
  open: ClientToolDetail | undefined,
  res: ToolResultInput,
  budget: ToolDetailBudget
): ClientToolDetail {
  const detail: ClientToolDetail = { server: res.server, name: res.name };

  const openResolvedArgs = !!open && (open.args !== undefined || (!!open.argsNote && open.argsNote !== "unavailable"));
  if (openResolvedArgs && open) {
    if (open.args !== undefined) detail.args = open.args;
    if (open.argsNote) detail.argsNote = open.argsNote;
    if (open.argsTruncated) detail.argsTruncated = true;
  } else {
    applyArgs(detail, res.args, budget);
  }

  detail.status = res.ok ? "ok" : "failed";
  // Absent, never zero, for the calls that never reached the network. A zero
  // would read as "the connector answered instantly", which is the opposite of
  // what happened.
  if (typeof res.durationMs === "number" && Number.isFinite(res.durationMs)) detail.durationMs = res.durationMs;

  const body = stripUntrustedEnvelope(res.result);
  if (!body.trim()) {
    detail.resultNote = "empty";
    return detail;
  }

  const formatted = prettyJsonIfPossible(body);
  const head = formatted.length > MAX_TOOL_RESULT_CHARS ? formatted.slice(0, MAX_TOOL_RESULT_CHARS) : formatted;
  if (!charge(budget, head)) {
    detail.resultNote = "over_budget";
    return detail;
  }
  detail.result = head;
  if (head.length < formatted.length) {
    detail.resultTruncated = true;
    // Measured on the FORMATTED text, i.e. on the same string the head was cut
    // from, so "first 4000 of 26318" is a true statement about one text rather
    // than a ratio between two.
    detail.resultChars = formatted.length;
  }
  return detail;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Rebuild a persisted tool detail from the `Message.activity` JSON.
 *
 * As tolerant as `serializeActivity` itself, and for the same reason: a row
 * written by a LATER build must still load here. An unrecognised note degrades
 * that one field to `undefined` — never the whole event, and never a thrown
 * conversation load. A row written BEFORE this shipped has no `tool` at all and
 * returns `undefined`, which is what lets replay degrade to the old name-only
 * row with no version check anywhere.
 */
export function readToolDetail(raw: unknown): ClientToolDetail | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const server = typeof record.server === "string" ? record.server : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (!server || !name) return undefined;

  const detail: ClientToolDetail = { server, name };
  if (typeof record.args === "string") detail.args = record.args;
  const argsNote = readEnum(record.argsNote, TOOL_ARGS_NOTES);
  if (argsNote) detail.argsNote = argsNote;
  if (record.argsTruncated === true) detail.argsTruncated = true;

  if (typeof record.result === "string") detail.result = record.result;
  const resultNote = readEnum(record.resultNote, TOOL_RESULT_NOTES);
  // "pending" is a claim about the present tense, and it is only ever true
  // while a stream is open. A run stopped mid-call persists its row as it
  // stood, so anything read back from the database has a run that is over by
  // definition — telling someone that last Tuesday's call is "still running"
  // would be the panel lying with a field rather than with a number.
  if (resultNote) detail.resultNote = resultNote === "pending" ? "unfinished" : resultNote;
  if (record.resultTruncated === true) detail.resultTruncated = true;
  const resultChars = readCount(record.resultChars);
  if (resultChars !== undefined) detail.resultChars = resultChars;

  const status = readEnum(record.status, ["ok", "failed"] as const);
  if (status) detail.status = status;
  const durationMs = readCount(record.durationMs);
  if (durationMs !== undefined) detail.durationMs = durationMs;

  return detail;
}
