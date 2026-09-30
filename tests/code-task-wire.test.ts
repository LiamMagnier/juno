import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { TASK_EVENT_FRAME_BYTES, taskEventFrames } from "../src/lib/code-task-wire";
import {
  TASK_WIRE_FIXTURE_PATH,
  renderTaskWireFixtures,
  taskWireFixtures,
} from "../scripts/generate-code-task-wire-fixtures";

/*
 * THE DEVICE TASK WIRE, HELD TO WHAT THE MAC DECODES.
 *
 * A model picked on the web for a Mac run was stored on the task and then lost
 * on the way to the Mac: `serializeTask` never emitted it, the Mac decoded a
 * key (`modelId`) no server sends, and the Swift fixture carried that key too,
 * so every test passed. These pin the three places that let that happen: the
 * server's output, the fixtures the Swift tests read, and the Swift decoder's
 * key list against the server's.
 */

const root = process.cwd();
const fixtures = taskWireFixtures() as Record<string, Record<string, unknown>>;

test("a device task carries the model, effort and mode it was created with", () => {
  const task = fixtures.deviceTaskWithModel;
  assert.equal(task.model, "claude-sonnet-5");
  assert.equal(task.reasoningEffort, "high");
  assert.ok("permissionMode" in task, "permissionMode is on the wire, null or not");
  // No preference stays an explicit null rather than a missing key, so a
  // reader can tell "not chosen" from "an older server".
  assert.equal(fixtures.deviceTaskWithoutPreferences.model, null);
  assert.equal(fixtures.deviceTaskWithoutPreferences.reasoningEffort, null);
});

test("the Swift fixtures are the server's own output", () => {
  const onDisk = readFileSync(join(root, TASK_WIRE_FIXTURE_PATH), "utf8");
  assert.equal(
    onDisk,
    renderTaskWireFixtures(),
    "code-task-wire.json drifted from serializeTask: run npx tsx scripts/generate-code-task-wire-fixtures.ts",
  );
});

test("every key the Mac decodes is one the server sends", () => {
  const swift = readFileSync(
    join(root, "native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeAgentClient.swift"),
    "utf8",
  );
  const start = swift.indexOf("public struct NativeCodeAgentTask");
  assert.notEqual(start, -1, "NativeCodeAgentTask is gone — was it renamed?");
  const keysBlock = /private enum CodingKeys: String, CodingKey \{([\s\S]*?)\n {4}\}/.exec(swift.slice(start))?.[1];
  assert.ok(keysBlock, "NativeCodeAgentTask no longer declares its CodingKeys");
  const swiftKeys = keysBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("case "))
    .flatMap((line) => line.slice(5).split(",").map((key) => key.trim()))
    .filter(Boolean);
  assert.ok(swiftKeys.includes("model"), "the Mac must decode `model`, the key the server sends");

  const serverKeys = new Set(Object.values(fixtures).flatMap((task) => Object.keys(task)));
  // Read only as a fallback for a key no server has sent; see the decoder.
  const legacyFallbacks = new Set(["modelId"]);
  const invented = swiftKeys.filter((key) => !serverKeys.has(key) && !legacyFallbacks.has(key));
  assert.deepEqual(invented, [], `the Mac decodes keys the server never sends: ${invented.join(", ")}`);
});

test("a page of task events reaches a phone in frames it will read", () => {
  // Forty file changes with a 30 KB diff each, as a protocol row and its
  // legacy twin: 2.4 MB, past the 2 MB at which the iPhone's parser silently
  // discards a frame.
  const diff = "x".repeat(30_000);
  const rows = Array.from({ length: 80 }, (_, index) => ({
    seq: index + 1,
    kind: index % 2 === 0 ? "protocol" : "file_change",
    payload: { diff },
    createdAt: "2026-09-30T10:00:00.000Z",
  }));
  const frames = taskEventFrames("snapshot", rows);
  assert.ok(frames.length > 1);
  assert.equal(frames[0].type, "snapshot", "the first frame still says the client is attached");
  assert.ok(frames.slice(1).every((frame) => frame.type === "events"));
  assert.deepEqual(frames.flatMap((frame) => frame.events.map((row) => row.seq)), rows.map((row) => row.seq));
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame.events)) <= TASK_EVENT_FRAME_BYTES + 2);
  }
  // An empty snapshot is still sent; an empty page of news is not.
  assert.deepEqual(taskEventFrames("snapshot", []), [{ type: "snapshot", events: [] }]);
  assert.deepEqual(taskEventFrames("events", []), []);

  const route = readFileSync(join(root, "src/app/api/code/tasks/[id]/events/route.ts"), "utf8");
  assert.equal((route.match(/sendPage\("(snapshot|events)"/g) ?? []).length, 3, "every page the stream sends is cut");
  assert.doesNotMatch(route, /events: \w+\.map\(serializeTaskEvent\)/, "no page goes out as one frame");
});
