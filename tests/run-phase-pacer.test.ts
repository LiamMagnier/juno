import assert from "node:assert/strict";
import test from "node:test";

import { RUN_PACING } from "@/lib/motion";
import { createPhasePacer, type PacerClock } from "@/lib/run/pacer";
import { derivePhase, phaseForTool } from "@/lib/run/phase";
import type { PacedPhase, PhaseInputs, PhaseState } from "@/lib/run/types";
import { buildRunView } from "@/lib/run/timeline";

import { T0, at, call, message, row, segmentRow, toolRow } from "./fixtures/run-events";

/*
 * Which phase a chat run is in, and when the line may say so (SPEC §7.3).
 */

// ── A fake clock ─────────────────────────────────────────────────────────────

function fakeClock(): PacerClock & { advance(ms: number): void; t: number } {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const clock = {
    get t() {
      return t;
    },
    now: () => t,
    setTimeout(fn: () => void, ms: number) {
      ids += 1;
      timers.push({ at: t + ms, fn, id: ids });
      return ids;
    },
    clearTimeout(handle: unknown) {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    advance(ms: number) {
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
  return clock;
}

function pacer() {
  const clock = fakeClock();
  const shown: Array<PacedPhase & { t: number }> = [];
  const p = createPhasePacer((state) => shown.push({ ...state, t: clock.now() }), undefined, clock);
  const state = (phase: PhaseState["phase"], extra: Partial<PhaseState> = {}): PhaseState => ({
    phase,
    stalled: false,
    calm: false,
    escalation: 0,
    ...extra,
  });
  return { clock, shown, push: (s: PhaseState) => p.push(s), state, last: () => shown[shown.length - 1], dispose: () => p.dispose() };
}

test("nothing before 150 ms, the glyph at 150, the label at 400", () => {
  const { clock, shown, push, state, last } = pacer();
  push(state("thinking"));
  assert.equal(shown.length, 0);
  clock.advance(149);
  assert.equal(shown.length, 0);
  clock.advance(1);
  assert.equal(last().reveal, "glyph");
  assert.equal(last().t, 150);
  clock.advance(249);
  assert.equal(last().reveal, "glyph");
  clock.advance(1);
  assert.equal(last().reveal, "label");
  assert.equal(last().t, 400);
});

test("a fast answer never flashes Thinking: the settled phases skip the wait", () => {
  const { clock, shown, push, state } = pacer();
  push(state("thinking"));
  clock.advance(100);
  push(state("answering"));
  assert.deepEqual(shown.map((s) => [s.phase, s.reveal]), [["answering", "label"]]);
  clock.advance(1_000);
  assert.equal(shown.length, 1, "no stale timer shows thinking later");
});

test("a shown label stays 600 ms and changes are 700 ms apart; the newest phase wins", () => {
  const { clock, shown, push, state, last } = pacer();
  push(state("thinking"));
  clock.advance(400);
  assert.equal(last().phase, "thinking");
  push(state("searching", { subjectKey: "a" }));
  clock.advance(100);
  push(state("reading", { subjectKey: "b" }));
  clock.advance(100);
  push(state("tool", { subjectKey: "c" }));
  assert.equal(last().phase, "thinking", "held until the dwell is over");
  clock.advance(499);
  assert.equal(last().phase, "thinking");
  clock.advance(1);
  assert.equal(last().phase, "tool", "intermediate phases were dropped, never queued");
  assert.equal(last().t, 1_100);
  assert.deepEqual([...new Set(shown.map((s) => s.phase))], ["thinking", "tool"]);
});

test("waiting skips the dwell", () => {
  const { clock, push, state, last } = pacer();
  push(state("thinking"));
  clock.advance(450);
  push(state("waiting", { subjectKey: "call_1" }));
  assert.equal(last().phase, "waiting");
  assert.equal(last().t, 450);
});

test("a new subject in the same phase swaps at most every 1.5 s; the facts update meanwhile", () => {
  const { clock, push, state, last } = pacer();
  push(state("searching", { subjectKey: "q1" }));
  clock.advance(400);
  assert.equal(last().subjectKey, "q1");
  clock.advance(300);
  push(state("searching", { subjectKey: "q2", calm: true }));
  assert.equal(last().subjectKey, "q1");
  assert.equal(last().calm, true, "the calm updates in place");
  clock.advance(1_199);
  assert.equal(last().subjectKey, "q1");
  clock.advance(1);
  assert.equal(last().subjectKey, "q2");
  assert.equal(last().t, 1_900, "1.5 s after the label was shown at 400");
});

test("a count under the same identity updates in place, without a swap", () => {
  const { clock, shown, push, state, last } = pacer();
  push(state("reading", { subjectKey: "batch:r1", coalesced: 2 }));
  clock.advance(400);
  const swaps = shown.length;
  push(state("reading", { subjectKey: "batch:r1", coalesced: 3 }));
  assert.equal(last().coalesced, 3);
  assert.equal(last().t, 400);
  assert.equal(shown.length, swaps + 1);
});

test("re-entry after answering owes no dwell", () => {
  const { clock, push, state, last } = pacer();
  push(state("thinking"));
  clock.advance(500);
  push(state("answering"));
  clock.advance(50);
  push(state("searching", { subjectKey: "late" }));
  assert.equal(last().phase, "searching");
  assert.equal(last().t, 550);
});

test("a disposed pacer shows nothing more", () => {
  const { clock, shown, push, state, dispose } = pacer();
  push(state("thinking"));
  dispose();
  clock.advance(1_000);
  push(state("done"));
  assert.equal(shown.length, 0);
});

// ── derivePhase ──────────────────────────────────────────────────────────────

function live(extra: Partial<PhaseInputs> = {}): PhaseInputs {
  return {
    streaming: true,
    error: false,
    finishReason: null,
    answerStarted: false,
    lastEventAt: T0,
    now: T0,
    startedAt: T0,
    ...extra,
  };
}

test("rule 1: the stream is over", () => {
  const view = buildRunView(message([]));
  assert.equal(derivePhase(view, live({ streaming: false })).phase, "done");
  assert.equal(derivePhase(view, live({ streaming: false, error: true })).phase, "failed");
  assert.equal(derivePhase(view, live({ streaming: false, error: true, finishReason: "user_stopped" })).phase, "stopped");
});

test("rules 2–3: waiting beats a working call; the newest working call names the phase", () => {
  const search = call({ callId: "s", tool: "web_search", status: "running", startedAt: at(1_000) });
  const fetch = call({ callId: "f", tool: "web_fetch", status: "queued", startedAt: at(2_000) });
  const code = call({ callId: "c", tool: "run_code", status: "running", startedAt: at(1_500) });
  let view = buildRunView(message([toolRow(1, 1_000, search), toolRow(2, 1_500, code), toolRow(3, 2_000, fetch)]));
  assert.equal(derivePhase(view, live({ now: T0 + 2_100 })).phase, "reading");
  assert.equal(derivePhase(view, live({ now: T0 + 2_100 })).subjectKey, "f");
  const approval = call({
    callId: "gh",
    tool: "mcp",
    status: "awaiting_approval",
    startedAt: at(500),
    approval: { id: "a1", status: "pending", riskClass: "external_write" },
  });
  view = buildRunView(message([toolRow(1, 1_000, search), toolRow(4, 500, approval)]));
  const waiting = derivePhase(view, live({ now: T0 + 60_000, lastEventAt: T0 }));
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.stalled, false, "waiting is never a stall");
  assert.deepEqual(
    (["web_search", "provider_web_search", "provider_x_search", "search_chats", "web_fetch", "read_document", "inspect_image", "run_code", "mcp", "calculate"] as const).map(phaseForTool),
    ["searching", "searching", "searching", "searching", "reading", "reading", "reading", "tool", "tool", "tool"],
  );
});

test("rule 3: reads that start within 1 s coalesce under one stable identity", () => {
  const reads = [0, 1, 2].map((i) =>
    toolRow(i + 1, 2_000 + i * 300, call({ callId: `r${i}`, tool: "web_fetch", status: "running", startedAt: at(2_000 + i * 300) })),
  );
  const two = derivePhase(buildRunView(message(reads.slice(0, 2))), live({ now: T0 + 2_400 }));
  const three = derivePhase(buildRunView(message(reads)), live({ now: T0 + 2_700 }));
  assert.equal(two.coalesced, 2);
  assert.equal(three.coalesced, 3);
  assert.equal(two.subjectKey, three.subjectKey, "a new member updates the count, not the label");
  const apart = [
    reads[0],
    toolRow(9, 5_000, call({ callId: "late", tool: "web_fetch", status: "running", startedAt: at(5_000) })),
  ];
  assert.equal(derivePhase(buildRunView(message(apart)), live({ now: T0 + 5_100 })).coalesced, undefined);
});

test("rules 4–6: answering, thinking by segment, queued then thinking", () => {
  const empty = buildRunView(message([]));
  assert.equal(derivePhase(empty, live({ now: T0 + 399 })).phase, "queued");
  assert.equal(derivePhase(empty, live({ now: T0 + 400 })).phase, "thinking");
  assert.equal(derivePhase(empty, live({ answerStarted: true })).phase, "answering");
  const thinking = derivePhase(buildRunView(message([segmentRow(1, 100, 0, 0)], { reasoning: "Hmm." })), live({ now: T0 + 50 }));
  assert.equal(thinking.phase, "thinking");
  assert.equal(thinking.subjectKey, "reasoning:act_1");
  // A later tool re-enters a working phase after the answer began.
  const late = call({ callId: "late", tool: "web_search", status: "running", startedAt: at(9_000) });
  assert.equal(derivePhase(buildRunView(message([toolRow(1, 9_000, late)])), live({ answerStarted: true, now: T0 + 9_100 })).phase, "searching");
});

test("stalled: 30 s without a frame, never while waiting or while a call is inside its timeout", () => {
  const empty = buildRunView(message([row(1, 0, "context", "Tools ready")]));
  const quiet = derivePhase(empty, live({ now: T0 + 30_000, lastEventAt: T0 }));
  assert.equal(quiet.stalled, true);
  assert.equal(quiet.calm, true, "a stall forces calm");
  assert.equal(quiet.stalledSince, T0);
  assert.equal(derivePhase(empty, live({ now: T0 + 29_999, lastEventAt: T0 })).stalled, false);
  // Pings do not reach lastEventAt, so only real frames reset it.
  assert.equal(derivePhase(empty, live({ now: T0 + 40_000, lastEventAt: T0 + 20_000 })).stalled, false);

  // A 60 s run_code sends nothing and the server watchdog is paused: not a stall.
  const code = call({ callId: "c", tool: "run_code", status: "running", startedAt: at(1_000), timeoutMs: 120_000 });
  const running = buildRunView(message([toolRow(1, 1_000, code)]));
  assert.equal(derivePhase(running, live({ now: T0 + 61_000, lastEventAt: T0 + 1_000 })).stalled, false);
  // Past its own timeout it is.
  assert.equal(derivePhase(running, live({ now: T0 + 130_000, lastEventAt: T0 + 1_000 })).stalled, true);
});

test("calm after 20 s of work; escalation at 2 and 10 minutes; a decision restarts the count", () => {
  const empty = buildRunView(message([segmentRow(1, 0, 0, 0)], { reasoning: "…" }));
  const at19 = derivePhase(empty, live({ now: T0 + 19_999, lastEventAt: T0 + 19_000 }));
  assert.equal(at19.calm, false);
  const at20 = derivePhase(empty, live({ now: T0 + RUN_PACING.calmAfterMs, lastEventAt: T0 + 19_000 }));
  assert.equal(at20.calm, true);
  assert.equal(derivePhase(empty, live({ now: T0 + 119_999, lastEventAt: T0 + 119_000 })).escalation, 0);
  assert.equal(derivePhase(empty, live({ now: T0 + 120_000, lastEventAt: T0 + 119_000 })).escalation, 1);
  assert.equal(derivePhase(empty, live({ now: T0 + 600_000, lastEventAt: T0 + 599_000 })).escalation, 2);

  const decided = call({
    callId: "gh",
    tool: "mcp",
    status: "running",
    startedAt: at(1_000),
    approval: { id: "a", status: "allowed", riskClass: "external_write", decidedAt: at(100_000) },
  });
  const afterDecision = derivePhase(buildRunView(message([toolRow(1, 1_000, decided)])), live({ now: T0 + 110_000, lastEventAt: T0 + 109_000 }));
  assert.equal(afterDecision.workingMs, 10_000);
  assert.equal(afterDecision.calm, false);
});
