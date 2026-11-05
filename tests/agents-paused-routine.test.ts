import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pausedAgentRunRefusal } from "@/lib/agents/domain";

/*
 * A paused agent keeps everything and starts nothing. Pausing it switches its
 * routines off (`updateAgentForUser`, src/lib/agents/store.ts), but the person
 * can switch one back on from Automations while the agent is still paused, and
 * the scheduler only asked `schedule.enabled`: the routine then fired under the
 * paused agent's name.
 *
 * Every path that starts a routine's run without going through
 * `startWorkRunForUser` now asks `pausedAgentRunRefusal` itself: the clock
 * (scripts/work-scheduler.ts), polled triggers (scripts/work-trigger-poller.ts)
 * and Run now / the fire URL (src/lib/work/fire-now.ts). The clock and the
 * poller skip the fire without starting anything and record it the way they
 * record every other skip: a marker run with the refusal's sentence, the
 * schedule advanced past the fire and its lease released. Those modules touch
 * the database and are server-only, so their use of the rule is pinned as
 * source here; tests/work-workers.integration.test.ts drives the scheduler
 * against a real database.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The source of one top-level function, from its declaration to its closing brace. */
function body(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} exists`);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

test("the sentence a skipped fire records is the dispatcher's", () => {
  assert.equal(pausedAgentRunRefusal({ name: "Scout", status: "paused" })?.message, "Scout is paused. Resume it to start something new.");
  assert.equal(pausedAgentRunRefusal({ name: "Scout", status: "active" }), null);
});

test("the scheduler skips a paused agent's due fire before it plans or starts anything", () => {
  const dispatch = body(read("scripts/work-scheduler.ts"), "async function dispatchOne(");
  const check = dispatch.indexOf("pausedAgentRunRefusal(");
  assert.ok(check > 0, "dispatchOne asks whether the routine's agent is paused");
  // After the fire is known to be owed by a trigger (a stale column is
  // re-derived, not skipped), and before the planner, the budget reads and
  // any run, Work or Code.
  assert.ok(dispatch.indexOf("triggerOwningFire(") < check);
  assert.ok(check < dispatch.indexOf("planScheduleDispatch("));
  assert.ok(check < dispatch.indexOf("accountLimits("));
  assert.ok(check < dispatch.indexOf("dispatchCodeFires("));
  assert.ok(check < dispatch.indexOf("await createRun({"));
  // Read fresh, scoped to the person, and only for a routine that has an agent.
  assert.match(
    dispatch,
    /schedule\.session\.agentId\s*\?\s*await prisma\.agent\.findFirst\(\{\s*where: \{ id: schedule\.session\.agentId, userId: schedule\.userId, deletedAt: null \}/
  );
  const branch = dispatch.slice(check, dispatch.indexOf("return;", check));
  // Recorded as every other skip is: advanced past the fire, lease released,
  // a marker run with the refusal's sentence, and a "skipped" log line.
  assert.match(branch, /data: \{ nextRunAt: advanced\(\), lockedUntil: null \}/);
  assert.match(branch, /recordMarkerRun\(\{[\s\S]*?fireAt: dueAt,[\s\S]*?reason: "superseded",\s*explanation: pausedAgent\.message,/);
  assert.match(branch, /log\("skipped", \{[\s\S]*?cause: "agent_paused"/);
  assert.doesNotMatch(branch, /createRun\(|dispatchCodeFires\(/);
});

test("a polled trigger does not fire a paused agent's routine either", () => {
  const offer = body(read("scripts/work-trigger-poller.ts"), "async function offer(");
  const check = offer.indexOf("pausedAgentRunRefusal(");
  assert.ok(check > 0, "offer asks whether the routine's agent is paused");
  assert.ok(check < offer.indexOf("await createRun({"));
  assert.match(
    offer,
    /schedule\.session\.agentId\s*\?\s*await prisma\.agent\.findFirst\(\{\s*where: \{ id: schedule\.session\.agentId, userId: schedule\.userId, deletedAt: null \}/
  );
  const branch = offer.slice(check, offer.indexOf('return "settled";', check));
  assert.match(branch, /recordMarkerRun\(\{[\s\S]*?reason: "superseded",\s*explanation: pausedAgent\.message,/);
});

test("Run now and the fire URL refuse a paused agent's routine with the same sentence", () => {
  const source = read("src/lib/work/fire-now.ts");
  assert.match(source, /export const FIRE_REFUSALS = \[[\s\S]*?"agent_paused",[\s\S]*?\] as const;/);
  const fire = body(source, "export async function fireScheduleNow(");
  const check = fire.indexOf("pausedAgentRunRefusal(");
  assert.ok(check > 0, "fireScheduleNow asks whether the routine's agent is paused");
  assert.ok(check < fire.indexOf("await createRun({"));
  assert.ok(check < fire.indexOf("startCodeRoutineRun("));
  assert.match(fire, /reason: "agent_paused",\s*message: pausedAgent\.message,/);
});
