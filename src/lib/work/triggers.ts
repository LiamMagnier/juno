/**
 * Whether something that happened should start a Work run.
 *
 * The clock-driven half of triggering lives in `schedule.ts`; this is the other
 * half — an email arriving, a meeting approaching, a folder changing. The two
 * are separate modules because they answer different questions: a time trigger
 * is asked "when next", an event trigger is asked "does THIS count", and the
 * second one is where all the deduplication lives.
 *
 * Deduplication is the reason this file exists at all. Every producer Juno
 * listens to re-delivers: Gmail reports a thread again when a second message
 * lands on it, a calendar poller sees the same meeting on every tick of the
 * lead window, a folder watcher fires once per file in a copy of forty. Without
 * a stable key and a window, one thing happening once starts a run per
 * delivery — and each of those runs costs money, may send an email of its own,
 * and is indistinguishable to the user from Juno malfunctioning.
 *
 * Pure and free of Prisma, `server-only` and any network client, so the
 * matching rules can be exercised against the awkward cases directly.
 */

import {
  LOCAL_ONLY_TRIGGER_KINDS,
  selectTarget,
  type HostCapabilityView,
  type WorkTriggerKind,
} from "@/lib/work/domain";
import { canonicalize } from "@/lib/work/digests";
import {
  configForTimeTrigger,
  isTimeTriggerKind,
  parseTimeTrigger,
  type JsonObject,
} from "@/lib/work/schedule";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * The trigger kinds that fire on something happening rather than on a clock.
 *
 * The complement of `TIME_TRIGGER_KINDS` in `schedule.ts`, and a subset of
 * `WORK_TRIGGER_KINDS` rather than a second copy of it.
 */
export const EVENT_TRIGGER_KINDS = [
  "email_filter",
  "calendar_window",
  "topic_monitor",
  "connector_event",
  "folder_change",
  "manual",
] as const satisfies readonly WorkTriggerKind[];

export type EventTriggerKind = (typeof EVENT_TRIGGER_KINDS)[number];

const EVENT_KINDS = new Set<string>(EVENT_TRIGGER_KINDS);

export function isEventTriggerKind(value: string): value is EventTriggerKind {
  return EVENT_KINDS.has(value);
}

const LOCAL_ONLY = new Set<string>(LOCAL_ONLY_TRIGGER_KINDS);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmailFilterConfig {
  /** Any one of these matching the sender is enough. Substrings, so a bare
   *  domain like "@stripe.com" works without the user writing a regex. */
  from: string[];
  /** Senders that veto the match outright, checked before anything else. */
  excludeFrom: string[];
  /** ALL of these must appear in the subject. */
  subjectContains: string[];
  /** Any one of these appearing in the subject vetoes the match. */
  excludeSubjectContains: string[];
  /** ALL of these labels must be on the message. */
  labels: string[];
  requireAttachment: boolean;
}

export interface CalendarWindowConfig {
  /** How long before the meeting starts the trigger fires. */
  leadMinutes: number;
  /** Empty means every calendar the connector exposes. */
  calendarIds: string[];
  /** Any one of these appearing in the title is enough. Empty means any title. */
  titleContains: string[];
  minDurationMinutes: number;
  /** Skip the solo blocks people use as reminders to themselves. */
  requireAttendees: boolean;
}

export interface TopicMonitorConfig {
  terms: string[];
  /** True demands every term, false any of them. */
  requireAll: boolean;
  /** How many independent sources must have mentioned it. */
  minSources: number;
}

export interface ConnectorEventConfig {
  connector: string;
  /** Event names from that connector. Empty means every event it sends. */
  events: string[];
  /** Attribute values that must all match exactly. */
  attributes: Record<string, string>;
}

export interface FolderChangeConfig {
  /** The `WorkFileGrant` this watches. A trigger without one would be watching
   *  a path the user never granted. */
  grantId: string;
  /** Lower-case file suffixes, e.g. [".csv"]. Empty means any file. */
  suffixes: string[];
  minChangedFiles: number;
}

