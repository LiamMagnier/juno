import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  CHAT_FAILURE_RATE_KIND,
  DEFAULT_FAILURE_ALERT_TUNABLES,
  breachedFailureGroups,
  createFailureAlertState,
  failureAlertInput,
  failureAlertTunables,
  newIncidents,
  type TurnOutcomeCount,
} from "@/lib/router/failure-alert-rules";

/*
 * The chat failure-rate alert (src/lib/router/failure-alert-rules.ts and
 * failure-alert.ts): N failed saved-chat turns of one model or one failure
 * class within the window mail the operator once. The counts are read from
 * RoutingOutcome (tests/router-telemetry.integration.test.ts runs that query
 * against a real database); here the reader is a fake and no mail is sent.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/alerts") return { alertOperator: () => "queued" };
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { createFailureRateWatch } = req("../src/lib/router/failure-alert") as typeof import("@/lib/router/failure-alert");
mod._load = origLoad;

const T = DEFAULT_FAILURE_ALERT_TUNABLES;
const row = (modelId: string, total: number, error: number, network = 0, provider = modelId.split(":")[0]): TurnOutcomeCount => ({
  modelId,
  provider,
  total,
  failed: { error, network_error: network },
});

test("the numbers come from env with conservative defaults and bounds", () => {
  assert.deepEqual(failureAlertTunables({}), { enabled: true, threshold: 5, windowMs: 600_000, minSharePercent: 20 });
  assert.deepEqual(
    failureAlertTunables({
      CHAT_FAILURE_ALERT_THRESHOLD: "1",
      CHAT_FAILURE_ALERT_WINDOW_MINUTES: "999",
      CHAT_FAILURE_ALERT_MIN_SHARE_PERCENT: "-5",
    }),
    { enabled: true, threshold: 2, windowMs: 120 * 60_000, minSharePercent: 0 },
    "one failure can never page; the window and share are clamped"
  );
  assert.deepEqual(failureAlertTunables({ CHAT_FAILURE_ALERT_THRESHOLD: "many" }), failureAlertTunables({}));
  for (const off of ["off", "0", "false", "NO"]) assert.equal(failureAlertTunables({ CHAT_FAILURE_ALERT: off }).enabled, false);
  assert.equal(failureAlertTunables({ CHAT_FAILURE_ALERT: "on" }).enabled, true);
});

test("one model with N failures that are a real share of its turns is an incident", () => {
  assert.deepEqual(breachedFailureGroups([row("qwen:qwen3.8-flash", 6, 5)], T), [
    { key: "model:qwen:qwen3.8-flash", kind: "model", subject: "qwen:qwen3.8-flash", provider: "qwen", failed: 5, total: 6 },
    // The only model is also the whole class: both are named, and one mail carries both.
    { key: "class:error", kind: "class", subject: "error", provider: null, failed: 5, total: 6 },
  ]);
  assert.deepEqual(breachedFailureGroups([row("qwen:a", 6, 4)], T), [], "below the threshold");
  // Five failures among a hundred busy turns are weather, not an outage.
  assert.deepEqual(breachedFailureGroups([row("openai:busy", 100, 5)], T).filter((g) => g.kind === "model"), []);
  assert.equal(breachedFailureGroups([row("openai:busy", 100, 5)], { ...T, minSharePercent: 0 }).length > 0, true);
  // Errors and dropped connections both count toward the model.
  assert.equal(breachedFailureGroups([row("anthropic:x", 8, 3, 2)], T)[0]?.failed, 5);
});

test("one failure class across every model is an incident even when no single model is", () => {
  const groups = breachedFailureGroups([row("a:1", 3, 0, 2), row("b:2", 3, 0, 2), row("c:3", 3, 0, 2)], T);
  assert.deepEqual(groups, [
    { key: "class:network_error", kind: "class", subject: "network_error", provider: null, failed: 6, total: 9 },
  ]);
  // Models come first, worst first, then the classes.
  const mixed = breachedFailureGroups([row("a:1", 5, 5), row("b:2", 9, 9)], T);
  assert.deepEqual(mixed.map((g) => g.key), ["model:b:2", "model:a:1", "class:error"]);
});

test("an incident mails once while it lasts, and again only after it ended", () => {
  const state = createFailureAlertState();
  const outage = breachedFailureGroups([row("qwen:a", 6, 6)], T);
  assert.deepEqual(newIncidents(state, outage, 0, T.windowMs).map((g) => g.key), ["model:qwen:a", "class:error"]);
  assert.deepEqual(newIncidents(state, outage, 60_000, T.windowMs), [], "still the same incident");
  assert.deepEqual(newIncidents(state, outage, 650_000, T.windowMs), [], "seen within one window of the last sighting");
  // A second model breaking during the outage is news.
  const worse = breachedFailureGroups([row("qwen:a", 6, 6), row("qwen:b", 5, 5)], T);
  assert.deepEqual(newIncidents(state, worse, 700_000, T.windowMs).map((g) => g.key), ["model:qwen:b"]);
  // Recovered (no longer in breach): the next breach is a new incident.
  assert.deepEqual(newIncidents(state, [], 800_000, T.windowMs), []);
  assert.deepEqual(newIncidents(state, outage, 810_000, T.windowMs).map((g) => g.key), ["model:qwen:a", "class:error"]);
  // Not seen for longer than a window (no failure woke the watch): new incident.
  assert.deepEqual(newIncidents(state, outage, 810_000 + T.windowMs + 1, T.windowMs).length, 2);
});

test("every new incident of an evaluation goes out as one alert, with counts and ids only", () => {
  const incidents = breachedFailureGroups([row("qwen:qwen3.8-flash", 7, 7)], T);
  const alert = failureAlertInput(incidents, T, { billing: 7 });
  assert.ok(alert);
  assert.equal(alert.kind, CHAT_FAILURE_RATE_KIND);
  assert.equal(alert.key, "model:qwen:qwen3.8-flash", "the dedupe subject is the worst group");
  assert.equal(alert.title, "Chat turns failing: 7 of 7 on qwen:qwen3.8-flash in 10 min (and 1 more)");
  assert.equal(alert.severity, "critical");
  assert.deepEqual(alert.detail.incidents, [
    { group: "model:qwen:qwen3.8-flash", provider: "qwen", failed: 7, turns: 7 },
    { group: "class:error", failed: 7, turns: 7 },
  ]);
  assert.deepEqual(alert.detail.errorClassesSeenByThisProcess, { billing: 7 });
  const text = JSON.stringify(alert);
  assert.doesNotMatch(text, /user|conversation|message|@/i);
  assert.equal(failureAlertInput([], T), null);
  const classOnly = failureAlertInput(breachedFailureGroups([row("a:1", 3, 3), row("b:2", 3, 3)], T), T);
  assert.equal(classOnly?.title, "Chat turns failing: 6 of 6 on error on every model in 10 min");
});

/** A fake clock and timer queue for the watch. */
function harness(counts: () => TurnOutcomeCount[] | Promise<TurnOutcomeCount[]>) {
  let now = 1_000_000;
  const timers: Array<{ at: number; run: () => void }> = [];
  const alerts: Array<{ kind: string; key?: string; title: string; detail?: Record<string, unknown> }> = [];
  const reads: Date[] = [];
  const watch = createFailureRateWatch({
    readCounts: async (since) => {
      reads.push(since);
      return counts();
    },
    alert: (input) => {
      alerts.push(input);
      return "queued";
    },
    now: () => now,
    setTimer: (run, ms) => {
      timers.push({ at: now + ms, run });
      return { unref() {} };
    },
    env: {},
    settleMs: 3_000,
    minIntervalMs: 30_000,
  });
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { watch, alerts, reads, timers, advance, now: () => now };
}

