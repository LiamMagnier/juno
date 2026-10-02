import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  WATCH_HIDDEN_MS,
  WATCH_VISIBLE_MS,
  createCompletionWatch,
  finishedKind,
  readyTitleKey,
  type CompletionWatchEnv,
} from "@/components/research/completion-watch";
import type { ResearchFinishedDetail } from "@/components/research/research-discovery";
import { NOTIFY_ASKED_KEY, markNotifyAsked, notifyAsked, notifyPromptVisible } from "@/components/research/scope-draft";
import type { ResearchPhase, ResearchRunSummary } from "@/types/research";
import type { ResearchState } from "@/lib/research/domain";

/*
 * The completion watcher's transitions (SPEC §9.8, DECISIONS R7), against a
 * fake title-override store, fake timers and a fake route: a finish the
 * watcher SAW is noticed once — the tab title while the reader is away (and
 * cleared once they are back on the conversation), a toast when they are
 * elsewhere, a notification only when hidden and granted — and every finish
 * is announced so the open conversation refetches. The notify line is asked
 * once, ever.
 */

const root = path.resolve(__dirname, "..");

test("the watcher's rules keep server-only out of their static graph", () => {
  const source = readFileSync(path.join(root, "src/components/research/completion-watch.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source, /^import (?!type )/m, "types only: everything the browser provides is injected");
});

const PHASE: Record<string, ResearchPhase> = {
  investigating: "searching",
  completed: "done",
  partially_completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

function summary(id: string, state: ResearchState, patch: Partial<ResearchRunSummary> = {}): ResearchRunSummary {
  const live = !["completed", "partially_completed", "failed", "cancelled"].includes(state);
  return {
    id,
    conversationId: `conv-${id}`,
    state,
    phase: PHASE[state] ?? "searching",
    title: `Report ${id}`,
    createdAt: "2026-09-24T10:00:00.000Z",
    finishedAt: live ? null : "2026-09-24T10:30:00.000Z",
    live,
    assistantMessageId: live ? null : `msg-${id}`,
    ...patch,
  };
}

function harness(opts: { hidden?: boolean; route?: string | null; permission?: string | null; now?: number } = {}) {
  const titles = new Map<string, string>();
  const toasts: string[] = [];
  const notified: string[] = [];
  const finished: ResearchFinishedDetail[] = [];
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  const state = { hidden: opts.hidden ?? false, route: opts.route ?? null, answers: [] as Array<ResearchRunSummary[] | null> };
  const env: CompletionWatchEnv = {
    fetchLiveRuns: async () => (state.answers.length ? state.answers.shift()! : []),
    now: () => opts.now ?? Date.parse("2026-09-24T10:00:00.000Z"),
    setTimeout: (fn, ms) => {
      const timer = { ms, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    hidden: () => state.hidden,
    activeConversationId: () => state.route,
    // The fake title-override store: the same contract as src/lib/title-override.ts.
    setTitleOverride: (key, text) => {
      if (text === null) titles.delete(key);
      else titles.set(key, text);
    },
    readyTitle: (run) => `Report ready · ${run.title}`,
    toast: (kind, run) => toasts.push(`${kind}:${run.id}`),
    notificationPermission: () => (opts.permission === undefined ? "granted" : opts.permission),
    notify: (run) => notified.push(run.id),
    finished: (detail) => finished.push(detail),
  };
  const watch = createCompletionWatch(env);
  const pending = () => timers.filter((t) => !t.cleared);
  return { watch, state, titles, toasts, notified, finished, pending };
}

test("a terminal state reads as a report, a failure or a stop", () => {
  assert.equal(finishedKind({ state: "completed" }), "ready");
  assert.equal(finishedKind({ state: "partially_completed" }), "ready");
  assert.equal(finishedKind({ state: "failed" }), "failed");
  assert.equal(finishedKind({ state: "cancelled" }), "stopped");
  assert.equal(finishedKind({ state: "investigating" }), null);
});

test("the first answer is the baseline: a report that was already ready is not news", () => {
  const h = harness({ hidden: true });
  h.watch.apply([summary("a", "completed")]);
  assert.equal(h.titles.size, 0);
  assert.deepEqual(h.finished, []);
  assert.deepEqual(h.notified, []);
});

test("finished while the tab was hidden: title, notification, and the finish is announced", () => {
  const h = harness({ hidden: true, route: "conv-a" });
  h.watch.apply([summary("a", "investigating")]);
  h.watch.apply([summary("a", "completed")]);
  assert.equal(h.titles.get(readyTitleKey("a")), "Report ready · Report a");
  assert.deepEqual(h.notified, ["a"]);
  // Hidden on the run's own conversation: no toast, they will see the message on return.
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.finished, [{ runId: "a", conversationId: "conv-a", state: "completed", assistantMessageId: "msg-a" }]);

  // The tab comes back on that conversation: the title comes off.
  h.state.hidden = false;
  h.watch.sync();
  assert.equal(h.titles.size, 0);
});

test("finished while the reader is on another conversation: title and toast, cleared when they open it", () => {
  const h = harness({ hidden: false, route: "conv-other" });
  h.watch.apply([summary("a", "investigating")]);
  h.watch.apply([summary("a", "completed")]);
  assert.ok(h.titles.has(readyTitleKey("a")));
  assert.deepEqual(h.toasts, ["ready:a"]);
  assert.deepEqual(h.notified, [], "no notification while the tab is visible");
  h.watch.sync();
  assert.ok(h.titles.has(readyTitleKey("a")), "still elsewhere: the title stays");
  h.state.route = "conv-a";
  h.watch.sync();
  assert.equal(h.titles.size, 0);
});

test("finished while the reader is looking at it: nothing but the refetch signal", () => {
  const h = harness({ hidden: false, route: "conv-a" });
  h.watch.apply([summary("a", "investigating")]);
  h.watch.apply([summary("a", "completed")]);
  assert.equal(h.titles.size, 0);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.notified, []);
  assert.equal(h.finished.length, 1);
});

test("a notification needs the reader's permission", () => {
  const h = harness({ hidden: true, permission: "default" });
  h.watch.apply([summary("a", "investigating")]);
  h.watch.apply([summary("a", "completed")]);
  assert.deepEqual(h.notified, []);
  assert.ok(h.titles.has(readyTitleKey("a")));
});

test("a failure toasts once, sets no title and sends no notification; a stop is only announced", () => {
  const h = harness({ hidden: true, route: "conv-x" });
  h.watch.apply([summary("f", "investigating"), summary("s", "investigating")]);
  h.watch.apply([summary("f", "failed"), summary("s", "cancelled")]);
  assert.deepEqual(h.toasts, ["failed:f"]);
  assert.equal(h.titles.size, 0);
  assert.deepEqual(h.notified, []);
  assert.deepEqual(h.finished.map((d) => [d.runId, d.state]), [["f", "failed"], ["s", "cancelled"]]);
  // Seen again: not news twice.
  h.watch.apply([summary("f", "failed"), summary("s", "cancelled")]);
  assert.equal(h.finished.length, 2);
  assert.deepEqual(h.toasts, ["failed:f"]);
});

test("a run that started and finished between two polls is still noticed; one from before the watcher is not", () => {
  const h = harness({ hidden: true, now: Date.parse("2026-09-24T10:10:00.000Z") });
  h.watch.start();
  h.watch.apply([]);
  h.watch.apply([
    summary("quick", "completed", { finishedAt: "2026-09-24T10:12:00.000Z" }),
    summary("older", "completed", { finishedAt: "2026-09-24T10:05:00.000Z" }),
  ]);
  assert.deepEqual(h.finished.map((d) => d.runId), ["quick"]);
});

test("polls every 20 s while visible, 60 s while hidden, and stops when nothing is live", async () => {
  const h = harness({ hidden: false });
  h.state.answers.push([summary("a", "investigating")]);
  h.watch.start();
  await h.watch.poll();
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, WATCH_VISIBLE_MS);

  h.state.hidden = true;
  h.state.answers.push([summary("a", "investigating")]);
  const timer = h.pending()[0];
  timer.cleared = true;
  timer.fn();
  await h.watch.poll();
  assert.equal(h.pending().at(-1)?.ms, WATCH_HIDDEN_MS);

  h.state.answers.push([summary("a", "completed")]);
  const next = h.pending().at(-1)!;
  next.cleared = true;
  next.fn();
  await h.watch.poll();
  assert.equal(h.pending().length, 0, "nothing live: no timer");
  assert.equal(h.finished.length, 1);
});

test("a failed first poll tries again at the slow cadence", async () => {
  const h = harness({ hidden: false });
  h.state.answers.push(null);
  h.watch.start();
  await h.watch.poll();
  assert.equal(h.pending().length, 1);
});

test("dispose stops polling and takes its titles off the tab", () => {
  const h = harness({ hidden: true });
  h.watch.apply([summary("a", "investigating")]);
  h.watch.apply([summary("a", "completed")]);
  assert.equal(h.titles.size, 1);
  h.watch.dispose();
  assert.equal(h.titles.size, 0);
});

test("the notify line is asked once, ever (R7)", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  const firstCard = notifyPromptVisible({ minutesUpTo: 14, permission: "default", asked: notifyAsked(storage) });
  assert.equal(firstCard, true);
  markNotifyAsked(storage);
  assert.equal(map.get(NOTIFY_ASKED_KEY), "1");
  const secondCard = notifyPromptVisible({ minutesUpTo: 40, permission: "default", asked: notifyAsked(storage) });
  assert.equal(secondCard, false);
});
