import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Ajv from "ajv";

import {
  ALEVR_COMPUTER_TOOL_NAME,
  COMPUTER_ACTION_VALUES,
  type ComputerActionItem,
  type ComputerBridgeRequest,
  type ComputerBridgeResponse,
  type DesktopLockRecord,
} from "../runner/env-server/src/contracts/code-v2";
import { ComputerBridgeUnavailable, createUnixSocketBridge, type ComputerBridge } from "../runner/env-server/src/mcp/computer-bridge";
import {
  computerToolDefinition,
  coordinateSpaceForModel,
  createComputerTools,
  registerComputerTools,
  validateComputerArgs,
  type McpToolDefinition,
} from "../runner/env-server/src/mcp/computer-tools";
import { DesktopLock, holderSentence } from "../runner/env-server/src/mcp/desktop-lock";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "alevr-cu-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const schema = JSON.parse(readFileSync(join(process.cwd(), "contracts/code/alevr-code-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema, "code-v2");
const validates = (def: string, value: unknown) => {
  const v = ajv.getSchema(`code-v2#/definitions/${def}`)!;
  const ok = v(value);
  if (!ok) console.error(ajv.errorsText(v.errors));
  return ok;
};

// ── Schema ──────────────────────────────────────────────────────────────────

test("the tool schema is the contract's action vocabulary, flat enough for every vendor", () => {
  const def = computerToolDefinition();
  assert.equal(def.name, ALEVR_COMPUTER_TOOL_NAME);
  assert.deepEqual(def.inputSchema.properties.action.enum, [...COMPUTER_ACTION_VALUES]);
  const text = JSON.stringify(def.inputSchema);
  for (const banned of ["oneOf", "anyOf", "allOf", "minItems", "$ref"]) assert.ok(!text.includes(banned), banned);
  assert.match(def.description, /untrusted data/);
  assert.match(computerToolDefinition("normalized_1000").description, /0-999/);
  assert.match(def.description, /pixels of the latest screenshot/);
  // The JSON Schema itself compiles.
  new Ajv().compile(def.inputSchema as object);
});

