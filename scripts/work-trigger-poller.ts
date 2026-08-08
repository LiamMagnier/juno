/**
 * The Work event-trigger poller.
 *
 * The other half of `scripts/work-scheduler.ts`. That process asks "what is
 * due"; this one asks "has anything happened", reads the source a trigger
 * watches, and hands each thing it finds to `evaluateTrigger`. Run it the way
 * the other workers are run:
 *
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/work-trigger-poller.ts
 *
 * It dispatches; it does not execute. A trigger firing produces a queued
 * `WorkRun` that `scripts/work-runner.ts` (cloud) or the paired Mac (local)
 * claims through its own lease — the same separation, for the same reason: a
 * tick here finishes in the time one IMAP round-trip takes, no matter how long
 * the work it starts runs for.
 *
 * It is a separate process from the scheduler rather than a second sweep inside
 * it, and that is the load-bearing decision. A poll is a network call to
 * somebody's iCloud account and can take thirty seconds or hang; the scheduler's
 * tick is fifteen seconds of indexed queries. Folding this in would mean every
 * clock-driven schedule in the deployment waiting behind one slow mailbox. The
 * two also lease different columns for the same reason — `pollLockedUntil` here,
 * `WorkSchedule.lockedUntil` there — so neither worker can stall the other.
 *
 * FOUR PROPERTIES, EACH ONE A WAY THIS GOES WRONG WITHOUT IT
 *
 *   It remembers where it read to. `WorkTrigger.cursor` holds a high-water mark
 *   per source, and the FIRST poll of a source records that mark and fires
 *   nothing. Without it, every restart — and every trigger created this morning
 *   — sees twenty-five messages it has never seen before and starts twenty-five
 *   runs for mail the user read last week.
 *
 *   It consumes an event only once it has been dealt with. An event held back by
 *   concurrency or by a Mac that is asleep leaves the cursor where it is, so the
 *   next poll offers it again. This is `planTriggerDispatch`'s `wait`, and it is
 *   the poller's version of the scheduler leaving `nextRunAt` alone.
 *
 *   It is idempotent at the database. Every run it creates carries
 *   `triggerRunIdempotencyKey`, which is bucketed by the dedupe window, so two
 *   pollers racing on one delivery collide on `(userId, idempotencyKey)` and one
 *   run exists. The lease makes the race rare; the key makes it harmless.
 *
 *   It admits nothing a manual run would be refused. `planTriggerDispatch`
 *   repeats the scheduler's admission checks in the scheduler's order — plan
 *   budget, per-schedule and per-account concurrency, then whether any target
 *   can run this at all. "Run when an email arrives" must not be a way past the
 *   limits the user set on "run every morning".
 *
 * WHAT IT CANNOT DO, AND SAYS SO
 *
 * Only `email_filter` and `calendar_window` have a source. `topic_monitor`,
 * `connector_event` and `folder_change` have no producer in this build;
 * `triggerSupport` refuses them by name, `normalizeTriggerDrafts` refuses to
 * store them, and the editor refuses to offer them. A trigger of one of those
 * kinds that reaches this process anyway — written by a newer build, or by
 * another client — is recorded in `lastPollError` rather than quietly matching
 * nothing for ever.
 */

import "server-only";

import { prisma, prismaUnguarded } from "@/lib/db";
import { getUserPlan } from "@/lib/usage";
import { checkBudget } from "@/lib/spend";
import { getActiveConnectors, openMcpToolset, type McpToolset } from "@/lib/mcp";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/untrusted-content";
import { appendEvents, createRun, finishRun } from "@/lib/work/store";
import {
  WORK_LIVE_STATUSES,
  defaultVisibilityFor,
  narrowestPolicy,
  type WorkTerminalReason,
} from "@/lib/work/domain";
import {
  DEFAULT_USER_CONCURRENCY_CAP,
  hostCapabilityView,
  hostOfflinePolicyOf,
  parseScheduleRunConfig,
  permissionPolicyOf,
  scheduleTargetOf,
  unattendedPolicyOf,
  type JsonObject,
} from "@/lib/work/schedule";
import {
  TRIGGER_POLL_ERROR_INTERVAL_MS,
  TRIGGER_POLL_UNSERVABLE_INTERVAL_MS,
  advanceTriggerCursor,
  evaluateTrigger,
  eventKeyFromTriggerRunKey,
  isEventTriggerKind,
  parseTriggerConfig,
  parseTriggerCursor,
  planTriggerDispatch,
  triggerPollIntervalMs,
  triggerRunIdempotencyKey,
  triggerSourceConnector,
  triggerSupport,
  type CalendarTriggerEvent,
  type EmailTriggerEvent,
  type TriggerConfig,
  type TriggerCursor,
  type TriggerEvent,
  type TriggerState,
} from "@/lib/work/triggers";
import { effectiveHostState } from "@/app/api/work/protocol";

/**
 * How often to look for triggers whose next poll is due.
 *
 * Well under `MIN_TRIGGER_POLL_INTERVAL_MS`, so the cadence a trigger asks for
 * is the cadence it gets rather than being rounded up to this. The tick itself
 * is one indexed query when nothing is due.
 */
const TICK_MS = 15_000;

