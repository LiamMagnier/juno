import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_FIXTURE_DIR,
  agentTranscriptFixtures,
  fixtureEvents,
  fixtureLines,
  renderFolded,
} from "../scripts/fold-agent-fixtures";
import { agentSessionViewJSON, foldAgentEvents, pendingAgentApproval } from "../src/lib/agent-protocol/fold";
import {
  AGENT_PROTOCOL,
  parseAgentCommand,
  parseAgentEvent,
  serializeAgentEvent,
  validateAgentCommand,
  validateAgentEvent,
} from "../src/lib/agent-protocol/protocol.generated";

/*
 * THE CANONICAL AGENT PROTOCOL, HELD TO ITS GOLDEN TRANSCRIPTS.
 *
 * The contract (contracts/agent/juno-agent-protocol-v1.json) is generated into
 * TypeScript twice and Swift once; the fixtures are what make "the same
 * protocol" a checkable claim rather than a hope. Every line a producer could
 * send round-trips unchanged, every transcript folds to its checked-in view,
 * and JunoAgentProtocolTests holds the Swift reducer to the same files.
 */

const root = process.cwd();
const transcripts = agentTranscriptFixtures();

test("the fixtures cover every event type in the contract", () => {
  const contract = JSON.parse(readFileSync(join(root, "contracts/agent/juno-agent-protocol-v1.json"), "utf8")) as {
    events: Record<string, unknown>;
    commands: Record<string, unknown>;
  };
  const seen = new Set<string>();
  for (const name of transcripts) {
    for (const line of fixtureLines(name)) {
      const type = (line as { type?: unknown }).type;
      if (typeof type === "string") seen.add(type);
    }
  }
  const missing = Object.keys(contract.events).filter((type) => !seen.has(type));
  assert.deepEqual(missing, [], `no golden transcript exercises: ${missing.join(", ")}`);

  const commandTypes = new Set(fixtureLines("commands").map((line) => (line as { type: string }).type));
  const missingCommands = Object.keys(contract.commands).filter((type) => !commandTypes.has(type));
  assert.deepEqual(missingCommands, [], `commands.jsonl does not exercise: ${missingCommands.join(", ")}`);
});

test("every line a producer sends is valid and round-trips unchanged", () => {
  for (const name of transcripts.filter((fixture) => fixture !== "forward-compat")) {
    fixtureLines(name).forEach((line, index) => {
      assert.deepEqual(validateAgentEvent(line), [], `${name}.jsonl line ${index + 1} breaks the contract`);
      const parsed = parseAgentEvent(line);
      assert.ok(parsed, `${name}.jsonl line ${index + 1} did not parse`);
      assert.notEqual(parsed.type, "unknown");
      assert.deepEqual(serializeAgentEvent(parsed), line, `${name}.jsonl line ${index + 1} did not round-trip`);
    });
  }
});

test("every transcript folds to its golden view", () => {
  for (const name of transcripts) {
    const golden = JSON.parse(readFileSync(join(root, AGENT_FIXTURE_DIR, `${name}.folded.json`), "utf8"));
    assert.deepEqual(agentSessionViewJSON(foldAgentEvents(fixtureEvents(name))), golden, `${name} folds differently`);
    // And the checked-in file is byte-for-byte what the script writes.
    assert.equal(readFileSync(join(root, AGENT_FIXTURE_DIR, `${name}.folded.json`), "utf8"), renderFolded(name));
  }
});

