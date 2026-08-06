import type { Prisma } from "@prisma/client";
import type { WorkEventKind } from "@/lib/work/domain";

/*
 * Reading a Work event payload — from either of the two executors that write one.
 *
 * `WorkEvent.payload` is JSONB and the vocabulary in domain.ts constrains only
 * the `kind` column beside it, never the bytes. Two executors fill those bytes
 * and they do not agree on a shape:
 *
 *   The cloud runner hands the runtime's own event object straight through —
 *   `void input.emit(event.kind, event as ...)` in scripts/work-runner.ts — so
 *   the runner's discriminated union arrives verbatim. A plan is
 *   `{ kind, plan: { version, steps } }`, a citation is `{ kind, citation }`, a
 *   question is `{ kind, question: { id, question, why, options } }`.
 *
 *   The Mac builds each payload by hand in DesktopWorkRunHost.swift and writes
 *   it flat: `["tool": …, "toolCallId": …, "isError": …]`. Same facts, no
 *   envelope, and occasionally a different key for the same thing.
 *
 * Every panel in this directory used to read the flat shape and only the flat
 * shape, and the cost was not cosmetic. A cloud run showed an empty Plan, an
 * empty Files-and-sources, no Documents — and, worst, no question card and no
 * approval card, because `deriveOpenQuestions` looked for `payload.questionId`
 * on an event whose id was one level down under `question`. A cloud run that
 * stopped to ask something could not be answered from the web at all; it simply
 * sat there, which is the spinner this whole surface exists to replace.
 *
 * So the fix is here rather than at thirty call sites: `readEvent` lifts the
 * known envelope for the kind that has one, and every reader below tries the
 * several names the same fact travels under. Nothing throws. An executor a
 * release ahead of this bundle is expected, and one unreadable event has to
 * cost one line of one panel, never the page.
 */

export type Payload = Record<string, unknown>;

/** A JSON value as a record, or an empty one. Arrays and scalars are not payloads. */
export function payloadOf(value: unknown): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

/**
 * The single sub-object the cloud runner wraps each kind's facts in.
 *
 * Deliberately one key per kind rather than a list. Lifting replaces — the
 * envelope's own fields win over the wrapper's — and that is only safe while
 * there is exactly one candidate, because `question_asked` carries both a
 * `question` object at the top and a `question` string inside it, and a merge
 * that let the outer one win would put `[object Object]` in front of the user.
 *
 * `run_finished` is absent on purpose. Its envelope is the whole `report` —
 * goal, plan, actions, citations, decisions, artifacts — and hoisting that into
 * one event's fields would have `derivePlan` rebuild the plan from a finished
 * run's summary of it, which is a second source for a fact the plan events
 * already state.
 */
const ENVELOPE: Partial<Record<WorkEventKind, string>> = {
  plan_created: "plan",
  plan_updated: "plan",
  question_asked: "question",
  approval_requested: "request",
  artifact_created: "artifact",
  artifact_updated: "artifact",
  source_cited: "citation",
  validation_result: "result",
  // Not a wrapper around the event so much as a wrapper around where the data
  // came from, but it is lifted for the same reason: `provenance.action` is the
  // identifier approvals are keyed on, and `provenance.source` is the only
  // non-path name a tool call has for what it touched.
  tool_started: "provenance",
  tool_finished: "provenance",
};

/** The event's facts, with the cloud runner's envelope flattened away. */
export function readEvent(event: { kind: WorkEventKind; payload: Prisma.JsonValue }): Payload {
  const payload = payloadOf(event.payload);
  const key = ENVELOPE[event.kind];
  if (key === undefined) return payload;
  const inner = payload[key];
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return payload;
  const { [key]: _lifted, ...rest } = payload;
  return { ...rest, ...(inner as Payload) };
}

/** The first key holding a non-blank string, or null. */
export function str(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** The first key holding a finite number, or null. */
export function num(payload: Payload, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The first key holding a real boolean, or null.
 *
 * Null rather than false, because "the executor said no" and "the executor did
 * not say" are different answers and `isError` is one of the fields they are
 * different about: a `tool_finished` from a build that predates the flag must
 * not be drawn with a failure mark.
 */
export function bool(payload: Payload, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

/** A count from either a number or the length of a list at that key. */
export function count(payload: Payload, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/** The first key holding an array, as a list of payloads. Non-objects dropped. */
export function records(payload: Payload, ...keys: string[]): Payload[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.flatMap((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? [entry as Payload]
          : []
      );
    }
  }
  return [];
}

/** The first key holding an array of strings. Non-strings dropped, not stringified. */
export function strings(payload: Payload, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

/** The sub-object at the first key that holds one, or an empty payload. */
export function nested(payload: Payload, ...keys: string[]): Payload {
  for (const key of keys) {
    const value = payload[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Payload;
    }
  }
  return {};
}

/**
 * A machine identifier as something to read: `email.search` → "Email search".
 *
 * Only ever a fallback. Where an executor wrote a sentence of its own —
 * `tool_started.summary` is exactly that — the sentence wins, because this can
 * only ever produce the name of a function and the user asked what Juno is
 * doing, not which symbol it called.
 */
export function humanize(identifier: string): string {
  const words = identifier.replace(/[._/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length === 0) return identifier;
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * The value at a key, when it is a string that is safe to print.
 *
 * "Safe" here means one thing: not a filesystem path. The rule this directory
 * follows is that a path in a screenshot is a path in a support ticket, so a
 * tool's free-form detail bag is never printed wholesale; a caller names the
 * keys whose author meant them as prose, and this refuses the ones that look
 * like a location anyway. Cheap and deliberately over-eager — a rejected
 * sentence costs one line of detail, a leaked path costs the design.
 */
export function prose(payload: Payload, ...keys: string[]): string | null {
  const value = str(payload, ...keys);
  if (value === null) return null;
  const looksLikePath = /(^|\s)(\/|~\/|[A-Za-z]:\\)/.test(value) || value.includes("/Users/");
  return looksLikePath ? null : value;
}
