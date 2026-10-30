import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pausedAgentRunRefusal } from "@/lib/agents/domain";

/*
 * A paused agent keeps everything and starts nothing (AUDIT.md §3 item 8).
 * `start_task`, `hand_off_to_teammate`, `startAgentTask` and the goal runner
 * each refused while paused, but the dispatcher they share did not: Retry,
 * Run again and Continue on a task card in a paused agent's thread
 * (POST /api/work/sessions/[id]/runs) still started a new attempt under its
 * name. The refusal now lives in `startWorkRunForUser`, which every one of
 * those paths goes through. The dispatcher touches the database and is
 * server-only, so its use of the rule is pinned as source.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a paused agent's task is refused with the same sentence as startAgentTask", () => {
  assert.deepEqual(pausedAgentRunRefusal({ name: "Scout", status: "paused" }), {
    error: "agent_paused",
    message: "Scout is paused. Resume it to start something new.",
  });
  // Anything but active is not active: a status this build does not know starts nothing either.
  assert.equal(pausedAgentRunRefusal({ name: "Scout", status: "sleeping" })?.error, "agent_paused");
});

test("an active agent, or a task with no agent, is not refused", () => {
  assert.equal(pausedAgentRunRefusal({ name: "Scout", status: "active" }), null);
  // No agent (an ordinary task, or one whose agent was retired): nothing to be paused.
  assert.equal(pausedAgentRunRefusal(null), null);
});

test("startWorkRunForUser refuses a paused agent's attempt after a replay is answered and before anything else", () => {
  const dispatch = read("src/lib/work/dispatch.ts");
  const start = dispatch.slice(dispatch.indexOf("export async function startWorkRunForUser("));
  const body = start.slice(0, start.indexOf("\n}\n"));
  const check = body.indexOf("pausedAgentRunRefusal(");
  assert.ok(check > 0, "the dispatcher asks whether the session's agent is paused");
  // A retried request whose run already exists still gets that run back.
  assert.ok(body.indexOf("replay: true") < check);
  // Before the plan gate, the windows and the run itself.
  assert.ok(check < body.indexOf("isWorkModelAllowed("));
  assert.ok(check < body.indexOf("checkUsageWindows("));
  // Read fresh, scoped to the person, and only for a session that has an agent.
  assert.match(
    body,
    /session\.agentId\s*\?\s*await prisma\.agent\.findFirst\(\{\s*where: \{ id: session\.agentId, userId: user\.id, deletedAt: null \}/
  );
  assert.match(body, /if \(paused\) return refused\(409, paused\);/);
});