test("the watch waits for the rows, coalesces a burst, reads the window and mails once", async () => {
  let counts = [row("qwen:a", 6, 6)];
  const h = harness(() => counts);
  for (let i = 0; i < 6; i += 1) h.watch.noteFailedTurn({ modelId: "qwen:a", errorClass: "billing" });
  assert.equal(h.timers.length, 1, "a burst of failures schedules one evaluation");
  await h.advance(2_999);
  assert.equal(h.reads.length, 0, "it waits for the turn's outcome row to land");
  await h.advance(1);
  assert.equal(h.reads.length, 1);
  assert.equal(h.now() - h.reads[0].getTime(), 600_000, "it counts the last ten minutes");
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].key, "model:qwen:a");
  assert.deepEqual(h.alerts[0].detail?.errorClassesSeenByThisProcess, { billing: 6 });

  // More failures during the same outage: evaluated (at most every 30 s), never re-mailed.
  h.watch.noteFailedTurn({ modelId: "qwen:a", errorClass: "billing" });
  await h.advance(3_000);
  assert.equal(h.reads.length, 1, "throttled: the last evaluation was under 30 s ago");
  await h.advance(27_000);
  assert.equal(h.reads.length, 2);
  assert.equal(h.alerts.length, 1, "the same incident mails once");

  // It ends, and much later a new outage starts: a new mail.
  counts = [];
  h.watch.noteFailedTurn();
  await h.advance(30_000);
  counts = [row("qwen:a", 5, 5)];
  h.watch.noteFailedTurn();
  await h.advance(30_000);
  assert.equal(h.alerts.length, 2);
});

