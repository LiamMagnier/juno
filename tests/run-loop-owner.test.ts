import assert from "node:assert/strict";
import test from "node:test";

import { createAnnouncerQueue, researchAnnouncementKey } from "@/lib/run/announcer";
import type { PacerClock } from "@/lib/run/pacer";
import {
  announceRun,
  claimLoop,
  clearResearchPhase,
  getRunPhase,
  loopOwner,
  publishResearchPhase,
  researchPhases,
  resetRunStoreForTests,
  setRunPhase,
  subscribeLoopOwner,
  subscribeRunAnnouncements,
} from "@/lib/run/store";

/*
 * One loop owner on screen (SPEC §7.9.1, DECISIONS U2), and the shared client
 * stores beside it: the phase per message, the Research phases the announcer
 * speaks, and the announcer's own spacing.
 */

test("priority 1 wins; ties go to the newest claim", () => {
  resetRunStoreForTests();
  const releaseResearch = claimLoop("research:1", 4);
  assert.equal(loopOwner(), "research:1");
  const releaseCard = claimLoop("card:1", 3);
  assert.equal(loopOwner(), "card:1");
  const releaseLine = claimLoop("line:1", 2);
  assert.equal(loopOwner(), "line:1", "the chat line beats the artifact card");
  const releasePanel = claimLoop("panel:row", 1);
  assert.equal(loopOwner(), "panel:row", "the open panel's live item beats the line");
  const releaseLine2 = claimLoop("line:2", 2);
  assert.equal(loopOwner(), "panel:row");
  releasePanel();
  assert.equal(loopOwner(), "line:2", "released: the newest claim at the next priority");
  releaseLine2();
  assert.equal(loopOwner(), "line:1");
  releaseLine();
  releaseCard();
  assert.equal(loopOwner(), "research:1");
  releaseResearch();
  assert.equal(loopOwner(), null);
});

test("two live Research rows never loop together: the newer one owns", () => {
  resetRunStoreForTests();
  const a = claimLoop("research:a", 4);
  const b = claimLoop("research:b", 4);
  assert.equal(loopOwner(), "research:b");
  b();
  assert.equal(loopOwner(), "research:a");
  a();
});

test("a stale release cannot drop a newer claim under the same id; a re-claim is the newest", () => {
  resetRunStoreForTests();
  const first = claimLoop("line:1", 2);
  const other = claimLoop("line:2", 2);
  assert.equal(loopOwner(), "line:2");
  const second = claimLoop("line:1", 2);
  assert.equal(loopOwner(), "line:1", "re-claiming makes it the most recent");
  first();
  assert.equal(loopOwner(), "line:1", "the stale release did nothing");
  second();
  assert.equal(loopOwner(), "line:2");
  other();
});

test("exactly one owner at any time, and subscribers hear each change once", () => {
  resetRunStoreForTests();
  let changes = 0;
  const unsubscribe = subscribeLoopOwner(() => {
    changes += 1;
  });
  const releases = [claimLoop("a", 3), claimLoop("b", 2), claimLoop("c", 2), claimLoop("d", 4)];
  assert.equal(loopOwner(), "c");
  assert.equal(changes, 3, "a, then b, then c; d changed nothing");
  for (const release of releases) {
    release();
    const owner = loopOwner();
    assert.ok(owner === null || typeof owner === "string");
  }
  assert.equal(loopOwner(), null);
  unsubscribe();
});

test("the phase store is keyed by renderKey and ignores a repeated object", () => {
  resetRunStoreForTests();
  const phase = { phase: "thinking" as const, stalled: false, calm: false, escalation: 0 as const, reveal: "label" as const };
  setRunPhase("m1", phase);
  assert.equal(getRunPhase("m1"), phase);
  assert.equal(getRunPhase("m2"), null);
  setRunPhase("m1", null);
  assert.equal(getRunPhase("m1"), null);
});

test("Research rows publish their phase; republishing the same phase is a no-op", () => {
  resetRunStoreForTests();
  publishResearchPhase("run_a", "planning");
  publishResearchPhase("run_b", "searching");
  publishResearchPhase("run_a", "planning");
  publishResearchPhase("run_a", "awaiting_start");
  assert.deepEqual(researchPhases().map((p) => [p.runId, p.phase]), [["run_b", "searching"], ["run_a", "awaiting_start"]]);
  clearResearchPhase("run_b");
  assert.deepEqual(researchPhases().map((p) => p.runId), ["run_a"]);
});

test("run announcements reach subscribers with their message's key", () => {
  const heard: string[] = [];
  const unsubscribe = subscribeRunAnnouncements((key, a) => heard.push(`${key}:${a.text}`));
  announceRun("m1", { key: "k", text: "Thinking" });
  unsubscribe();
  announceRun("m1", { key: "k2", text: "late" });
  assert.deepEqual(heard, ["m1:Thinking"]);
});

// ── The announcer's spacing ──────────────────────────────────────────────────

function clock(): PacerClock & { advance(ms: number): void } {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  return {
    now: () => t,
    setTimeout(fn, ms) {
      ids += 1;
      timers.push({ at: t + ms, fn, id: ids });
      return ids;
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        t = due.at;
        due.fn();
      }
      t = until;
    },
  };
}

test("announcements are 3 s apart, the newest waiting one wins, urgent ones jump the queue", () => {
  const c = clock();
  const said: Array<[number, string]> = [];
  const queue = createAnnouncerQueue((text) => said.push([c.now(), text]), { clock: c });
  queue.push({ key: "thinking", text: "Thinking", once: true });
  queue.push({ key: "search", text: "Searching the web" });
  queue.push({ key: "read", text: "Reading sources" });
  c.advance(3_000);
  assert.deepEqual(said, [[0, "Thinking"], [3_000, "Reading sources"]], "the overtaken boundary was dropped");
  queue.push({ key: "tool", text: "Running code" });
  c.advance(1_000);
  queue.push({ key: "waiting", text: "Waiting for your approval", urgent: true });
  assert.deepEqual(said.at(-1), [4_000, "Waiting for your approval"]);
  c.advance(10_000);
  assert.equal(said.length, 3, "the urgent line superseded the pending one");
  queue.push({ key: "thinking", text: "Thinking", once: true });
  c.advance(5_000);
  assert.equal(said.length, 3, "Thinking is said once per run");
  queue.dispose();
});

test("Research phases announce the plan once, start, pause, writing and the end", () => {
  assert.equal(researchAnnouncementKey("r", null, "planning"), null);
  assert.deepEqual(researchAnnouncementKey("r", "planning", "awaiting_start"), { key: "research:r:plan", copy: "announcePlanReady", once: true });
  assert.equal(researchAnnouncementKey("r", "awaiting_start", "searching")?.copy, "announceResearchStarted");
  // Searching → reading is the same "started" line, which `once` keeps from repeating.
  assert.equal(researchAnnouncementKey("r", "searching", "reading")?.key, "research:r:started");
  assert.equal(researchAnnouncementKey("r", "paused", "searching")?.key, "research:r:resumed");
  assert.equal(researchAnnouncementKey("r", "searching", "paused")?.copy, "announceResearchPaused");
  assert.equal(researchAnnouncementKey("r", "reviewing", "writing")?.copy, "announceWritingReport");
  assert.deepEqual(researchAnnouncementKey("r", "checking", "done"), {
    key: "research:r:done",
    copy: "announceReportReady",
    urgent: true,
    once: true,
  });
  assert.equal(researchAnnouncementKey("r", "writing", "failed")?.urgent, true);
  assert.equal(researchAnnouncementKey("r", "writing", "writing"), null);
});