export type TriggerConfig =
  | { kind: "email_filter"; config: EmailFilterConfig }
  | { kind: "calendar_window"; config: CalendarWindowConfig }
  | { kind: "topic_monitor"; config: TopicMonitorConfig }
  | { kind: "connector_event"; config: ConnectorEventConfig }
  | { kind: "folder_change"; config: FolderChangeConfig }
  /** Manual has nothing to configure: it fires when a person presses Run now. */
  | { kind: "manual"; config: Record<string, never> };

export type TriggerConfigParse =
  | { ok: true; parsed: TriggerConfig }
  | { ok: false; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A list of non-empty lower-cased strings, or an empty list.
 *
 * Lower-casing at parse time rather than at match time means the comparison
 * below is a plain `includes` and cannot be got wrong once per call site. An
 * entry that is not a string is dropped rather than rejected: a producer
 * sending a stray null in a list should not disable the user's whole filter.
 */
function stringList(value: unknown, limit = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, limit)
    .map((entry) => entry.trim().toLowerCase());
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function flag(value: unknown): boolean {
  return value === true;
}

/**
 * Reads a stored `WorkTrigger.config` into a typed shape, or says why not.
 *
 * The only two configurations that can be rejected are the two that name
 * something: a connector event with no connector, and a folder watch with no
 * grant. Everything else degrades to "match anything of this kind", because a
 * filter with no criteria is a legitimate thing to ask for and refusing it
 * would mean a user cannot say "every email from this label".
 */
export function parseTriggerConfig(kind: string, config: unknown): TriggerConfigParse {
  if (!isEventTriggerKind(kind)) {
    return { ok: false, message: `${kind} does not fire on an event.` };
  }
  const body = record(config) ?? {};

  switch (kind) {
    case "email_filter":
      return {
        ok: true,
        parsed: {
          kind,
          config: {
            from: stringList(body.from),
            excludeFrom: stringList(body.excludeFrom),
            subjectContains: stringList(body.subjectContains),
            excludeSubjectContains: stringList(body.excludeSubjectContains),
            labels: stringList(body.labels),
            requireAttachment: flag(body.requireAttachment),
          },
        },
      };
    case "calendar_window":
      return {
        ok: true,
        parsed: {
          kind,
          config: {
            // Ten minutes is the default because it is long enough to read a
            // brief before a call and short enough that the brief is current.
            leadMinutes: Math.min(positiveInt(body.leadMinutes, 10), 24 * 60),
            calendarIds: stringList(body.calendarIds),
            titleContains: stringList(body.titleContains),
            minDurationMinutes: positiveInt(body.minDurationMinutes, 0),
            requireAttendees: flag(body.requireAttendees),
          },
        },
      };
    case "topic_monitor":
      return {
        ok: true,
        parsed: {
          kind,
          config: {
            terms: stringList(body.terms),
            requireAll: flag(body.requireAll),
            minSources: Math.max(1, positiveInt(body.minSources, 1)),
          },
        },
      };
    case "connector_event": {
      const connector = typeof body.connector === "string" ? body.connector.trim().toLowerCase() : "";
      if (!connector) {
        return { ok: false, message: "A connector-event trigger must name the connector it listens to." };
      }
      const rawAttributes = record(body.attributes) ?? {};
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawAttributes)) {
        if (typeof value === "string") attributes[key] = value;
      }
      return { ok: true, parsed: { kind, config: { connector, events: stringList(body.events), attributes } } };
    }
    case "folder_change": {
      const grantId = typeof body.grantId === "string" ? body.grantId.trim() : "";
      if (!grantId) {
        return {
          ok: false,
          message: "A folder trigger must name the folder grant it watches.",
        };
      }
      return {
        ok: true,
        parsed: {
          kind,
          config: {
            grantId,
            suffixes: stringList(body.suffixes),
            minChangedFiles: Math.max(1, positiveInt(body.minChangedFiles, 1)),
          },
        },
      };
    }
    case "manual":
      return { ok: true, parsed: { kind, config: {} } };
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface TriggerEventBase {
  /**
   * The producer's stable identifier for the thing that happened.
   *
   * Stable is the operative word: a Gmail thread id, a calendar event id, a
   * connector delivery id. A key derived from the moment of delivery would be
   * different on every re-delivery and would deduplicate nothing.
   */
  eventKey: string;
  occurredAt: Date;
}

export interface EmailTriggerEvent extends TriggerEventBase {
  kind: "email_filter";
  from: string;
  subject: string;
  labels: string[];
  hasAttachment: boolean;
}

export interface CalendarTriggerEvent extends TriggerEventBase {
  kind: "calendar_window";
  calendarId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  attendeeCount: number;
}

export interface TopicTriggerEvent extends TriggerEventBase {
  kind: "topic_monitor";
  /** The terms the monitor actually found, not the ones it looked for. */
  matchedTerms: string[];
  sourceCount: number;
}

export interface ConnectorTriggerEvent extends TriggerEventBase {
  kind: "connector_event";
  connector: string;
  event: string;
  attributes: Record<string, string>;
}

export interface FolderTriggerEvent extends TriggerEventBase {
  kind: "folder_change";
  grantId: string;
  /** Which Mac saw it. Checked against the account's hosts before firing. */
  hostId: string;
  /**
   * File names only — never a path.
   *
   * The same rule `serializeGrantForRemote` enforces: a trigger payload is
   * carried in an event a phone renders, and an absolute path in it is a path
   * in a screenshot and in the next prompt-injection payload.
   */
  changedNames: string[];
}

export type TriggerEvent =
  | EmailTriggerEvent
  | CalendarTriggerEvent
  | TopicTriggerEvent
  | ConnectorTriggerEvent
  | FolderTriggerEvent;

// ---------------------------------------------------------------------------
// Trigger state
// ---------------------------------------------------------------------------

/** The `WorkTrigger` columns evaluation reads. Structural, like `schedule.ts`. */
export interface TriggerState {
  id: string;
  kind: string;
  config: unknown;
  enabled: boolean;
  lastEventKey: string | null;
  lastFiredAt: Date | null;
  dedupeWindowSec: number;
}

export const TRIGGER_SKIP_REASONS = [
  "disabled",
  /** The event is not of the kind this trigger listens for. */
  "kind_mismatch",
  "config_invalid",
  "filter_unmatched",
  /** Already fired on this exact event, inside the dedupe window. */
  "duplicate_event",
  /** A calendar trigger evaluated outside its lead window. */
  "outside_window",
  /** A local-only trigger with no Mac that can serve it. */
  "host_offline",
  /** Manual triggers only fire when a person asks. */
  "manual_only",
] as const;

export type TriggerSkipReason = (typeof TRIGGER_SKIP_REASONS)[number];

export type TriggerVerdict =
  | {
      fire: true;
      eventKey: string;
      /** Repeats of this key before this instant are ignored. Written back to
       *  the row as `lastFiredAt` plus the window, and shown in the audit. */
      dedupeUntil: Date;
      explanation: string;
    }
  | { fire: false; reason: TriggerSkipReason; explanation: string };

export interface TriggerEvaluationInput {
  trigger: TriggerState;
  event: TriggerEvent;
  now: Date;
  /** The account's Work hosts. Required for the local-only kinds. */
  hosts?: readonly HostCapabilityView[];
  /**
   * Event keys this trigger has already fired on inside the current window.
   *
   * `WorkTrigger.lastEventKey` holds ONE key, which is enough for the case it
   * was designed for — the same thread re-delivered three times in a row — and
   * not enough for two threads interleaving: A, B, A leaves the column reading
   * B when the second A arrives, and the repeat is accepted. A caller that can
   * cheaply read the recent run keys should pass them, and this widens to the
   * whole window rather than the last delivery.
   */
  recentEventKeys?: readonly string[];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const value = haystack.toLowerCase();
  return needles.some((needle) => value.includes(needle));
}

function containsAll(haystack: string, needles: readonly string[]): boolean {
  const value = haystack.toLowerCase();
  return needles.every((needle) => value.includes(needle));
}

function hasAll(values: readonly string[], required: readonly string[]): boolean {
  const present = new Set(values.map((value) => value.toLowerCase()));
  return required.every((entry) => present.has(entry));
}

/**
 * The outcome of applying one trigger's filters to one event.
 *
 * A miss carries its own skip reason rather than one inferred later from the
 * sentence: `outside_window` and `filter_unmatched` need different responses
 * from the caller — one will match on a later tick, the other never will — and
 * deriving that from prose is how a correct filter gets rewritten by somebody
 * chasing a trigger that "does not match".
 */
type Match = { matched: true } | { matched: false; reason: TriggerSkipReason; because: string };

const MATCHED: Match = { matched: true };
const MISMATCH: Match = {
  matched: false,
  reason: "kind_mismatch",
  because: "the event is not of this trigger's kind",
};

function unmatched(because: string): Match {
  return { matched: false, reason: "filter_unmatched", because };
}

function matchEmail(config: EmailFilterConfig, event: EmailTriggerEvent): Match {
  if (config.excludeFrom.length > 0 && containsAny(event.from, config.excludeFrom)) {
    return unmatched("the sender is on this trigger's exclusion list");
  }
  if (config.from.length > 0 && !containsAny(event.from, config.from)) {
    return unmatched("the sender is not one this trigger watches");
  }
  if (config.excludeSubjectContains.length > 0 && containsAny(event.subject, config.excludeSubjectContains)) {
    return unmatched("the subject contains an excluded phrase");
  }
  if (config.subjectContains.length > 0 && !containsAll(event.subject, config.subjectContains)) {
    return unmatched("the subject does not contain every phrase this trigger requires");
  }
  if (config.labels.length > 0 && !hasAll(event.labels, config.labels)) {
    return unmatched("the message does not carry every label this trigger requires");
  }
  if (config.requireAttachment && !event.hasAttachment) {
    return unmatched("the message has no attachment");
  }
  return MATCHED;
}

function matchCalendar(config: CalendarWindowConfig, event: CalendarTriggerEvent, now: Date): Match {
  if (config.calendarIds.length > 0 && !config.calendarIds.includes(event.calendarId.toLowerCase())) {
    return unmatched("the meeting is not on a calendar this trigger watches");
  }
  if (config.titleContains.length > 0 && !containsAny(event.title, config.titleContains)) {
    return unmatched("the meeting title does not match");
  }
  if (config.requireAttendees && event.attendeeCount < 2) {
    return unmatched("the meeting has no other attendees");
  }
  const durationMinutes = (event.endsAt.getTime() - event.startsAt.getTime()) / 60_000;
  if (durationMinutes < config.minDurationMinutes) {
    return unmatched("the meeting is shorter than this trigger's minimum");
  }

  // Both ends of the lead window are checked, and a miss on either is
  // `outside_window` rather than a filter failure: the meeting is a match, this
  // is simply not the moment. A meeting that has already started is past being
  // prepared for — briefing a call the user is already in helps nobody.
  const untilStartMs = event.startsAt.getTime() - now.getTime();
  if (untilStartMs < 0) {
    return { matched: false, reason: "outside_window", because: "the meeting has already started" };
  }
  if (untilStartMs > config.leadMinutes * 60_000) {
    return {
      matched: false,
      reason: "outside_window",
      because: `the meeting is more than ${config.leadMinutes} minutes away`,
    };
  }
  return MATCHED;
}

function matchTopic(config: TopicMonitorConfig, event: TopicTriggerEvent): Match {
  const found = new Set(event.matchedTerms.map((term) => term.toLowerCase()));
  const hits = config.terms.filter((term) => found.has(term));
  if (config.terms.length > 0) {
    if (config.requireAll && hits.length !== config.terms.length) {
      return unmatched("not every term this trigger watches was found");
    }
    if (!config.requireAll && hits.length === 0) {
      return unmatched("none of the terms this trigger watches were found");
    }
  }
  if (event.sourceCount < config.minSources) {
    return unmatched(`only ${event.sourceCount} source mentioned it`);
  }
  return MATCHED;
}

function matchConnector(config: ConnectorEventConfig, event: ConnectorTriggerEvent): Match {
  if (event.connector.toLowerCase() !== config.connector) {
    return unmatched("the event came from a different connector");
  }
  if (config.events.length > 0 && !config.events.includes(event.event.toLowerCase())) {
    return unmatched("the connector sent a different kind of event");
  }
  for (const [key, value] of Object.entries(config.attributes)) {
    if (event.attributes[key] !== value) {
      return unmatched(`the event's ${key} is not the value this trigger watches`);
    }
  }
  return MATCHED;
}

function matchFolder(config: FolderChangeConfig, event: FolderTriggerEvent): Match {
  if (event.grantId !== config.grantId) {
    return unmatched("the change was in a different folder");
  }
  const relevant =
    config.suffixes.length === 0
      ? event.changedNames
      : event.changedNames.filter((name) =>
          config.suffixes.some((suffix) => name.toLowerCase().endsWith(suffix))
        );
  if (relevant.length < config.minChangedFiles) {
    return unmatched("fewer files changed than this trigger requires");
  }
  return MATCHED;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * How long a repeat of the same event key is ignored for.
 *
 * A calendar trigger's window is widened to at least its own lead time, which
 * is not a nicety. The lead window is open for `leadMinutes`, and a poller
 * looking at it every minute sees the same meeting every time; with the default
 * one-hour dedupe and a two-hour lead, the second hour of the window would
 * start a fresh run for a meeting already briefed.
 */
function dedupeWindowMs(trigger: TriggerState, parsed: TriggerConfig): number {
  const stored = Math.max(0, trigger.dedupeWindowSec) * 1000;
  if (parsed.kind !== "calendar_window") return stored;
  return Math.max(stored, parsed.config.leadMinutes * 60_000);
}

function isDuplicate(
  trigger: TriggerState,
  eventKey: string,
  now: Date,
  windowMs: number,
  recentEventKeys: readonly string[] | undefined
): boolean {
  if (windowMs <= 0) return false;
  if (recentEventKeys?.includes(eventKey)) return true;
  if (trigger.lastEventKey !== eventKey || !trigger.lastFiredAt) return false;
  return now.getTime() - trigger.lastFiredAt.getTime() < windowMs;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Decides whether one event fires one trigger.
 *
 * The order is chosen so that the reason a caller records is the most specific
 * true one. The host check comes before matching for the local-only kinds: a
 * folder change reported by a Mac that has since been revoked or switched off
 * must be refused as a host problem, not filtered as a content mismatch, or the
 * audit trail says the user's filter was too narrow when the truth is that
 * Juno was no longer allowed on that machine. Deduplication comes last, so an
 * event that never matched is not recorded as a duplicate of one that did.
 */
export function evaluateTrigger(input: TriggerEvaluationInput): TriggerVerdict {
  const { trigger, event, now } = input;

  if (!trigger.enabled) {
    return { fire: false, reason: "disabled", explanation: "This trigger is switched off." };
  }
  if (trigger.kind === "manual") {
    // Checked before the kind comparison below, and not folded into it: there
    // is no manual event, so a manual trigger would otherwise be reported as
    // mismatching whatever happened to arrive, which reads as a configuration
    // error rather than as the deliberate "only a person starts this".
    return {
      fire: false,
      reason: "manual_only",
      explanation: "A manual trigger only fires when someone runs the schedule.",
    };
  }
  if (trigger.kind !== event.kind) {
    return {
      fire: false,
      reason: "kind_mismatch",
      explanation: `This trigger listens for ${trigger.kind} events, not ${event.kind}.`,
    };
  }

  const parse = parseTriggerConfig(trigger.kind, trigger.config);
  if (!parse.ok) {
    return { fire: false, reason: "config_invalid", explanation: parse.message };
  }
  const parsed = parse.parsed;

  if (LOCAL_ONLY.has(trigger.kind)) {
    const hostId = event.kind === "folder_change" ? event.hostId : null;
    // Scoped to the one host that reported the change, and answered by
    // `selectTarget` rather than by a second copy of "is this Mac usable" —
    // its sentence is the one the rest of Work already shows for an absent Mac.
    const candidates = (input.hosts ?? []).filter((host) => host.hostId === hostId);
    const selection = selectTarget({
      requested: "local",
      required: ["local_files"],
      hosts: candidates,
      cloudAvailable: false,
    });
    if (selection.target !== "local") {
      return { fire: false, reason: "host_offline", explanation: selection.explanation };
    }
  }

  const match = matchFor(parsed, event, now);
  if (!match.matched) {
    return { fire: false, reason: match.reason, explanation: `Not started, because ${match.because}.` };
  }

  const windowMs = dedupeWindowMs(trigger, parsed);
  if (isDuplicate(trigger, event.eventKey, now, windowMs, input.recentEventKeys)) {
    return {
      fire: false,
      reason: "duplicate_event",
      explanation: "This is the same event the trigger has already started a run for.",
    };
  }

  return {
    fire: true,
    eventKey: event.eventKey,
    dedupeUntil: new Date(now.getTime() + windowMs),
    explanation: "Started by this trigger.",
  };
}

/**
 * Routes an event to its kind's matcher.
 *
 * Both discriminants are already known to agree — `evaluateTrigger` compared
 * them — but the compiler cannot carry that across two separate unions, so the
 * pairing is re-established here in one place rather than cast at five.
 */
function matchFor(parsed: TriggerConfig, event: TriggerEvent, now: Date): Match {
  switch (parsed.kind) {
    case "email_filter":
      return event.kind === "email_filter" ? matchEmail(parsed.config, event) : MISMATCH;
    case "calendar_window":
      return event.kind === "calendar_window" ? matchCalendar(parsed.config, event, now) : MISMATCH;
    case "topic_monitor":
      return event.kind === "topic_monitor" ? matchTopic(parsed.config, event) : MISMATCH;
    case "connector_event":
      return event.kind === "connector_event" ? matchConnector(parsed.config, event) : MISMATCH;
    case "folder_change":
      return event.kind === "folder_change" ? matchFolder(parsed.config, event) : MISMATCH;
    case "manual":
      return MISMATCH;
  }
}

/**
 * The idempotency key a triggered run is created with.
 *
 * Bucketed by the dedupe window rather than by the wall clock, which makes the
 * key do the same job the window does and gives the database the final say:
 * two dispatchers racing on one delivery mint the same key and collide on
 * `(userId, idempotencyKey)`, so one run exists. A legitimate re-fire is by
 * definition at least a whole window after the last one, so its bucket index is
 * always different and it is never mistaken for the first.
 */
export function triggerRunIdempotencyKey(
  triggerId: string,
  eventKey: string,
  firedAt: Date,
  dedupeWindowSec: number
): string {
  const windowMs = Math.max(0, dedupeWindowSec) * 1000;
  const bucket = windowMs > 0 ? Math.floor(firedAt.getTime() / windowMs) : firedAt.getTime();
  return `wtrg:${triggerId}:${eventKey}:${bucket}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Renders a parsed configuration back into the shape `WorkTrigger.config` holds.
 *
 * The counterpart of `configForTimeTrigger`, and it exists for the same reason:
 * the routes store what the parser produced rather than the body the client
 * sent, so what is in the column is exactly what `evaluateTrigger` will read
 * back. Storing the raw body means a filter with an unreadable `from` is
 * accepted at write time and silently matches nothing at fire time, which
 * surfaces as a trigger the user configured and which never fires.
 */
export function configForEventTrigger(parsed: TriggerConfig): JsonObject {
  switch (parsed.kind) {
    case "email_filter":
      return {
        from: [...parsed.config.from],
        excludeFrom: [...parsed.config.excludeFrom],
        subjectContains: [...parsed.config.subjectContains],
        excludeSubjectContains: [...parsed.config.excludeSubjectContains],
        labels: [...parsed.config.labels],
        requireAttachment: parsed.config.requireAttachment,
      };
    case "calendar_window":
      return {
        leadMinutes: parsed.config.leadMinutes,
        calendarIds: [...parsed.config.calendarIds],
        titleContains: [...parsed.config.titleContains],
        minDurationMinutes: parsed.config.minDurationMinutes,
        requireAttendees: parsed.config.requireAttendees,
      };
    case "topic_monitor":
      return {
        terms: [...parsed.config.terms],
        requireAll: parsed.config.requireAll,
        minSources: parsed.config.minSources,
      };
    case "connector_event":
      return {
        connector: parsed.config.connector,
        events: [...parsed.config.events],
        attributes: { ...parsed.config.attributes },
      };
    case "folder_change":
      return {
        grantId: parsed.config.grantId,
        suffixes: [...parsed.config.suffixes],
        minChangedFiles: parsed.config.minChangedFiles,
      };
    case "manual":
      return {};
  }
}

/** `WorkTrigger.dedupeWindowSec`'s column default, repeated here because a
 *  draft has to carry a value and the row's default only applies to an insert
 *  that omits the column entirely. */
export const DEFAULT_DEDUPE_WINDOW_SEC = 3600;

/** One trigger row, ready to be written. */
export interface TriggerDraft {
  kind: WorkTriggerKind;
  config: JsonObject;
  enabled: boolean;
  dedupeWindowSec: number;
}

/**
 * The trigger fields a client submits.
 *
 * Structural, so the zod schema in `schedule.ts`, a stored row being
 * re-validated after a timezone change, and the tests can all satisfy it.
 * `kind` is a plain string for that last reason: a row written by a newer
 * deployment holds a kind this build does not know, and the two parsers below
 * already refuse one with a message worth showing.
 */
export interface TriggerDraftInput {
  kind: string;
  config: unknown;
  enabled?: boolean;
  dedupeWindowSec?: number;
}

export type TriggerDraftsResult =
  | { ok: true; drafts: TriggerDraft[] }
  /** Which trigger was wrong and what to tell whoever is editing it. */
  | { ok: false; index: number; message: string };

/**
 * Validates a submitted trigger set and renders it into rows.
 *
 * Both halves of the vocabulary meet here — the clock kinds go through
 * `parseTimeTrigger` and the rest through `parseTriggerConfig` — because a
 * `WorkTrigger` row can be either and a route should not have to know which
 * parser to reach for. It lives on this side of the pair so the dependency runs
 * one way: this module knows about `schedule.ts`, and `schedule.ts` knows
 * nothing about this one.
 *
 * What comes back is what gets stored: the normalised configuration, not the
 * body the client sent. Storing the body means a `{ hour: "9" }` is accepted at
 * write time and refused at fire time, which the user experiences as a schedule
 * that was created without complaint and then never ran.
 */
export function normalizeTriggerDrafts(
  inputs: readonly TriggerDraftInput[],
  timezone: string
): TriggerDraftsResult {
  const drafts: TriggerDraft[] = [];

  for (const [index, input] of inputs.entries()) {
    const enabled = input.enabled ?? true;
    // Zero is a legitimate window — "never suppress a repeat" — so it must
    // survive the `??`, which is why this is not `|| DEFAULT`.
    const dedupeWindowSec = input.dedupeWindowSec ?? DEFAULT_DEDUPE_WINDOW_SEC;

    if (isTimeTriggerKind(input.kind)) {
      const parsed = parseTimeTrigger(input.kind, input.config, timezone);
      if (!parsed.ok) return { ok: false, index, message: parsed.message };
      drafts.push({
        kind: input.kind,
        config: configForTimeTrigger(parsed.spec),
        enabled,
        dedupeWindowSec,
      });
      continue;
    }

    const parsed = parseTriggerConfig(input.kind, input.config);
    if (!parsed.ok) return { ok: false, index, message: parsed.message };
    drafts.push({
      // The parser's narrowed kind, not the caller's string: they are the same
      // value, and taking it from the parser is what carries the proof.
      kind: parsed.parsed.kind,
      config: configForEventTrigger(parsed.parsed),
      enabled,
      dedupeWindowSec,
    });
  }

  return { ok: true, drafts };
}

/**
 * Whether a submitted trigger set is the one already stored.
 *
 * The question a PATCH has to answer before it decides whether to move the
 * schedule's next fire. A client that re-sends the whole schedule on every save
 * — which is what every form in this codebase does — would otherwise mark the
 * triggers as changed each time the user renamed it, and each of those would
 * discard an overdue run.
 *
 * Compared on the canonical encoding rather than on `JSON.stringify`, so two
 * configurations that differ only in key order are recognised as the same one.
 * Order within the set matters: the rows are re-created from the submitted list,
 * so a reordering is a real change to what will be stored.
 */
export function sameTriggerSet(
  stored: readonly { kind: string; config: unknown; enabled: boolean; dedupeWindowSec: number }[],
  drafts: readonly TriggerDraft[]
): boolean {
  if (stored.length !== drafts.length) return false;
  return stored.every((row, index) => {
    const draft = drafts[index];
    return (
      row.kind === draft.kind &&
      row.enabled === draft.enabled &&
      row.dedupeWindowSec === draft.dedupeWindowSec &&
      canonicalize(row.config) === canonicalize(draft.config)
    );
  });
}