/** Triggers polled per tick. A cap, not a throughput target: one account with
 *  forty triggers must not starve the rest of the deployment. */
const MAX_TRIGGERS_PER_TICK = 10;

/**
 * How long the poll lease is held.
 *
 * Generous compared with `SCHEDULE_LOCK_MS`, because what it covers is
 * different: a scheduler's lease covers database writes, and this one covers an
 * IMAP or CalDAV round-trip to iCloud. Too short and a slow but healthy poll is
 * duplicated by the next poller to sweep; the cursor makes that harmless, but it
 * doubles the load on the account that was already slow.
 */
const POLL_LOCK_MS = 3 * 60_000;

/**
 * Whether cloud Work is accepting runs. Matches the constant the scheduler and
 * the run-dispatch route hold, and for the same reason: turning cloud off should
 * produce an honest refusal rather than a queue nothing will ever claim.
 */
const CLOUD_WORK_AVAILABLE = true;

/**
 * How many recently-started runs are read back to fill `recentEventKeys`.
 *
 * `WorkTrigger.lastEventKey` holds one key, which is enough for the same thread
 * arriving three times in a row and not enough for two threads interleaving.
 * Twenty-five is the page `search_messages` returns, so a poll cannot present
 * more distinct events than this lookback covers.
 */
const RECENT_RUN_LOOKBACK = 25;

/** The newest messages one mail poll considers. The mail tool's own ceiling. */
const MAIL_PAGE = 25;

/**
 * The kinds the sweep looks at.
 *
 * Every event kind, not just the two with a source: a `folder_change` row
 * written by a client that did not ask `triggerSupport` has to be picked up once
 * to be told, in `lastPollError`, that nothing watches folders. It is then given
 * an hour, so the cost of carrying it is one query an hour rather than a control
 * that lies. The clock kinds are absent because they are the scheduler's, and
 * sweeping them here would be a second worker reading rows it can do nothing
 * with.
 */
const POLLED_KINDS: string[] = [
  "email_filter",
  "calendar_window",
  "topic_monitor",
  "connector_event",
  "folder_change",
];

/** A stable identity for this poller, recorded on everything it decides. */
const POLLER_ID = `work-trigger-poller:${process.pid}:${process.env.HOSTNAME ?? "local"}`;

let stopping = false;

