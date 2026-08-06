import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_ONLY_TRIGGER_KINDS, type HostCapabilityView } from "@/lib/work/domain";
import {
  DEFAULT_DEDUPE_WINDOW_SEC,
  EVENT_TRIGGER_KINDS,
  configForEventTrigger,
  evaluateTrigger,
  isEventTriggerKind,
  normalizeTriggerDrafts,
  parseTriggerConfig,
  sameTriggerSet,
  triggerRunIdempotencyKey,
  type CalendarTriggerEvent,
  type ConnectorTriggerEvent,
  type EmailTriggerEvent,
  type FolderTriggerEvent,
  type TopicTriggerEvent,
  type TriggerEvent,
  type TriggerState,
} from "@/lib/work/triggers";

/*
 * Event triggers, and mostly deduplication.
 *
 * Every producer Juno listens to re-delivers. Gmail reports a thread again when
 * a second message lands on it; a calendar poller sees the same meeting on
 * every tick of its lead window; a folder watcher fires once per file in a copy
 * of forty. Each of those re-deliveries is a run, and each run costs money and
 * may send something. The tests below are almost all about the difference
 * between "this happened" and "I have already been told this happened".
 */

const NOW = new Date("2026-08-05T09:00:00Z");
const HOUR_MS = 3_600_000;

function trigger(overrides: Partial<TriggerState> = {}): TriggerState {
  return {
    id: "trg-1",
    kind: "email_filter",
    config: {},
    enabled: true,
    lastEventKey: null,
    lastFiredAt: null,
    dedupeWindowSec: 3600,
    ...overrides,
  };
}

function email(overrides: Partial<EmailTriggerEvent> = {}): EmailTriggerEvent {
  return {
    kind: "email_filter",
    eventKey: "thread-1",
    occurredAt: NOW,
    from: "Billing <billing@stripe.com>",
    subject: "Invoice 4471 is ready",
    labels: ["INBOX", "Finance"],
    hasAttachment: true,
    ...overrides,
  };
}

function meeting(overrides: Partial<CalendarTriggerEvent> = {}): CalendarTriggerEvent {
  return {
    kind: "calendar_window",
    eventKey: "cal-1",
    occurredAt: NOW,
    calendarId: "primary",
    title: "Quarterly review with Acme",
    startsAt: new Date(NOW.getTime() + 9 * 60_000),
    endsAt: new Date(NOW.getTime() + 69 * 60_000),
    attendeeCount: 4,
    ...overrides,
  };
}

function topic(overrides: Partial<TopicTriggerEvent> = {}): TopicTriggerEvent {
  return {
    kind: "topic_monitor",
    eventKey: "topic-1",
    occurredAt: NOW,
    matchedTerms: ["acme", "funding"],
    sourceCount: 3,
    ...overrides,
  };
}

function connectorEvent(overrides: Partial<ConnectorTriggerEvent> = {}): ConnectorTriggerEvent {
  return {
    kind: "connector_event",
    eventKey: "delivery-1",
    occurredAt: NOW,
    connector: "linear",
    event: "issue.created",
    attributes: { team: "core", priority: "urgent" },
    ...overrides,
  };
}

function folderChange(overrides: Partial<FolderTriggerEvent> = {}): FolderTriggerEvent {
  return {
    kind: "folder_change",
    eventKey: "watch-1",
    occurredAt: NOW,
    grantId: "grant-1",
    hostId: "host-1",
    changedNames: ["january.csv", "notes.txt"],
    ...overrides,
  };
}

function host(overrides: Partial<HostCapabilityView> = {}): HostCapabilityView {
  return {
    hostId: "host-1",
    displayName: "Liam's MacBook",
    state: "idle",
    enabled: true,
    revoked: false,
    capabilities: ["local_files"],
    ...overrides,
  };
}