test("an older reader survives a newer producer", () => {
  const lines = fixtureLines("forward-compat");
  const byId = (id: string) => lines.find((line) => (line as { id?: string }).id === id);

  // A type from a future minor is kept whole, not dropped and not fatal.
  const hologram = parseAgentEvent(byId("fc-4"));
  assert.equal(hologram?.type, "unknown");
  assert.equal(hologram && "rawType" in hologram ? hologram.rawType : null, "item.hologram");
  assert.deepEqual(hologram && serializeAgentEvent(hologram), byId("fc-4"));

  // An unknown enum value reads as "unknown"; a key the contract does not name
  // is dropped; so is a malformed optional field.
  const call = parseAgentEvent(byId("fc-5"));
  assert.equal(call?.type, "item.tool_call");
  if (call?.type === "item.tool_call") {
    assert.equal(call.toolKind, "unknown");
    assert.equal(call.risk, "unknown");
    assert.equal("colour" in call, false);
  }
  const result = parseAgentEvent(byId("fc-6"));
  assert.equal(result?.type === "item.tool_result" ? result.durationMs : "missing", undefined);
  assert.ok(validateAgentEvent(byId("fc-5")).length > 0, "a strict validator still names what was wrong");

  // A newer minor of the same major is read; another major is not an event.
  assert.equal(parseAgentEvent(byId("fc-7"))?.type, "item.assistant_text");
  assert.equal(parseAgentEvent(byId("fc-9")), null);
  assert.equal(parseAgentEvent({ hello: "world" }), null);
  assert.equal(parseAgentEvent("not an object"), null);

  // A known type missing a required field is kept as unknown rather than thrown.
  assert.equal(parseAgentEvent(byId("fc-8"))?.type, "unknown");

  // And the fold skips the replayed event rather than applying it twice.
  const view = foldAgentEvents(fixtureEvents("forward-compat"));
  assert.equal(view.unknownEventCount, 2);
  assert.equal(view.items.filter((item) => item.itemId === "c1").length, 1);
});

test("tool outcomes are typed, never read out of a title", () => {
  const view = foldAgentEvents(fixtureEvents("cloud-run"));
  const statuses = Object.fromEntries(
    view.items.flatMap((item) => (item.kind === "tool" ? [[item.itemId, item.status]] : [])),
  );
  assert.deepEqual(statuses, { toolu_01: "error", toolu_02: "ok", toolu_03: "ok", toolu_04: "ok" });

  const interrupted = foldAgentEvents(fixtureEvents("interrupted-and-failed"));
  // A call the host lost mid-run is "unknown", not "failed" and not "ok".
  assert.deepEqual(
    interrupted.items.filter((item) => item.kind === "tool").map((item) => (item.kind === "tool" ? item.status : "")),
    ["unknown", "unknown"],
  );
});

test("a pending approval is the one a reader can answer", () => {
  const lines = fixtureEvents("approvals");
  // Stop right after the first request.
  const upToRequest = lines.slice(0, lines.findIndex((event) => event.type === "approval.requested") + 1);
  const view = foldAgentEvents(upToRequest);
  assert.equal(view.state, "awaiting_approval");
  assert.equal(pendingAgentApproval(view)?.summary, "rm -rf build");
  // Once answered, the session is working again.
  const answered = foldAgentEvents(lines.slice(0, upToRequest.length + 1));
  assert.equal(answered.state, "running");
  assert.equal(pendingAgentApproval(answered), undefined);
});

test("commands round-trip and validate", () => {
  for (const line of fixtureLines("commands")) {
    assert.deepEqual(validateAgentCommand(line), []);
    const parsed = parseAgentCommand(line);
    assert.ok(parsed && parsed.type !== "unknown");
    assert.deepEqual({ ...parsed }, line);
  }
  const future = parseAgentCommand({
    v: AGENT_PROTOCOL.v,
    id: "c",
    idempotencyKey: "k",
    sessionId: "s",
    issuedAt: "2026-09-30T10:00:00.000Z",
    type: "session.teleport",
  });
  assert.equal(future?.type, "unknown");
});

test("the generated TypeScript and Swift match the contract", () => {
  // Throws (non-zero exit) when any of the three outputs is stale.
  execFileSync(process.execPath, ["scripts/generate-agent-protocol.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const agentCore = readFileSync(join(root, "runner/agent-core/src/protocol.generated.ts"), "utf8");
  const web = readFileSync(join(root, "src/lib/agent-protocol/protocol.generated.ts"), "utf8");
  assert.equal(agentCore, web, "agent-core and the web carry the same generated text");
});
