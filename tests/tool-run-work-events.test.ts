import test from "node:test";
import assert from "node:assert/strict";

import {
  readWorkToolRun,
  workArtifactKindFor,
  workRunCapabilityDegraded,
  workToolFinishedEvents,
  workToolStartedPayload,
} from "@/lib/work/tool-run-events";
import { deriveActivity, deriveCurrentAction } from "@/components/work/work-timeline";
import { readEvent } from "@/components/work/work-payload";
import type { ClientWorkEvent } from "@/lib/work/serializers";

/*
 * Orbit reuses the Work event kinds it already has for a run (TOOL_RUNTIME_DESIGN
 * §6.12): `tool_started`, `tool_finished`, `artifact_created`, and `degraded`
 * with `capability_unavailable`. No new kind, so a shipped native build keeps
 * decoding a task that ran code; what is new rides as additive payload keys.
 */

const KINDS_THE_CONTRACT_HAS = new Set(["tool_started", "tool_finished", "artifact_created", "degraded"]);

let seq = 0;
function event(kind: ClientWorkEvent["kind"], payload: Record<string, unknown>): ClientWorkEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    runId: "run-1",
    seq,
    kind,
    payloadVersion: 1,
    visibility: "user",
    payload: payload as ClientWorkEvent["payload"],
    eventKey: null,
    agentId: null,
    createdAt: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  };
}

const SUCCEEDED_RUN = {
  runId: "r1",
  status: "succeeded",
  language: "python",
  context: "hosted_sandbox",
  exitCode: 0,
  durationMs: 2_412,
  files: [
    { attachmentId: "att_chart", name: "chart.png", mime: "image/png", bytes: 48_211 },
    { attachmentId: "att_xlsx", name: "out.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: 6_120 },
  ],
  stdout: { head: "ok", omittedBytes: 0 },
};

test("a run starts with the phase sentence the feed prints as the current action", () => {
  const payload = workToolStartedPayload({ callId: "c1", tool: "run_code", status: "running", run: { language: "python", context: "hosted_sandbox" } });
  assert.ok(payload);
  assert.equal(payload.summary, "Running Python");
  assert.deepEqual(payload.run, { language: "python", context: "hosted_sandbox" });
  assert.equal(workToolStartedPayload({ callId: "c2", tool: "web_search", status: "running" }), null);
  const action = deriveCurrentAction([event("tool_started", payload)]);
  assert.equal(action?.title, "Running Python");
});

test("a finished run is tool_finished plus one artifact_created per kept file, and nothing new", () => {
  const events = workToolFinishedEvents({ callId: "c1", tool: "run_code", status: "succeeded", durationMs: 2_412, run: SUCCEEDED_RUN });
  assert.deepEqual(events.map((e) => e.kind), ["tool_finished", "artifact_created", "artifact_created"]);
  for (const e of events) assert.ok(KINDS_THE_CONTRACT_HAS.has(e.kind));
  const finished = events[0].payload;
  assert.equal(finished.isError, false);
  assert.equal(finished.summary, "Ran Python · 2.4s · 2 files");
  assert.equal(finished.runPhase, "succeeded");
  const artifact = readEvent({ kind: "artifact_created", payload: events[1].payload as ClientWorkEvent["payload"] });
  assert.equal(artifact.title, "chart.png");
  assert.equal(artifact.kind, "image");
  assert.equal(artifact.origin, "tool_output");
  assert.equal(workArtifactKindFor("text/csv", "summary.csv"), "spreadsheet");
  assert.equal(workArtifactKindFor("application/pdf", "r.pdf"), "pdf");
});

test("a stopped run keeps no artifacts; an unknown outcome is never a success", () => {
  const stopped = workToolFinishedEvents({ callId: "c1", tool: "run_code", status: "cancelled", run: { status: "cancelled", language: "python", filesDiscarded: 1 } });
  assert.deepEqual(stopped.map((e) => e.kind), ["tool_finished"]);
  assert.equal(stopped[0].payload.isError, true);
  assert.equal(stopped[0].payload.summary, "Stopped");
  const unknown = workToolFinishedEvents({ callId: "c1", tool: "run_code", status: "outcome_unknown", run: { status: "outcome_unknown", language: "python" } });
  assert.equal(unknown[0].payload.isError, true);
  assert.equal(unknown[0].payload.summary, "Outcome unknown, the server restarted while this ran");
});

test("the feed reads a run's ending back: settled words, evidence, and unknown as unreported", () => {
  const started = workToolStartedPayload({ callId: "c1", tool: "run_code", status: "running", run: { language: "python", context: "hosted_sandbox" } })!;
  const failed = workToolFinishedEvents({
    callId: "c1",
    tool: "run_code",
    status: "failed",
    durationMs: 1_108,
    run: { status: "failed", language: "python", context: "hosted_sandbox", exitCode: 1, stderr: { head: "KeyError: 'Region'", omittedBytes: 0 } },
  })[0].payload;
  const entries = deriveActivity([event("tool_started", started), event("tool_finished", failed)]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Python failed · exit 1");
  assert.equal(entries[0].state, "failed");
  assert.equal(entries[0].detail, "KeyError: 'Region'");
  assert.ok(entries[0].facts.some((f) => f.label === "Exit code" && f.value === "1"));
  assert.ok(entries[0].facts.some((f) => f.label === "Where" && /sandbox/.test(f.value)));

  const unknown = workToolFinishedEvents({ callId: "c2", tool: "run_code", status: "outcome_unknown", run: { status: "outcome_unknown", language: "python" } })[0].payload;
  const unknownEntries = deriveActivity([
    event("tool_started", workToolStartedPayload({ callId: "c2", tool: "run_code", status: "running", run: { language: "python" } })!),
    event("tool_finished", unknown),
  ]);
  assert.equal(unknownEntries[0].state, "unreported");
});

test("an older runner's tool_finished (no phase, only isError) still reads truthfully", () => {
  assert.equal(readWorkToolRun({ tool: "run_code", isError: false, durationMs: 10 })?.phase, "succeeded");
  assert.equal(readWorkToolRun({ tool: "run_code", isError: true })?.phase, "failed");
  assert.equal(readWorkToolRun({ tool: "run_code" })?.phase, "running");
  assert.equal(readWorkToolRun({ tool: "browser", isError: false }), null);
});

test("no sandbox or an unverified model is the existing capability_unavailable degradation", () => {
  const down = workRunCapabilityDegraded("code_execution_unavailable");
  assert.equal(down.kind, "degraded");
  assert.equal(down.payload.kind, "capability_unavailable");
  assert.equal(down.payload.reason, "code_execution_unavailable");
  assert.match(String(down.payload.explanation), /can't run code/);
  const unverified = workRunCapabilityDegraded("tool_calling_unverified", { modelLabel: "Kimi K3" });
  assert.match(String(unverified.payload.explanation), /Kimi K3 hasn't been yet/);
  const entries = deriveActivity([event("degraded", down.payload)]);
  assert.equal(entries[0]?.title, "Ran with less than you asked for");
  assert.match(entries[0]?.detail ?? "", /sandbox/);
});