test("switched off, the watch never reads the database", async () => {
  let reads = 0;
  const watch = createFailureRateWatch({
    readCounts: async () => {
      reads += 1;
      return [row("qwen:a", 9, 9)];
    },
    alert: () => assert.fail("no alert while off"),
    env: { CHAT_FAILURE_ALERT: "off" },
  });
  assert.deepEqual(await watch.evaluate(), []);
  assert.equal(reads, 0);
});

test("a count that cannot be read alerts nobody, never throws, and the next failure tries again", async () => {
  let fail = true;
  const h = harness(() => {
    if (fail) throw new Error("database unreachable");
    return [row("qwen:a", 5, 5)];
  });
  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    h.watch.noteFailedTurn();
    await h.advance(3_000);
    assert.equal(h.alerts.length, 0);
    assert.equal(warned.length, 1);
    fail = false;
    h.watch.noteFailedTurn();
    await h.advance(30_000);
    assert.equal(h.alerts.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("a quiet process never reads: only a failed saved turn wakes the watch", () => {
  const sink = readFileSync(path.join(process.cwd(), "src/lib/chat/turn/trace-sink.ts"), "utf8");
  assert.match(sink, /if \(trace\.outcome === "failed" && trace\.surface === "saved"\) \{/);
  assert.match(sink, /void import\("@\/lib\/router\/failure-alert"\)/, "loaded on the first failure, never on a healthy turn");
  assert.match(sink, /chatFailureRateWatch\(\)\.noteFailedTurn\(note\)/);
  assert.doesNotMatch(sink, /setInterval/);
  const alerts = readFileSync(path.join(process.cwd(), "src/lib/alerts.ts"), "utf8");
  assert.match(alerts, /export \{ CHAT_FAILURE_RATE_KIND as CHAT_FAILURE_ALERT_KIND \}/);
});

test("every number this package added is in .env.example and listed for the owner to confirm", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const example = read(".env.example");
  const decisions = read("docs/OPEN_DECISIONS.md");
  for (const name of [
    "MCP_CONNECT_TIMEOUT_MS",
    "MCP_TOOL_LIST_CACHE_SECONDS",
    "CHAT_FAILURE_ALERT",
    "CHAT_FAILURE_ALERT_THRESHOLD",
    "CHAT_FAILURE_ALERT_WINDOW_MINUTES",
    "CHAT_FAILURE_ALERT_MIN_SHARE_PERCENT",
  ]) {
    assert.match(example, new RegExp(`# ${name}="`), name);
    assert.match(decisions, new RegExp(name), name);
  }
  assert.match(decisions, /## 15\. Speed and observability[^\n]*owner to confirm/);
});