test("validation: per-action requirements with sentences the model can act on", () => {
  const bad: [unknown, RegExp][] = [
    [null, /object with an action/],
    [{ action: "teleport" }, /action must be one of/],
    [{ action: "click" }, /needs x and y, or an element/],
    [{ action: "click", x: 3 }, /both x and y/],
    [{ action: "click", x: -1, y: 4 }, /not be negative/],
    [{ action: "click", x: "abc", y: 4 }, /x must be a number/],
    [{ action: "click", element: "button-1" }, /id from ax_find/],
    [{ action: "drag", x: 1, y: 1 }, /to_x and to_y/],
    [{ action: "scroll", x: 1, y: 1 }, /direction/],
    [{ action: "scroll", direction: "down", amount: 31 }, /1 to 30/],
    [{ action: "type" }, /needs text/],
    [{ action: "key", text: "  " }, /chord/],
    [{ action: "wait", seconds: 99 }, /0 to 30/],
    [{ action: "open_app" }, /needs app/],
    [{ action: "zoom", region: [0, 0, 10] }, /region/],
    [{ action: "zoom", region: [10, 10, 5, 20] }, /x1 > x0/],
    [{ action: "ax_press" }, /element .* or query/],
    [{ action: "menu", path: [] }, /needs path/],
    [{ action: "click", x: 1200, y: 5, coordinate_space: "normalized_1000" }, /0-999/],
    [{ action: "click", x: 1, y: 5, coordinate_space: "inches" }, /coordinate_space/],
  ];
  for (const [input, error] of bad) {
    const result = validateComputerArgs(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.match(result.error, error, JSON.stringify(input));
  }

  const good = validateComputerArgs({ action: "click", x: "512", y: 300.5, junk: true });
  assert.deepEqual(good, { ok: true, args: { action: "click", coordinate_space: "pixels", x: 512, y: 300.5 } });
  const wait = validateComputerArgs({ action: "wait" });
  assert.ok(wait.ok && wait.args.seconds === 1);
  const press = validateComputerArgs({ action: "ax_press", element: "e12", x: 5, y: 5 });
  assert.deepEqual(press, { ok: true, args: { action: "ax_press", coordinate_space: "pixels", element: "e12" } }, "stray points are dropped");
  const normalized = validateComputerArgs({ action: "drag", x: 10, y: 10, to_x: 990, to_y: 20 }, "normalized_1000");
  assert.ok(normalized.ok && normalized.args.coordinate_space === "normalized_1000");
  // Every validated call is a valid contract ComputerToolArgs.
  for (const input of [
    { action: "screenshot", app: "Pages" },
    { action: "scroll", direction: "down", amount: 3, x: 4, y: 4 },
    { action: "menu", path: ["File", "Export…"] },
    { action: "zoom", region: [0, 0, 100, 50] },
    { action: "type", text: "hello" },
  ]) {
    const r = validateComputerArgs(input);
    assert.ok(r.ok, JSON.stringify(input));
    if (r.ok) assert.ok(validates("ComputerToolArgs", r.args), JSON.stringify(r.args));
  }
});

test("coordinate space per model family", () => {
  assert.equal(coordinateSpaceForModel("gemini-3.8-pro"), "normalized_1000");
  assert.equal(coordinateSpaceForModel("antigravity"), "normalized_1000");
  assert.equal(coordinateSpaceForModel("claude-opus-5-5"), "pixels");
  assert.equal(coordinateSpaceForModel("gpt-6-codex"), "pixels");
  assert.equal(coordinateSpaceForModel(undefined), "pixels");
});

// ── Lock ────────────────────────────────────────────────────────────────────

test("lock: exclusive across holders, re-entrant for the same holder, released only by its owner", () => {
  const path = join(scratch(), "desktop.lock");
  let clock = Date.parse("2026-10-08T20:00:00Z");
  const a = new DesktopLock({ path, pid: 101, now: () => clock, isAlive: () => true });
  const b = new DesktopLock({ path, pid: 202, now: () => clock, isAlive: () => true });

  const first = a.acquire({ holderId: "mac:s1", kind: "code_session", title: "Fix the export sheet", app: "TextEdit" });
  assert.ok(first.ok);
  assert.ok(validates("DesktopLockRecord", JSON.parse(readFileSync(path, "utf8"))));

  const refused = b.acquire({ holderId: "claude:t7", kind: "env_server", title: "Check the deck" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.holder?.holderId, "mac:s1");
    assert.equal(refused.reason, "Alevr is using TextEdit for ‘Fix the export sheet’. Try again when it finishes.");
  }

  // The same holder from another process (the Mac executing an env session's call) is re-entrant.
  clock += 1_000;
  const again = b.acquire({ holderId: "mac:s1", kind: "code_session", title: "" });
  assert.ok(again.ok);
  if (again.ok) {
    assert.equal(again.record.pid, 202);
    assert.equal(again.record.title, "Fix the export sheet", "an empty title keeps the old one");
    assert.equal(again.record.acquiredAt, "2026-10-08T20:00:00.000Z");
  }

  assert.equal(b.release("claude:t7"), false, "only the holder releases");
  assert.equal(a.heartbeat("someone-else"), false);
  assert.equal(a.heartbeat("mac:s1", "Pages"), true);
  assert.equal(a.read()?.app, "Pages");
  assert.equal(a.release("mac:s1"), true);
  assert.equal(existsSync(path), false);
  assert.equal(a.holder(), null);
});

test("lock: a dead process or a stale heartbeat is taken over; garbage is cleared", () => {
  const dir = scratch();
  const path = join(dir, "desktop.lock");
  let clock = Date.parse("2026-10-08T20:00:00Z");
  const alive = new Set([1, 2]);
  const lock = (pid: number) => new DesktopLock({ path, pid, now: () => clock, staleMs: 15_000, isAlive: (p) => alive.has(p) });

  assert.ok(lock(1).acquire({ holderId: "a", kind: "work_task", title: "" }).ok);
  assert.equal(lock(2).acquire({ holderId: "b", kind: "env_server", title: "" }).ok, false);
  const refusal = lock(2).acquire({ holderId: "b", kind: "env_server", title: "" });
  assert.ok(!refusal.ok && refusal.reason.startsWith("Alevr is already using apps for a Work task"));

  clock += 16_000; // heartbeat too old
  assert.ok(lock(2).acquire({ holderId: "b", kind: "env_server", title: "" }).ok);

  alive.delete(2); // b's process died
  assert.ok(lock(1).acquire({ holderId: "a", kind: "code_session", title: "" }).ok);

  writeFileSync(path, "{not json");
  assert.ok(lock(2).acquire({ holderId: "c", kind: "env_server", title: "" }).ok, "an unreadable record is stale");

  assert.equal(
    holderSentence({ holderId: "x", kind: "env_server", title: "", pid: 1, acquiredAt: "", heartbeatAt: "" } satisfies DesktopLockRecord),
    "Alevr is already using apps for a connected agent",
  );
});

// ── Calls ───────────────────────────────────────────────────────────────────

class FakeBridge implements ComputerBridge {
  requests: Omit<ComputerBridgeRequest, "id" | "token">[] = [];
  constructor(private answer: (r: Omit<ComputerBridgeRequest, "id" | "token">) => ComputerBridgeResponse | Error) {}
  async send(request: Omit<ComputerBridgeRequest, "id" | "token">) {
    this.requests.push(request);
    const a = this.answer(request);
    if (a instanceof Error) throw a;
    return a;
  }
}

const shotItem = (callId: string): ComputerActionItem => ({
  id: "mac-side-id",
  kind: "computer_action",
  createdAt: "2026-10-08T20:00:01Z",
  callId,
  action: "click",
  status: "completed",
  app: "Pages",
  summary: "Clicked the “Export…” button in Pages.",
  screenshotRef: `alevr-shot://claude:t7/${callId}.jpg`,
  point: { x: 0.4, y: 0.3 },
  frameSize: { width: 1366, height: 768 },
});

test("a call takes the lock, forwards the validated args, and returns text + image + a running→completed item", async () => {
  const path = join(scratch(), "desktop.lock");
  const items: ComputerActionItem[] = [];
  const bridge = new FakeBridge((r) => ({
    id: "x",
    ok: true,
    text: "Clicked the “Export…” button in Pages.\nframe 1366×768 · scale 0.500 · display 1 · app Pages",
    image: { mediaType: "image/jpeg", data: "AAAA" },
    item: shotItem(r.callId!),
  }));
  let t = Date.parse("2026-10-08T20:00:00Z");
  const tools = createComputerTools({
    bridge,
    lock: new DesktopLock({ path, isAlive: () => true }),
    session: { id: "claude:t7", title: "Check the deck", runtimeMode: "ask" },
    onItem: (i) => items.push(i),
    now: () => new Date((t += 250)),
    heartbeatMs: 60_000,
  });
  const result = await tools.call({ action: "click", x: 512, y: 300 }, { callId: "toolu_1" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content[1], { type: "image", data: "AAAA", mimeType: "image/jpeg" });
  assert.deepEqual(bridge.requests[0], {
    type: "computer.call",
    sessionId: "claude:t7",
    title: "Check the deck",
    runtimeMode: "ask",
    callId: "toolu_1",
    args: { action: "click", coordinate_space: "pixels", x: 512, y: 300 },
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].status, "running");
  assert.equal(items[0].id, items[1].id, "the second emission updates the first");
  assert.equal(items[1].status, "completed");
  assert.equal(items[1].screenshotRef, "alevr-shot://claude:t7/toolu_1.jpg");
  assert.ok((items[1].durationMs ?? 0) >= 250, "duration comes from the clock");
  for (const i of items) assert.ok(validates("ComputerActionItem", i));
  const lockRecord = JSON.parse(readFileSync(path, "utf8")) as DesktopLockRecord;
  assert.equal(lockRecord.holderId, "claude:t7");
  assert.equal(lockRecord.kind, "env_server");
  assert.equal(lockRecord.app, "Pages");

  await tools.dispose();
  assert.equal(existsSync(path), false);
  assert.equal(bridge.requests.at(-1)?.type, "computer.release");
});

test("refusals: invalid args never reach the Mac; a held desktop declines; a missing app says what to do; Esc ends the turn", async () => {
  const path = join(scratch(), "desktop.lock");
  const items: ComputerActionItem[] = [];
  const bridge = new FakeBridge(() => new ComputerBridgeUnavailable());
  const session = { id: "codex:t1", title: "", runtimeMode: "auto-edit" as const };
  const tools = createComputerTools({ bridge, lock: new DesktopLock({ path, isAlive: () => true }), session, onItem: (i) => items.push(i) });

  const invalid = await tools.call({ action: "type" }, { callId: "c1" });
  assert.equal(invalid.isError, true);
  assert.equal(bridge.requests.length, 0);
  assert.equal(items.at(-1)?.status, "failed");

  const other = new DesktopLock({ path, pid: 999_999, isAlive: () => true });
  other.acquire({ holderId: "mac:s2", kind: "code_session", title: "Ship it", app: "Xcode" });
  const held = await tools.call({ action: "screenshot" }, { callId: "c2" });
  assert.equal(held.isError, true);
  assert.match((held.content[0] as { text: string }).text, /Alevr is using Xcode for ‘Ship it’/);
  assert.equal(items.at(-1)?.status, "declined");
  other.release("mac:s2");

  const offline = await tools.call({ action: "screenshot" }, { callId: "c3" });
  assert.equal(offline.isError, true);
  assert.match((offline.content[0] as { text: string }).text, /needs the Alevr app open/);

  const stopping = createComputerTools({
    bridge: new FakeBridge(() => ({ id: "x", ok: false, text: "You pressed Esc.", endsTurn: true })),
    lock: new DesktopLock({ path, isAlive: () => true }),
    session: { ...session, images: false },
  });
  const stopped = await stopping.call({ action: "click", x: 1, y: 1 }, { callId: "c4" });
  assert.equal(stopped.isError, true);
  assert.match((stopped.content[0] as { text: string }).text, /You pressed Esc\.\nStop using the computer/);
  assert.equal(existsSync(path), false, "Esc lets go of the desktop");
  await tools.dispose();
});

test("registerComputerTools adds one tool and routes calls with a call id", async () => {
  const path = join(scratch(), "desktop.lock");
  const registered: { def: McpToolDefinition; handler: (a: unknown, e: { callId?: string }) => Promise<unknown> }[] = [];
  const bridge = new FakeBridge((r) => ({ id: "x", ok: true, text: `ok ${r.callId}` }));
  const tools = registerComputerTools(
    { tool: (def, handler) => registered.push({ def, handler }) },
    { bridge, lock: new DesktopLock({ path, isAlive: () => true }), session: { id: "acp:g1", title: "", runtimeMode: "full", coordinateSpace: "normalized_1000" } },
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0].def.name, "computer_use");
  await registered[0].handler({ action: "click", x: 500, y: 500 }, {});
  assert.match(bridge.requests[0].callId!, /^mcp_/);
  assert.equal(bridge.requests[0].args?.coordinate_space, "normalized_1000");
  await tools.dispose();
});

// ── Socket bridge ───────────────────────────────────────────────────────────

test("the unix-socket bridge sends one JSON line with the token and reads the matching answer", async () => {
  const dir = scratch();
  const socketPath = join(dir, "bridge.sock");
  const tokenPath = join(dir, "bridge.token");
  writeFileSync(tokenPath, "secretToken0123456789\n");
  chmodSync(tokenPath, 0o600);
  const seen: ComputerBridgeRequest[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(line) as ComputerBridgeRequest;
      seen.push(request);
      // An unrelated line first, then ours, split across writes.
      socket.write(JSON.stringify({ id: "other", ok: true, text: "" }) + "\n");
      const answer = JSON.stringify({ id: request.id, ok: true, text: "Screen control is ready.", missingPermissions: [] });
      socket.write(answer.slice(0, 10));
      setTimeout(() => socket.write(answer.slice(10) + "\n"), 5);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const bridge = createUnixSocketBridge({ socketPath, tokenPath });
    const response = await bridge.send({ type: "computer.status", sessionId: "s1" });
    assert.equal(response.text, "Screen control is ready.");
    assert.equal(seen[0].token, "secretToken0123456789");
    assert.ok(validates("ComputerBridgeRequest", seen[0]));
    assert.ok(validates("ComputerBridgeResponse", response));

    const missing = createUnixSocketBridge({ socketPath: join(dir, "nope.sock"), tokenPath });
    await assert.rejects(missing.send({ type: "computer.status", sessionId: "s1" }), ComputerBridgeUnavailable);
    const noToken = createUnixSocketBridge({ socketPath, tokenPath: join(dir, "missing.token") });
    await assert.rejects(noToken.send({ type: "computer.status", sessionId: "s1" }), ComputerBridgeUnavailable);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