function log(message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[work-trigger-poller] ${message}${suffix}`);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * What each account may still spend, remembered for the length of one tick.
 *
 * The same cache the scheduler keeps, for the same reason: ten triggers
 * belonging to one user become one budget read rather than ten. Nothing here
 * enforces the budget — the executor does, per token — so a figure a few seconds
 * old can only affect whether a run is started, never whether it overspends.
 */
async function remainingBudgetMicroUsd(
  userId: string,
  cache: Map<string, number | null>
): Promise<number | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const plan = await getUserPlan(userId);
  const status = await checkBudget(userId, plan);
  cache.set(userId, status.remainingMicroUsd);
  return status.remainingMicroUsd;
}

// ---------------------------------------------------------------------------
// Reading a source
// ---------------------------------------------------------------------------

/**
 * What one poll of one source found.
 *
 * `events` is OLDEST FIRST, and that ordering is not cosmetic: the cursor is
 * advanced one event at a time and stops at the first one that could not be
 * dealt with, so a newest-first list would consume the whole page the moment the
 * newest message was admitted.
 *
 * `cursorSource` is null for a source with no position to remember. A calendar
 * window is one: it is a question about a span of time rather than a place in a
 * stream, the same meeting is legitimately seen on every poll of the window, and
 * the dedupe window — which `dedupeWindowMs` widens to at least the lead time —
 * is what stops the second sighting starting a second run.
 */
interface SourceRead {
  events: TriggerEvent[];
  cursorSource: string | null;
  /** The position to store once every event above has been dealt with. */
  cursorPosition: string | null;
  /** True on the first read of a source: nothing fires, the mark is recorded. */
  establishing: boolean;
}

/** A poll that could not read its source, in the sentence the user is shown. */
class SourceUnavailable extends Error {}

/**
 * Strips the untrusted-content envelope `openMcpToolset` puts on every result.
 *
 * The envelope is there because the overwhelmingly common destination of a tool
 * result is a model's context, and it is exactly wrong here: nothing this
 * process reads reaches a model. What a trigger event carries is a sender, a
 * subject and a pair of timestamps, and they are compared against the user's own
 * filter and then thrown away — the run that starts is driven by the schedule's
 * instructions, which the user wrote. So the markers are removed rather than
 * parsed around, and a result that does not carry them is returned unchanged
 * rather than being treated as an error, because `execute` returns the same
 * shape for an unroutable tool name.
 */
function unwrapUntrusted(result: string): string {
  const open = result.indexOf(UNTRUSTED_OPEN);
  if (open !== 0) return result;
  const body = result.slice(result.indexOf("\n", open) + 1);
  const close = body.lastIndexOf(UNTRUSTED_CLOSE);
  return close === -1 ? body : body.slice(0, close).trimEnd();
}

/**
 * Calls one connector tool through the connector layer and returns its text.
 *
 * `getActiveConnectors` and `openMcpToolset` are the whole point of the shape of
 * this function. The poller never sees an iCloud app-specific password: the
 * connector layer mints a short-lived signed token for Juno's own MCP route,
 * that route decrypts the credential per call and never returns it, and this
 * process holds nothing but a URL and a bearer it cannot read. Reaching into
 * `src/lib/apple/mail.ts` directly — which from a server-side script would work
 * — would put the account's real credential in this process's heap for the sake
 * of skipping one HTTP hop.
 *
 * The tool is found by suffix rather than by the composed name.
 * `openMcpToolset` namespaces tools as `<connector>__<tool>` and de-duplicates
 * collisions by appending to the name, so the composed form is only predictable
 * while the toolset holds exactly one connector — which it does here, and which
 * is precisely the kind of thing that stops being true silently.
 */
async function callConnectorTool(
  userId: string,
  connectorId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const active = await getActiveConnectors(userId, [connectorId]);
  if (active.length === 0) {
    // The three states `getActiveConnectors` collapses into "skip it": not
    // configured on this deployment, never linked, or a stored credential that
    // no longer decrypts. It does not say which, so neither does this — naming
    // the wrong one sends somebody to re-link a connector that was never
    // switched on for the deployment at all. The wording matches the
    // `credential_unusable` sentence in `evaluateConnector`, which is the case
    // the user can act on and by far the most common of the three.
    throw new SourceUnavailable(
      `Juno could not reach ${connectorId} for this account. It may need to be connected again.`
    );
  }

  let toolset: McpToolset | null = null;
  try {
    toolset = await openMcpToolset(active, {
      userId,
      surface: "trigger",
      sessionId: `trigger:${connectorId}:${tool}`,
      // Nobody is watching a poll. A trigger is only ever meant to READ — those
      // classify read_only and never reach an approval — but a trigger pointed
      // at a write tool must fail fast and loudly rather than hold this worker
      // for the receipt's whole lifetime waiting for an answer.
      unattended: true,
    });
    const suffix = `__${tool}`;
    const named = toolset.tools.find((entry) => entry.function.name.endsWith(suffix));
    if (!named) {
      throw new SourceUnavailable(
        `${connectorId} did not offer the ${tool} tool, so Juno has no way to check this trigger.`
      );
    }
    return unwrapUntrusted((await toolset.execute(named.function.name, args)).text);
  } finally {
    await toolset?.close().catch(() => {});
  }
}

/**
 * Whether a tool result is one of the failures `openMcpToolset` reports as text.
 *
 * The MCP route answers a failed call with `isError` and a body beginning
 * "Error:", and the toolset wraps its own transport failures as "Tool error:" —
 * both of which arrive here as an ordinary string. Without this check a mailbox
 * whose password was rotated parses as a page with no messages, which is
 * indistinguishable from a quiet inbox and would keep the trigger looking
 * healthy for as long as the credential stayed broken.
 */
const TOOL_FAILURE_PREFIXES = ["Error:", "Tool error:", "Connector ", "Unknown tool:"];

function toolFailure(text: string): string | null {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  return TOOL_FAILURE_PREFIXES.some((prefix) => first.startsWith(prefix)) ? first : null;
}

/*
 * PARSING THE CONNECTOR'S ANSWER
 *
 * The two functions below read the line format that
 * `src/app/api/mcp/[connector]/route.ts` renders, and that coupling is the
 * weakest joint in this file. It is deliberate rather than overlooked: that
 * route is the connector layer's only interface, MCP tools return text, and the
 * alternative is a second code path to iCloud that holds the real credential.
 *
 * What makes it survivable is that neither parser guesses. Each anchors on a
 * marker the renderer cannot produce by accident — `[uid N]` for a message,
 * ` · uid: ` for an event — and a page whose lines all fail to parse is reported
 * as a poll error rather than as an empty result. A trigger that has stopped
 * matching because the format moved therefore shows up in `lastPollError`, which
 * is a thing somebody can see, instead of as silence.
 */

/**
 * One line of `search_messages` output.
 *
 * `• [uid 48213] Subject — from a@b.com · 2026-08-07T09:00:00.000Z · unread`
 *
 * The subject is split off at the LAST ` — from `, not the first: a subject may
 * legitimately contain that phrase and the renderer's own separator is always
 * the final one. The sender is then everything up to the first ` · `, and the
 * remaining fields are looked at by shape rather than by position, because
 * `date` and the unread flag are both optional and a positional read would take
 * "unread" for a timestamp on a message whose envelope had no date.
 */
function parseMailLine(line: string, mailbox: string): EmailTriggerEvent | null {
  const head = /^•\s*\[uid (\d+)\]\s*(.*)$/.exec(line.trim());
  if (!head) return null;
  const uid = Number(head[1]);
  if (!Number.isSafeInteger(uid)) return null;

  const rest = head[2];
  const split = rest.lastIndexOf(" — from ");
  const subject = split === -1 ? rest : rest.slice(0, split);
  const tail = split === -1 ? "" : rest.slice(split + " — from ".length);
  const fields = tail.split(" · ");
  const from = fields[0] ?? "";
  const date = fields.slice(1).find((field) => !Number.isNaN(Date.parse(field)));

  return {
    kind: "email_filter",
    // The mailbox is in the key as well as the uid. IMAP UIDs are unique within
    // a mailbox and not across an account, so a key without it would let a
    // message in Archive suppress an unrelated one in INBOX.
    eventKey: `apple-mail:${mailbox}:${uid}`,
    occurredAt: date ? new Date(date) : new Date(),
    from,
    subject,
    // Both empty, and both refused upstream rather than guessed at.
    // `TRIGGER_OPTION_LIMITS` names `labels` and `requireAttachment` as options
    // this reader cannot answer, `triggerSupport` refuses a trigger that asks
    // for either, and the editor says so at the field. Filling them with
    // plausible defaults here is what would make the refusal removable by
    // somebody who saw the values and assumed they were real.
    labels: [],
    hasAttachment: false,
  };
}

/**
 * One line of `list_events` output.
 *
 * `• Standup — 2026-08-07T09:00:00Z → 2026-08-07T09:15:00Z (recurring) · uid: X · calendar: Work`
 *
 * Read from the right, because that end is machine-written: the trailing
 * ` · uid: ` and ` · calendar: ` fields are the renderer's, while everything
 * before them came out of somebody's calendar and may contain anything at all.
 */
function parseCalendarLine(line: string): CalendarTriggerEvent | null {
  const calendarAt = line.lastIndexOf(" · calendar: ");
  if (calendarAt === -1) return null;
  const calendarId = line.slice(calendarAt + " · calendar: ".length).trim();

  const head = line.slice(0, calendarAt);
  const uidAt = head.lastIndexOf(" · uid: ");
  if (uidAt === -1) return null;
  const uid = head.slice(uidAt + " · uid: ".length).trim();
  if (!uid) return null;

  const body = head.slice(0, uidAt).replace(/^•\s*/, "");
  // The times are the one span written as `<start> → <end>`; the arrow is not a
  // character a calendar client puts in a title, and the renderer emits exactly
  // one of them.
  const times = /^(.*) — ([^—]*?) → ([^—(]*?)(?:\s*\(([^)]*)\))?\s*$/.exec(body);
  if (!times) return null;
  const startsAt = new Date(times[2].trim());
  const endsAt = new Date(times[3].trim());
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;

  return {
    kind: "calendar_window",
    // The occurrence, not the series. A recurring meeting has one uid for every
    // instance of it, so a key without the start time would let Monday's
    // stand-up suppress Tuesday's for as long as the dedupe window is open.
    eventKey: `apple-calendar:${uid}:${startsAt.toISOString()}`,
    occurredAt: startsAt,
    calendarId,
    title: times[1].trim(),
    startsAt,
    endsAt,
    // Zero, and refused rather than assumed: `requireAttendees` is on
    // `TRIGGER_OPTION_LIMITS` because CalDAV's summary view carries no attendee
    // list, so a trigger that filters on it cannot be stored in the first place.
    attendeeCount: 0,
  };
}

/**
 * Reads whatever the trigger watches and returns it as events.
 *
 * Every path either returns a `SourceRead` or throws `SourceUnavailable` with a
 * sentence for the user; there is no third outcome where a poll succeeds and
 * says nothing about why it found nothing.
 */
async function readSource(
  userId: string,
  parsed: TriggerConfig,
  cursor: TriggerCursor,
  now: Date
): Promise<SourceRead> {
  const connectorId = triggerSourceConnector(parsed.kind);
  if (!connectorId) {
    // Unreachable in practice — `triggerSupport` refuses every kind with no
    // connector before this is called — and stated rather than assumed, because
    // "no source" reaching here silently would be a trigger polled for ever
    // against nothing.
    throw new SourceUnavailable(`Juno has no source to watch for a ${parsed.kind} trigger.`);
  }

  if (parsed.kind === "email_filter") {
    const mailbox = "INBOX";
    const source = `${connectorId}:${mailbox}`;
    const text = await callConnectorTool(userId, connectorId, "search_messages", {
      mailbox,
      limit: MAIL_PAGE,
    });
    const failure = toolFailure(text);
    if (failure) throw new SourceUnavailable(`Juno could not read ${mailbox}: ${failure}`);

    const lines = text.split("\n").filter((line) => line.trim().startsWith("•"));
    const parsedLines = lines.map((line) => parseMailLine(line, mailbox));
    if (lines.length > 0 && parsedLines.every((entry) => entry === null)) {
      throw new SourceUnavailable(
        "Juno could not make sense of what the mail connector returned, so it has not looked at these messages."
      );
    }
    const messages = parsedLines.filter((entry): entry is EmailTriggerEvent => entry !== null);

    const uidOf = (event: EmailTriggerEvent) => Number(event.eventKey.slice(source.length + 1));
    // Oldest first, by UID rather than by date: the cursor is a UID, and a
    // mailbox where two messages share a second — or where one carries a wrong
    // Date header, which spam routinely does — would otherwise be walked in an
    // order the cursor cannot express.
    messages.sort((left, right) => uidOf(left) - uidOf(right));
    const highest = messages.length > 0 ? uidOf(messages[messages.length - 1]) : null;

    const mark = cursor[source];
    const seen = mark === undefined ? null : Number(mark);
    // A cursor that does not read as a number is treated as no cursor at all.
    // `parseTriggerCursor` already drops non-strings; this covers a string that
    // is not a UID, which is the shape a future source's position would have.
    const establishing = seen === null || !Number.isSafeInteger(seen);

    return {
      events: establishing ? [] : messages.filter((event) => uidOf(event) > seen),
      cursorSource: source,
      cursorPosition: highest === null ? (mark ?? null) : String(highest),
      establishing,
    };
  }

  if (parsed.kind === "calendar_window") {
    // Exactly the window the matcher will accept, so the connector is not asked
    // for a fortnight of events that `matchCalendar` would refuse one by one as
    // `outside_window`. `list_events` defaults to fourteen days when it is not
    // told otherwise, which for a ten-minute lead is roughly two thousand times
    // more calendar than the question needs.
    const to = new Date(now.getTime() + parsed.config.leadMinutes * 60_000);
    const text = await callConnectorTool(userId, connectorId, "list_events", {
      from: now.toISOString(),
      to: to.toISOString(),
      limit: 50,
    });
    const failure = toolFailure(text);
    if (failure) throw new SourceUnavailable(`Juno could not read your calendar: ${failure}`);

    const lines = text.split("\n").filter((line) => line.trim().startsWith("•"));
    const parsedLines = lines.map(parseCalendarLine);
    if (lines.length > 0 && parsedLines.every((entry) => entry === null)) {
      throw new SourceUnavailable(
        "Juno could not make sense of what the calendar connector returned, so it has not looked at these meetings."
      );
    }
    const events = parsedLines.filter((entry): entry is CalendarTriggerEvent => entry !== null);
    events.sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

    return { events, cursorSource: null, cursorPosition: null, establishing: false };
  }

  throw new SourceUnavailable(`Juno has no source to watch for a ${parsed.kind} trigger.`);
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

type TriggerRow = Awaited<ReturnType<typeof findDueTriggers>>[number];
type ScheduleRow = NonNullable<Awaited<ReturnType<typeof loadSchedule>>>;

async function loadSchedule(scheduleId: string, userId: string) {
  return prisma.workSchedule.findFirst({
    where: { id: scheduleId, userId },
    include: { session: true },
  });
}

/**
 * Takes the poll lease on one trigger.
 *
 * The condition is in the WHERE, not in a preceding read: two pollers that both
 * saw the same unlocked row issue the same UPDATE and Postgres decides which one
 * matched. `enabled` is re-tested here as well, so a trigger switched off in the
 * moment between the sweep and the claim is not polled by a poller acting on a
 * fifteen-second-old snapshot.
 */
async function claimTrigger(trigger: TriggerRow, now: Date): Promise<boolean> {
  const claim = await prisma.workTrigger.updateMany({
    where: {
      id: trigger.id,
      userId: trigger.userId,
      enabled: true,
      ...(trigger.pollLockedUntil === null
        ? { pollLockedUntil: null }
        : { pollLockedUntil: trigger.pollLockedUntil }),
    },
    data: { pollLockedUntil: new Date(now.getTime() + POLL_LOCK_MS) },
  });
  return claim.count > 0;
}

/** Releases the lease and says when to look at this trigger again. */
async function settle(
  trigger: TriggerRow,
  data: {
    nextPollAt: Date;
    lastPollError: string | null;
    cursor?: JsonObject;
    lastEventKey?: string;
    lastFiredAt?: Date;
  }
): Promise<void> {
  await prisma.workTrigger.updateMany({
    where: { id: trigger.id, userId: trigger.userId },
    data: { ...data, lastPolledAt: new Date(), pollLockedUntil: null },
  });
}

/**
 * The event keys this trigger has already started runs for, recently.
 *
 * Read back off the runs' own idempotency keys rather than from a second table
 * of fired events, which is what `eventKeyFromTriggerRunKey` exists for: the
 * runs a trigger started are one indexed query away and are already the record
 * of what it fired on, whereas a side table would be a second thing to write,
 * expire and keep consistent with the runs it describes.
 */
async function recentEventKeys(trigger: TriggerRow): Promise<string[]> {
  const runs = await prisma.workRun.findMany({
    where: {
      userId: trigger.userId,
      scheduleId: trigger.scheduleId,
      origin: "trigger",
      idempotencyKey: { startsWith: `wtrg:${trigger.id}:` },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_RUN_LOOKBACK,
    select: { idempotencyKey: true },
  });
  return runs.flatMap((run) => {
    const key = run.idempotencyKey ? eventKeyFromTriggerRunKey(trigger.id, run.idempotencyKey) : null;
    return key ? [key] : [];
  });
}

/**
 * Writes down a fire that will not happen.
 *
 * A run row rather than a log line, for the reason the scheduler's
 * `recordMarkerRun` gives: the console is not a surface any user can see, and a
 * trigger that has been budget-blocked for a fortnight is otherwise
 * indistinguishable from one nothing has matched in. It shares its idempotency
 * key with the run this event would have produced, so one event yields exactly
 * one row whichever way it went.
 */
async function recordMarkerRun(input: {
  schedule: ScheduleRow;
  idempotencyKey: string;
  reason: WorkTerminalReason;
  explanation: string;
}): Promise<void> {
  const created = await createRun({
    sessionId: input.schedule.sessionId,
    userId: input.schedule.userId,
    origin: "trigger",
    scheduleId: input.schedule.id,
    requestedTarget: scheduleTargetOf(input.schedule.target),
    // Null, and true: nothing ran anywhere. Naming a target here would put a
    // run against a machine that never saw it.
    effectiveTarget: null,
    idempotencyKey: input.idempotencyKey,
  });
  if (created.replay) return;

  await finishRun({
    runId: created.run.id,
    userId: input.schedule.userId,
    reason: input.reason,
    detail: input.explanation,
  });
  await appendEvents({
    runId: created.run.id,
    userId: input.schedule.userId,
    events: [
      {
        kind: "run_finished",
        payload: { reason: input.reason, explanation: input.explanation },
        visibility: defaultVisibilityFor("run_finished"),
        key: `${created.run.id}:${POLLER_ID}:1`,
      },
    ],
  });
}

/** What one event did when it was offered to the trigger. */
type Settlement = "fired" | "settled" | "held";

/**
 * Offers one event to one trigger and, if it matches, starts the run.
 *
 * "settled" and "held" are the distinction the cursor turns on. A settled event
 * is one this trigger will never act on — it did not match, or it is a repeat of
 * one already fired — so the cursor may move past it. A held one is a match that
 * could not be started right now, and moving past it would consume a matching
 * email the user will never hear about.
 */
async function offer(
  trigger: TriggerRow,
  schedule: ScheduleRow,
  event: TriggerEvent,
  context: { now: Date; recent: readonly string[]; budgets: Map<string, number | null> }
): Promise<Settlement> {
  const state: TriggerState = {
    id: trigger.id,
    kind: trigger.kind,
    config: trigger.config,
    enabled: trigger.enabled,
    lastEventKey: trigger.lastEventKey,
    lastFiredAt: trigger.lastFiredAt,
    dedupeWindowSec: trigger.dedupeWindowSec,
  };

  const hosts = await prisma.workHost.findMany({ where: { userId: trigger.userId } });
  // The schedule's chosen Mac first: `selectTarget` takes the first fully
  // capable host in the list, which is how "run it on the MacBook" is said to it.
  const ordered = schedule.hostId
    ? [...hosts].sort((left, right) =>
        left.id === schedule.hostId ? -1 : right.id === schedule.hostId ? 1 : 0
      )
    : hosts;
  const views = ordered.map((host) => hostCapabilityView(host, effectiveHostState(host, context.now)));

  const verdict = evaluateTrigger({
    trigger: state,
    event,
    now: context.now,
    hosts: views,
    recentEventKeys: context.recent,
  });
  if (!verdict.fire) {
    // Every non-firing verdict is settled, including `host_offline`. That reads
    // wrong for a moment and is right: the host check inside `evaluateTrigger`
    // only applies to the local-only kinds, where the event was reported BY a
    // Mac that has since gone away — so there is nothing to come back to, and
    // the equivalent question for a cloud-sourced event is the one
    // `planTriggerDispatch` asks below, which does hold.
    return "settled";
  }

  const runConfig = parseScheduleRunConfig(schedule.runConfig);
  const [inFlightForSchedule, inFlightForUser] = await Promise.all([
    prisma.workRun.count({
      where: {
        userId: schedule.userId,
        scheduleId: schedule.id,
        status: { in: [...WORK_LIVE_STATUSES] },
      },
    }),
    // Every schedule of this account, not just this one: ten schedules each
    // capped at one still start ten simultaneous runs, and the budget and the
    // user's attention are shared across all of them.
    prisma.workRun.count({
      where: {
        userId: schedule.userId,
        scheduleId: { not: null },
        status: { in: [...WORK_LIVE_STATUSES] },
      },
    }),
  ]);

  const decision = planTriggerDispatch({
    schedule: {
      enabled: schedule.enabled,
      target: scheduleTargetOf(schedule.target),
      hostOfflinePolicy: hostOfflinePolicyOf(schedule.hostOfflinePolicy),
      maxConcurrentRuns: schedule.maxConcurrentRuns,
    },
    inFlightForSchedule,
    inFlightForUser,
    userConcurrencyCap: DEFAULT_USER_CONCURRENCY_CAP,
    hosts: views,
    requiredCapabilities: runConfig.requiredCapabilities,
    cloudAvailable: CLOUD_WORK_AVAILABLE,
    remainingBudgetMicroUsd: await remainingBudgetMicroUsd(schedule.userId, context.budgets),
  });

  const idempotencyKey = triggerRunIdempotencyKey(
    trigger.id,
    verdict.eventKey,
    context.now,
    trigger.dedupeWindowSec
  );

  if (decision.outcome === "wait") {
    log("held", {
      triggerId: trigger.id,
      cause: decision.cause,
      eventKey: verdict.eventKey,
      why: decision.explanation,
    });
    return "held";
  }

  if (decision.outcome === "skip") {
    await recordMarkerRun({
      schedule,
      idempotencyKey,
      reason: decision.reason,
      explanation: decision.explanation,
    });
    log("skipped", { triggerId: trigger.id, cause: decision.cause, why: decision.explanation });
    return "settled";
  }

  // The policy the executor will enforce, after narrowing. `narrowestPolicy` is
  // a `min`, so no layer can widen another: a Mac pinned to `conservative` stays
  // conservative under a `permissive` session.
  const host = decision.hostId
    ? ordered.find((candidate) => candidate.id === decision.hostId)
    : undefined;
  const sessionPolicy = permissionPolicyOf(schedule.session.permissionPolicy);
  const hostPolicy = host ? permissionPolicyOf(host.approvalPolicy) : null;
  const permissionPolicy: JsonObject = {
    policy: narrowestPolicy(sessionPolicy, hostPolicy),
    session: sessionPolicy,
    host: hostPolicy,
    unattended: unattendedPolicyOf(schedule.unattendedPolicy),
    // False, and this is the whole reason a trigger run is not a manual one:
    // an email arriving at 03:00 has nobody behind it, so the executor must
    // checkpoint on the first question rather than wait for an answer.
    attended: false,
  };

  const created = await createRun({
    sessionId: schedule.sessionId,
    userId: schedule.userId,
    // "trigger", not "schedule". The schedule's fired-on-time history is about
    // its clock, and a run started by an email landing did not happen on time
    // or late — it happened because something happened.
    origin: "trigger",
    scheduleId: schedule.id,
    requestedTarget: scheduleTargetOf(schedule.target),
    effectiveTarget: decision.effectiveTarget,
    hostId: decision.hostId,
    requestedModel: runConfig.model ?? schedule.session.requestedModel,
    requiredCapabilities: runConfig.requiredCapabilities,
    degradation: decision.degradation,
    permissionPolicy,
    budget: {
      maxCostMicroUsd: schedule.maxCostMicroUsd,
      maxTokens: schedule.maxTokens,
      maxRuntimeMs: schedule.maxRuntimeMs,
    },
    idempotencyKey,
  });

  if (!created.replay) {
    log("fired", {
      triggerId: trigger.id,
      runId: created.run.id,
      eventKey: verdict.eventKey,
      target: decision.effectiveTarget,
    });
  }
  return "fired";
}

// ---------------------------------------------------------------------------
// One trigger
// ---------------------------------------------------------------------------

/**
 * Polls one trigger and deals with everything it found.
 *
 * The lease is already held when this is called, and every path settles it — a
 * poll that decided to do nothing must not leave the trigger locked until the
 * lease lapses.
 */
async function pollOne(trigger: TriggerRow, budgets: Map<string, number | null>): Promise<void> {
  const now = new Date();

  // Asked here as well as at the write, and that repetition is the point: this
  // row may have been stored by a build that could serve its kind, or by a
  // client that never asked. Reporting it is the difference between a trigger
  // the user can see is not working and one that silently matches nothing.
  const support = triggerSupport(trigger.kind, trigger.config);
  if (!support.servable) {
    await settle(trigger, {
      nextPollAt: new Date(now.getTime() + TRIGGER_POLL_UNSERVABLE_INTERVAL_MS),
      lastPollError: support.message,
    });
    return;
  }

  const parse = parseTriggerConfig(trigger.kind, trigger.config);
  if (!parse.ok) {
    await settle(trigger, {
      nextPollAt: new Date(now.getTime() + TRIGGER_POLL_UNSERVABLE_INTERVAL_MS),
      lastPollError: parse.message,
    });
    return;
  }
  const parsed = parse.parsed;
  const healthyPollAt = new Date(now.getTime() + triggerPollIntervalMs(parsed));

  const schedule = await loadSchedule(trigger.scheduleId, trigger.userId);
  if (!schedule) {
    // The schedule was deleted between the sweep and the claim. The row will go
    // with it on the cascade; until it does, there is nothing to poll for.
    await settle(trigger, { nextPollAt: healthyPollAt, lastPollError: null });
    return;
  }
  if (!schedule.enabled) {
    // Not read at all while the schedule is paused. `planTriggerDispatch` would
    // hold every event anyway, and polling somebody's mailbox on behalf of a
    // schedule they have switched off is a read they did not ask for.
    await settle(trigger, { nextPollAt: healthyPollAt, lastPollError: null });
    return;
  }

  const cursor = parseTriggerCursor(trigger.cursor);
  let read: SourceRead;
  try {
    read = await readSource(trigger.userId, parsed, cursor, now);
  } catch (error) {
    const message =
      error instanceof SourceUnavailable
        ? error.message
        : // Never the raw error. A connector failure message is exactly the kind
          // of string that ends up carrying a fragment of what it failed on, and
          // this column is rendered in the schedule's UI.
          "Juno could not read this trigger's source. It will try again shortly.";
    if (!(error instanceof SourceUnavailable)) {
      log("poll failed", { triggerId: trigger.id, error: String(error) });
    }
    await settle(trigger, {
      nextPollAt: new Date(now.getTime() + TRIGGER_POLL_ERROR_INTERVAL_MS),
      lastPollError: message,
    });
    return;
  }

  if (read.establishing) {
    // The first sight of this source. The high-water mark is recorded and
    // nothing fires — see the note on `WorkTrigger.cursor`. A trigger created
    // this morning must not start a run for every message already in the inbox.
    await settle(trigger, {
      nextPollAt: healthyPollAt,
      lastPollError: null,
      ...(read.cursorSource && read.cursorPosition
        ? { cursor: advanceTriggerCursor(cursor, read.cursorSource, read.cursorPosition) }
        : {}),
    });
    log("established a starting point", {
      triggerId: trigger.id,
      source: read.cursorSource,
      at: read.cursorPosition,
    });
    return;
  }

  const recent = await recentEventKeys(trigger);
  let advanced: TriggerCursor = cursor;
  let lastFired: string | null = null;

  for (const event of read.events) {
    if (stopping) break;
    const settlement = await offer(trigger, schedule, event, { now, recent, budgets });
    // The first event that could not be dealt with stops the walk. Continuing
    // past it and advancing the cursor over the rest would consume it: the walk
    // is oldest-first precisely so that "stop here" and "remember up to here"
    // are the same instruction.
    if (settlement === "held") break;
    if (settlement === "fired") {
      lastFired = event.eventKey;
      // Fed back into the same walk, so two messages on one thread inside one
      // page deduplicate against each other rather than only against what was
      // already in the database when the poll started.
      recent.push(event.eventKey);
    }
    if (read.cursorSource) {
      // The position is the tail of the event key, which is where the key was
      // built from: `apple-mail:INBOX:48213` on the source `apple-mail:INBOX`
      // leaves the UID. Deriving it rather than carrying it separately keeps the
      // two from disagreeing about what the cursor means.
      const position = event.eventKey.slice(read.cursorSource.length + 1);
      advanced = advanceTriggerCursor(advanced, read.cursorSource, position);
    }
  }

  await settle(trigger, {
    nextPollAt: healthyPollAt,
    lastPollError: null,
    ...(read.cursorSource ? { cursor: advanced } : {}),
    ...(lastFired ? { lastEventKey: lastFired, lastFiredAt: now } : {}),
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Finds triggers whose next poll is due and nobody is polling.
 *
 * Cross-account by nature, so it says so with `prismaUnguarded` rather than
 * tripping a guard whose entire job is to notice a query that forgot its userId.
 *
 * The `kind` filter is the poller's half of `TRIGGER_SOURCE_CONNECTORS`: only
 * the kinds with a source are swept at the healthy cadence, so a deployment full
 * of clock triggers costs nothing here. A trigger of an unservable kind is
 * picked up by the hourly `nextPollAt` it is given, which is what lets it report
 * itself in `lastPollError` rather than being invisible.
 *
 * `nulls: "first"` is spelled out and is not decoration. A trigger that has
 * never been polled has a null `nextPollAt`, and Postgres orders ASC NULLS LAST
 * by default — so a plain ascending sort puts the trigger the user created a
 * moment ago BEHIND every trigger that already has a schedule. With `take`
 * capped at `MAX_TRIGGERS_PER_TICK`, a deployment with more due triggers than
 * that would never reach the new one, and it would sit unfired for as long as
 * the backlog lasted while looking perfectly healthy in the database.
 *
 * The index stays `(enabled, nextPollAt)` with no null ordering of its own,
 * which cannot serve this sort directly. That is deliberate: the WHERE is
 * already narrow — enabled, of a polled kind, due, and unleased — so what is
 * sorted is only what is due right now, and the alternative is an index
 * `prisma/schema.prisma` cannot express and that the next `migrate dev` would
 * offer to revert.
 */
async function findDueTriggers(now: Date, limit: number) {
  return prismaUnguarded.workTrigger.findMany({
    where: {
      enabled: true,
      kind: { in: POLLED_KINDS },
      OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
      AND: [{ OR: [{ pollLockedUntil: null }, { pollLockedUntil: { lt: now } }] }],
    },
    orderBy: { nextPollAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
}

async function tick(): Promise<void> {
  const now = new Date();
  const budgets = new Map<string, number | null>();

  for (const trigger of await findDueTriggers(now, MAX_TRIGGERS_PER_TICK)) {
    if (stopping) return;
    // Belt and braces against a row this build cannot classify: the query above
    // filters on a list of kinds, and `isEventTriggerKind` is the module that
    // owns the answer.
    if (!isEventTriggerKind(trigger.kind)) continue;
    if (!(await claimTrigger(trigger, now))) continue;

    try {
      await pollOne(trigger, budgets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The cursor is untouched, so nothing was consumed, and the lease is
      // released so the next tick retries rather than the trigger sitting locked
      // until the lease lapses.
      log("poll failed", { triggerId: trigger.id, error: message });
      await prisma.workTrigger
        .updateMany({
          where: { id: trigger.id, userId: trigger.userId },
          data: {
            pollLockedUntil: null,
            nextPollAt: new Date(now.getTime() + TRIGGER_POLL_ERROR_INTERVAL_MS),
            lastPollError: "Juno could not check this trigger. It will try again shortly.",
          },
        })
        .catch((releaseError: unknown) => {
          // Nothing further can be done in-process; the lease expires on its own
          // and the trigger is picked up then.
          log("could not release the lease", { triggerId: trigger.id, error: String(releaseError) });
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("started", { poller: POLLER_ID, tickMs: TICK_MS });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, finishing the current tick`);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      // One bad tick must not end the poller: the next one may well succeed, and
      // a poller that exits on a transient database error takes every event
      // trigger in the deployment with it.
      log("tick failed", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  log("stopped");
}

void main();
