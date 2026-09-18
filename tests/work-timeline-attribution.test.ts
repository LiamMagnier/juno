import test from "node:test";
import assert from "node:assert/strict";

import { deriveActivity } from "@/components/work/work-timeline";
import type { ClientWorkEvent } from "@/lib/work/serializers";

/*
 * Who did each thing in a run that delegated.
 *
 * `WorkEvent.agentId` is a column the executor has always served and nothing
 * ever read. That was harmless while no cloud run could delegate; now that one
 * can, a feed that renders a child's tool calls and the coordinator's as one
 * voice is a record of the task that nobody can reconstruct afterwards — which
 * is the reason the column is written in the first place.
 *
 * The other half is the identifier itself. `agentId` is random, and a row
 * headed `agent-7f3a` is a row nobody can read, so the name a child is shown
 * under is always the title its parent briefed it with.
 */

let seq = 0;

function event(
  kind: ClientWorkEvent["kind"],
  payload: Record<string, string>,
  agentId: string | null = null
): ClientWorkEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    runId: "run-1",
    seq,
    kind,
    payloadVersion: 1,
    visibility: "user",
    payload,
    eventKey: null,
    agentId,
    createdAt: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  };
}

test("a child's work is attributed to the child, by the name its parent gave it", () => {
  const entries = deriveActivity([
    event("tool_started", { callId: "a", tool: "web_fetch", summary: "Read the index" }),
    event("subagent_update", { title: "Read the filings", status: "started" }, "agent-7f3a"),
    event(
      "tool_started",
      { callId: "b", tool: "web_fetch", summary: "Read the 2024 filing" },
      "agent-7f3a"
    ),
  ]);

  const parent = entries.find((entry) => entry.title === "Read the index");
  const child = entries.find((entry) => entry.title === "Read the 2024 filing");
  assert.ok(parent && child);
  // The coordinator's own work is not attributed to anybody: most rows in most
  // runs are this one, and a marker on all of them says nothing.
  assert.equal(parent.agent, null);
  assert.equal(child.agent, "Read the filings");
});

test("a child nothing announced is still marked as a child", () => {
  // The `subagent_update` that names it can be missing — an old run, a
  // truncated window — and the alternative to a plain word is printing the
  // identifier, which is the thing this attribution exists not to do.
  const entries = deriveActivity([
    event("tool_started", { callId: "a", tool: "web_fetch", summary: "Read a page" }, "agent-7f3a"),
  ]);
  assert.equal(entries[0].agent, "A sub-agent");
  assert.notEqual(entries[0].agent, "agent-7f3a");
});

test("a sub-agent row is never headed by its identifier", () => {
  const untitled = deriveActivity([event("subagent_update", { status: "finished" }, "agent-7f3a")]);
  assert.equal(untitled[0].title, "A sub-agent reported in");
  assert.ok(!untitled[0].title.includes("agent-7f3a"));

  const titled = deriveActivity([
    event("subagent_update", { title: "Read the filings", status: "finished" }, "agent-7f3a"),
  ]);
  assert.equal(titled[0].title, "Read the filings");
});