function verdict(state: TriggerState, event: TriggerEvent, extra: Partial<Parameters<typeof evaluateTrigger>[0]> = {}) {
  return evaluateTrigger({ trigger: state, event, now: NOW, ...extra });
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("the event kinds are a subset of the trigger vocabulary and do not overlap the clock ones", () => {
  assert.equal(EVENT_TRIGGER_KINDS.length, 6);
  assert.equal(isEventTriggerKind("email_filter"), true);
  assert.equal(isEventTriggerKind("daily"), false, "daily fires on a clock, and lives in schedule.ts");
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("an empty configuration means match anything of this kind", () => {
  // A filter with no criteria is a legitimate thing to ask for — "every email
  // with this label" is written by leaving the sender blank.
  const parsed = parseTriggerConfig("email_filter", {});
  assert.equal(parsed.ok, true);
  assert.equal(verdict(trigger(), email()).fire, true);
});

test("the two configurations that name something are refused when they name nothing", () => {
  const connector = parseTriggerConfig("connector_event", { events: ["issue.created"] });
  assert.equal(connector.ok, false);

  const folder = parseTriggerConfig("folder_change", { suffixes: [".csv"] });
  assert.equal(folder.ok, false);

  const clockKind = parseTriggerConfig("daily", { hour: 9 });
  assert.equal(clockKind.ok, false);
});

test("configuration lists are lower-cased once, at parse time", () => {
  const parsed = parseTriggerConfig("email_filter", { from: ["  Billing@Stripe.COM  "], labels: [42, "Finance"] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.parsed.kind !== "email_filter") throw new Error("unreachable");
  assert.deepEqual(parsed.parsed.config.from, ["billing@stripe.com"]);
  // A stray non-string in a producer's list must not disable the user's filter.
  assert.deepEqual(parsed.parsed.config.labels, ["finance"]);
});

// ---------------------------------------------------------------------------
// Email filters
// ---------------------------------------------------------------------------

test("an email filter matches on sender, subject, labels and attachments", () => {
  const state = trigger({
    config: {
      from: ["@stripe.com"],
      subjectContains: ["invoice"],
      labels: ["finance"],
      requireAttachment: true,
    },
  });
  assert.equal(verdict(state, email()).fire, true);
});

test("every subject phrase must appear, but any one sender is enough", () => {
  const bothPhrases = trigger({ config: { subjectContains: ["invoice", "ready"] } });
  assert.equal(verdict(bothPhrases, email()).fire, true);

  const missingPhrase = trigger({ config: { subjectContains: ["invoice", "overdue"] } });
  assert.equal(verdict(missingPhrase, email()).fire, false);

  const eitherSender = trigger({ config: { from: ["@example.com", "@stripe.com"] } });
  assert.equal(verdict(eitherSender, email()).fire, true);
});

test("an exclusion vetoes a message the rest of the filter would have matched", () => {
  const excludedSender = trigger({ config: { from: ["@stripe.com"], excludeFrom: ["billing@"] } });
  const senderVerdict = verdict(excludedSender, email());
  assert.equal(senderVerdict.fire, false);
  if (senderVerdict.fire) throw new Error("unreachable");
  assert.equal(senderVerdict.reason, "filter_unmatched");
  assert.match(senderVerdict.explanation, /exclusion list/);

  const excludedSubject = trigger({
    config: { subjectContains: ["invoice"], excludeSubjectContains: ["4471"] },
  });
  assert.equal(verdict(excludedSubject, email()).fire, false);
});

test("a missing label or attachment is reported as the filter not matching", () => {
  const needsLabel = trigger({ config: { labels: ["finance", "urgent"] } });
  assert.equal(verdict(needsLabel, email()).fire, false);

  const needsAttachment = trigger({ config: { requireAttachment: true } });
  assert.equal(verdict(needsAttachment, email({ hasAttachment: false })).fire, false);
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("a filter that matches one thread three times starts one run", () => {
  // The case the whole mechanism exists for: Gmail re-delivers a thread every
  // time a message lands on it, and three deliveries must not be three runs.
  const first = verdict(trigger(), email());
  assert.equal(first.fire, true);
  if (!first.fire) throw new Error("unreachable");

  // What the caller writes back after firing.
  const fired = trigger({ lastEventKey: first.eventKey, lastFiredAt: NOW });

  for (const minutesLater of [1, 20]) {
    const later = evaluateTrigger({
      trigger: fired,
      event: email({ eventKey: "thread-1" }),
      now: new Date(NOW.getTime() + minutesLater * 60_000),
    });
    assert.equal(later.fire, false, `${minutesLater} minutes later`);
    if (later.fire) throw new Error("unreachable");
    assert.equal(later.reason, "duplicate_event");
  }
});

test("a different thread inside the window is a different run", () => {
  const fired = trigger({ lastEventKey: "thread-1", lastFiredAt: NOW });
  const other = evaluateTrigger({
    trigger: fired,
    event: email({ eventKey: "thread-2" }),
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(other.fire, true);
});

test("the same thread after the window has passed is a new run", () => {
  const fired = trigger({ dedupeWindowSec: 3600, lastEventKey: "thread-1", lastFiredAt: NOW });
  const justInside = evaluateTrigger({
    trigger: fired,
    event: email(),
    now: new Date(NOW.getTime() + HOUR_MS - 1_000),
  });
  assert.equal(justInside.fire, false);

  const justOutside = evaluateTrigger({
    trigger: fired,
    event: email(),
    now: new Date(NOW.getTime() + HOUR_MS + 1_000),
  });
  assert.equal(justOutside.fire, true);
});

test("interleaved threads defeat the single stored key, and recentEventKeys is why the caller may pass more", () => {
  // A, B, A. `lastEventKey` reads B when the second A arrives, so the column
  // alone accepts the repeat; this is a real limit of the one-column design and
  // the reason `recentEventKeys` exists.
  const afterB = trigger({ lastEventKey: "thread-B", lastFiredAt: NOW });
  const repeatOfA = evaluateTrigger({
    trigger: afterB,
    event: email({ eventKey: "thread-A" }),
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(repeatOfA.fire, true, "the column alone cannot catch this");

  const withHistory = evaluateTrigger({
    trigger: afterB,
    event: email({ eventKey: "thread-A" }),
    now: new Date(NOW.getTime() + 60_000),
    recentEventKeys: ["thread-A", "thread-B"],
  });
  assert.equal(withHistory.fire, false);
  if (withHistory.fire) throw new Error("unreachable");
  assert.equal(withHistory.reason, "duplicate_event");
});

test("a zero dedupe window switches deduplication off rather than deduplicating for ever", () => {
  const fired = trigger({ dedupeWindowSec: 0, lastEventKey: "thread-1", lastFiredAt: NOW });
  assert.equal(evaluateTrigger({ trigger: fired, event: email(), now: NOW }).fire, true);
});

test("a firing verdict says how long the repeat is suppressed for", () => {
  const fired = verdict(trigger({ dedupeWindowSec: 1800 }), email());
  assert.equal(fired.fire, true);
  if (!fired.fire) throw new Error("unreachable");
  assert.equal(fired.dedupeUntil.getTime(), NOW.getTime() + 1800 * 1000);
});

test("deduplication is not consulted for an event that never matched", () => {
  // Order matters: recording an unmatched event as a duplicate would suppress
  // the next one that genuinely matches.
  const state = trigger({ config: { from: ["@example.com"] }, lastEventKey: "thread-1", lastFiredAt: NOW });
  const result = verdict(state, email());
  assert.equal(result.fire, false);
  if (result.fire) throw new Error("unreachable");
  assert.equal(result.reason, "filter_unmatched");
});

// ---------------------------------------------------------------------------
// Calendar windows
// ---------------------------------------------------------------------------

test("a meeting inside the lead window fires, and one further out is simply early", () => {
  const state = trigger({ kind: "calendar_window", config: { leadMinutes: 10 } });
  assert.equal(verdict(state, meeting()).fire, true);

  const early = verdict(state, meeting({ startsAt: new Date(NOW.getTime() + 45 * 60_000) }));
  assert.equal(early.fire, false);
  if (early.fire) throw new Error("unreachable");
  // Not `filter_unmatched`: the meeting matches, this is not the moment, and
  // reporting it as a filter failure sends someone to rewrite a correct filter.
  assert.equal(early.reason, "outside_window");
});

test("a meeting that has already started is past being prepared for", () => {
  const state = trigger({ kind: "calendar_window", config: { leadMinutes: 30 } });
  const late = verdict(state, meeting({ startsAt: new Date(NOW.getTime() - 60_000) }));
  assert.equal(late.fire, false);
  if (late.fire) throw new Error("unreachable");
  assert.equal(late.reason, "outside_window");
});

test("a calendar trigger filters on calendar, title, length and whether anyone else is coming", () => {
  const state = trigger({
    kind: "calendar_window",
    config: {
      leadMinutes: 10,
      calendarIds: ["primary"],
      titleContains: ["review"],
      minDurationMinutes: 30,
      requireAttendees: true,
    },
  });
  assert.equal(verdict(state, meeting()).fire, true);
  assert.equal(verdict(state, meeting({ calendarId: "birthdays" })).fire, false);
  assert.equal(verdict(state, meeting({ title: "Lunch" })).fire, false);
  assert.equal(verdict(state, meeting({ endsAt: new Date(NOW.getTime() + 20 * 60_000) })).fire, false);
  assert.equal(verdict(state, meeting({ attendeeCount: 1 })).fire, false);
});

test("the dedupe window is widened to cover the lead window", () => {
  // A two-hour lead with the default one-hour dedupe would brief the same
  // meeting twice: once on the first tick of the window and again an hour in.
  const state = trigger({
    kind: "calendar_window",
    dedupeWindowSec: 3600,
    config: { leadMinutes: 120 },
    lastEventKey: "cal-1",
    lastFiredAt: NOW,
  });
  const soon = new Date(NOW.getTime() + 90 * 60_000);
  const startsAt = new Date(soon.getTime() + 20 * 60_000);
  const second = evaluateTrigger({
    trigger: state,
    event: meeting({ startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) }),
    now: soon,
  });
  assert.equal(second.fire, false);
  if (second.fire) throw new Error("unreachable");
  assert.equal(second.reason, "duplicate_event");
});

// ---------------------------------------------------------------------------
// Topic monitors
// ---------------------------------------------------------------------------

test("a topic monitor honours any-of and all-of, and a minimum number of sources", () => {
  const anyOf = trigger({ kind: "topic_monitor", config: { terms: ["acme", "merger"] } });
  assert.equal(verdict(anyOf, topic()).fire, true);

  const allOf = trigger({ kind: "topic_monitor", config: { terms: ["acme", "merger"], requireAll: true } });
  assert.equal(verdict(allOf, topic()).fire, false);
  assert.equal(verdict(allOf, topic({ matchedTerms: ["Acme", "Merger"] })).fire, true, "case-insensitive");

  const corroborated = trigger({ kind: "topic_monitor", config: { terms: ["acme"], minSources: 3 } });
  assert.equal(verdict(corroborated, topic({ sourceCount: 2 })).fire, false);
  assert.equal(verdict(corroborated, topic({ sourceCount: 3 })).fire, true);
});

// ---------------------------------------------------------------------------
// Connector events
// ---------------------------------------------------------------------------

test("a connector event must come from the named connector and carry the named attributes", () => {
  const state = trigger({
    kind: "connector_event",
    config: {
      connector: "Linear",
      events: ["issue.created", "issue.updated"],
      attributes: { priority: "urgent" },
    },
  });
  assert.equal(verdict(state, connectorEvent()).fire, true);
  assert.equal(verdict(state, connectorEvent({ connector: "github" })).fire, false);
  assert.equal(verdict(state, connectorEvent({ event: "issue.deleted" })).fire, false);
  assert.equal(
    verdict(state, connectorEvent({ attributes: { team: "core", priority: "low" } })).fire,
    false
  );
});

test("a connector trigger with no event list listens to everything that connector sends", () => {
  const state = trigger({ kind: "connector_event", config: { connector: "linear" } });
  assert.equal(verdict(state, connectorEvent({ event: "anything.at.all" })).fire, true);
});

// ---------------------------------------------------------------------------
// Folder changes
// ---------------------------------------------------------------------------

test("folder_change is the local-only trigger kind", () => {
  assert.deepEqual([...LOCAL_ONLY_TRIGGER_KINDS], ["folder_change"]);
});

test("a folder change fires only when the Mac that saw it is opted in and online", () => {
  const state = trigger({ kind: "folder_change", config: { grantId: "grant-1" } });
  assert.equal(verdict(state, folderChange(), { hosts: [host()] }).fire, true);

  for (const [label, unusable] of [
    ["offline", host({ state: "offline" })],
    ["stale", host({ state: "stale" })],
    ["switched off for Work", host({ enabled: false })],
    ["revoked", host({ revoked: true })],
    ["not granted file access", host({ capabilities: [] })],
  ] as const) {
    const refused = verdict(state, folderChange(), { hosts: [unusable] });
    assert.equal(refused.fire, false, label);
    if (refused.fire) throw new Error("unreachable");
    assert.equal(refused.reason, "host_offline", label);
  }
});

test("a folder change refuses when no host list is supplied at all", () => {
  // A caller that forgot the hosts must not accidentally get a local run: the
  // absence of evidence that a Mac is there is not evidence that it is.
  const state = trigger({ kind: "folder_change", config: { grantId: "grant-1" } });
  const refused = verdict(state, folderChange());
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "host_offline");
});

test("a folder change reported by a Mac other than the granted one is refused", () => {
  const state = trigger({ kind: "folder_change", config: { grantId: "grant-1" } });
  const refused = verdict(state, folderChange({ hostId: "host-2" }), { hosts: [host()] });
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "host_offline");
});

test("the host check precedes the filters, so a revoked Mac is not reported as a filter miss", () => {
  const state = trigger({ kind: "folder_change", config: { grantId: "grant-other" } });
  const refused = verdict(state, folderChange(), { hosts: [host({ revoked: true })] });
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "host_offline", "not filter_unmatched, though the grant also differs");
});

test("a folder change filters on suffix and on how many files moved", () => {
  const csvOnly = trigger({
    kind: "folder_change",
    config: { grantId: "grant-1", suffixes: [".csv"], minChangedFiles: 2 },
  });
  assert.equal(verdict(csvOnly, folderChange(), { hosts: [host()] }).fire, false, "one csv, two required");
  assert.equal(
    verdict(csvOnly, folderChange({ changedNames: ["a.CSV", "b.csv", "c.txt"] }), { hosts: [host()] }).fire,
    true
  );

  const wrongFolder = trigger({ kind: "folder_change", config: { grantId: "grant-2" } });
  const refused = verdict(wrongFolder, folderChange(), { hosts: [host()] });
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "filter_unmatched");
});

// ---------------------------------------------------------------------------
// Manual, disabled and mismatched
// ---------------------------------------------------------------------------

test("a manual trigger never fires from an event, whatever arrives", () => {
  const state = trigger({ kind: "manual" });
  const refused = verdict(state, email());
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  // `manual_only` and not `kind_mismatch`: there is no manual event, and
  // reporting a mismatch would read as a misconfiguration rather than as the
  // deliberate "only a person starts this".
  assert.equal(refused.reason, "manual_only");
});

test("a switched-off trigger is reported as switched off, before anything else is considered", () => {
  const state = trigger({ enabled: false, config: { from: ["@nowhere.example"] } });
  const refused = verdict(state, email());
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "disabled");
});

test("an event of the wrong kind is a mismatch, not a filter failure", () => {
  const state = trigger({ kind: "connector_event", config: { connector: "linear" } });
  const refused = verdict(state, email());
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "kind_mismatch");
});

test("a configuration this build cannot read is named as such rather than silently never firing", () => {
  const state = trigger({ kind: "connector_event", config: { events: ["issue.created"] } });
  const refused = verdict(state, connectorEvent());
  assert.equal(refused.fire, false);
  if (refused.fire) throw new Error("unreachable");
  assert.equal(refused.reason, "config_invalid");
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("two dispatchers racing on one delivery mint the same run key", () => {
  const a = triggerRunIdempotencyKey("trg-1", "thread-1", NOW, 3600);
  const b = triggerRunIdempotencyKey("trg-1", "thread-1", new Date(NOW.getTime() + 5_000), 3600);
  assert.equal(a, b);
});

test("a legitimate re-fire a whole window later gets a different key", () => {
  // The dedupe check has already refused anything closer than a window, so the
  // bucket only has to make a genuine repeat distinct — and a gap of at least
  // one window always crosses a bucket boundary.
  const first = triggerRunIdempotencyKey("trg-1", "thread-1", NOW, 3600);
  const later = triggerRunIdempotencyKey("trg-1", "thread-1", new Date(NOW.getTime() + HOUR_MS + 1_000), 3600);
  assert.notEqual(first, later);
});

test("different triggers and different events never share a run key", () => {
  assert.notEqual(
    triggerRunIdempotencyKey("trg-1", "thread-1", NOW, 3600),
    triggerRunIdempotencyKey("trg-2", "thread-1", NOW, 3600)
  );
  assert.notEqual(
    triggerRunIdempotencyKey("trg-1", "thread-1", NOW, 3600),
    triggerRunIdempotencyKey("trg-1", "thread-2", NOW, 3600)
  );
});

// ---------------------------------------------------------------------------
// Writing a trigger set
// ---------------------------------------------------------------------------

/*
 * What gets stored is what the parser produced, not what the client sent. The
 * property is worth pinning because its failure mode is entirely silent: a
 * configuration accepted at write time and refused at fire time is a schedule
 * the user created without complaint and which then never runs.
 */

test("a submitted trigger is stored in the shape the evaluator reads back", () => {
  const drafts = normalizeTriggerDrafts(
    [
      {
        kind: "email_filter",
        // Mixed case and whitespace on the way in; the matcher compares
        // lower-cased, so the stored form has to be lower-cased too.
        config: { from: ["  Accounts@Example.com "], requireAttachment: true, nonsense: 7 },
      },
    ],
    "Europe/Paris"
  );
  assert.equal(drafts.ok, true);
  if (!drafts.ok) throw new Error("unreachable");

  assert.deepEqual(drafts.drafts[0].config.from, ["accounts@example.com"]);
  assert.equal(drafts.drafts[0].config.requireAttachment, true);
  // A key the parser does not know is dropped rather than carried, so nothing
  // downstream can come to depend on a field nothing validates.
  assert.equal("nonsense" in (drafts.drafts[0].config as Record<string, unknown>), false);
});

test("a time trigger is stored as its flat configuration, not as its expansion", () => {
  const drafts = normalizeTriggerDrafts(
    [{ kind: "cron", config: { expression: "*/15 9-17 * * 1-5" } }],
    "Europe/Paris"
  );
  assert.equal(drafts.ok, true);
  if (!drafts.ok) throw new Error("unreachable");
  // Ninety-six expanded minute values would be something the user never wrote
  // and could not edit back into a crontab line.
  assert.deepEqual(drafts.drafts[0].config, { expression: "*/15 9-17 * * 1-5" });
});

test("a bad trigger names which one it was", () => {
  const drafts = normalizeTriggerDrafts(
    [
      { kind: "daily", config: { hour: 9, minute: 0 } },
      { kind: "weekly", config: { hour: 9, minute: 0 } },
    ],
    "Europe/Paris"
  );
  assert.equal(drafts.ok, false);
  if (drafts.ok) throw new Error("unreachable");
  assert.equal(drafts.index, 1);
  assert.match(drafts.message, /weekday/);
});

test("a kind this build does not know is refused rather than stored", () => {
  const drafts = normalizeTriggerDrafts([{ kind: "moon_phase", config: {} }], "Europe/Paris");
  assert.equal(drafts.ok, false);
});

test("a zero dedupe window survives the default", () => {
  // `?? DEFAULT` and `|| DEFAULT` differ by exactly this case, and zero is a
  // legitimate answer: never suppress a repeat.
  const drafts = normalizeTriggerDrafts(
    [{ kind: "manual", config: {}, dedupeWindowSec: 0 }],
    "Europe/Paris"
  );
  assert.equal(drafts.ok, true);
  if (!drafts.ok) throw new Error("unreachable");
  assert.equal(drafts.drafts[0].dedupeWindowSec, 0);

  const defaulted = normalizeTriggerDrafts([{ kind: "manual", config: {} }], "Europe/Paris");
  assert.equal(defaulted.ok, true);
  if (!defaulted.ok) throw new Error("unreachable");
  assert.equal(defaulted.drafts[0].dedupeWindowSec, DEFAULT_DEDUPE_WINDOW_SEC);
});

test("every event kind round-trips through storage unchanged", () => {
  for (const kind of EVENT_TRIGGER_KINDS) {
    const first = parseTriggerConfig(kind, { connector: "gmail", grantId: "gr-1" });
    assert.equal(first.ok, true, kind);
    if (!first.ok) throw new Error("unreachable");
    const stored = configForEventTrigger(first.parsed);
    const second = parseTriggerConfig(kind, stored);
    assert.equal(second.ok, true, kind);
    if (!second.ok) throw new Error("unreachable");
    // Re-reading what was written must produce the same configuration, or a
    // schedule quietly means something different after its first edit.
    assert.deepEqual(configForEventTrigger(second.parsed), stored, kind);
  }
});

// ---------------------------------------------------------------------------
// Deciding whether an edit changed anything
// ---------------------------------------------------------------------------

const STORED_DAILY = { kind: "daily", config: { hour: 9, minute: 0 }, enabled: true, dedupeWindowSec: 3600 };

function draftsFor(inputs: Parameters<typeof normalizeTriggerDrafts>[0]) {
  const result = normalizeTriggerDrafts(inputs, "Europe/Paris");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.drafts;
}

test("re-sending the same trigger set is not a change", () => {
  // Every form in this codebase re-sends the whole object on save. If this
  // returned false, renaming a schedule would move its next fire and an overdue
  // run would be discarded — the legacy bug, reintroduced through the back door.
  assert.equal(
    sameTriggerSet([STORED_DAILY], draftsFor([{ kind: "daily", config: { hour: 9, minute: 0 } }])),
    true
  );
});

test("key order in a stored configuration is not a change", () => {
  assert.equal(
    sameTriggerSet(
      [{ ...STORED_DAILY, config: { minute: 0, hour: 9 } }],
      draftsFor([{ kind: "daily", config: { hour: 9, minute: 0 } }])
    ),
    true
  );
});

test("a different hour, a different kind, a pause, or an extra trigger all count as changes", () => {
  assert.equal(
    sameTriggerSet([STORED_DAILY], draftsFor([{ kind: "daily", config: { hour: 10, minute: 0 } }])),
    false
  );
  assert.equal(
    sameTriggerSet([STORED_DAILY], draftsFor([{ kind: "weekdays", config: { hour: 9, minute: 0 } }])),
    false
  );
  assert.equal(
    sameTriggerSet(
      [STORED_DAILY],
      draftsFor([{ kind: "daily", config: { hour: 9, minute: 0 }, enabled: false }])
    ),
    false
  );
  assert.equal(
    sameTriggerSet(
      [STORED_DAILY],
      draftsFor([
        { kind: "daily", config: { hour: 9, minute: 0 } },
        { kind: "weekly", config: { weekday: 1, hour: 17, minute: 0 } },
      ])
    ),
    false
  );
});
