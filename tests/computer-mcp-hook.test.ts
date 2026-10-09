import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
} from "../runner/env-server/src/contracts/code-v2";
import type { ComputerBridge } from "../runner/env-server/src/mcp/computer-bridge";
import {
  registerComputerUseOnAlevrMcp,
  sharedComputerToolInputSchema,
  type AlevrMcpRegistry,
  type ComputerMcpScope,
  type ScopedMcpToolDefinition,
} from "../runner/env-server/src/mcp/computer-mcp-hook";
import { DesktopLock } from "../runner/env-server/src/mcp/desktop-lock";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const lockFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "alevr-cu-hook-"));
  dirs.push(dir);
  return join(dir, "desktop.lock");
};

/** The env lane's AlevrMcpServer, reduced to its registration hook. */
class FakeMcp implements AlevrMcpRegistry {
  tools = new Map<string, ScopedMcpToolDefinition>();
  registerTool(tool: ScopedMcpToolDefinition) {
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }
  visible(scope: ComputerMcpScope) {
    return [...this.tools.values()].filter((t) => !t.availableTo || t.availableTo(scope)).map((t) => t.name);
  }
}

class FakeBridge implements ComputerBridge {
  sent: ComputerBridgeRequest[] = [];
  async send(request: ComputerBridgeRequest): Promise<ComputerBridgeResponse> {
    this.sent.push(request);
    return { id: `r${this.sent.length}`, ok: true, text: "Screenshot 1366x768 of Finder", image: { data: "AAAA", mediaType: "image/png" } } as ComputerBridgeResponse;
  }
}

const sessions: Record<string, { title: string }> = { s1: { title: "Fix the build" }, s2: { title: "Other thread" } };
const resolve = (scope: ComputerMcpScope) =>
  sessions[scope.sessionId] ? { id: "ignored", title: sessions[scope.sessionId].title, runtimeMode: "supervised" as const } : undefined;

test("registers one shared computer_use tool, visible only to sessions the resolver knows", async () => {
  const mcp = new FakeMcp();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge: new FakeBridge(), lock: new DesktopLock({ path: lockFile() }), session: resolve });
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 0 }), [ALEVR_COMPUTER_TOOL_NAME]);
  assert.deepEqual(mcp.visible({ sessionId: "nope", depth: 0 }), []);
  const tool = mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!;
  assert.match(tool.description, /normalized_1000/);
  await hook.dispose();
  assert.equal(mcp.tools.size, 0);
});

test("subagents can be kept out", async () => {
  const mcp = new FakeMcp();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge: new FakeBridge(), lock: new DesktopLock({ path: lockFile() }), session: resolve, subagents: false });
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 1 }), []);
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 0 }), [ALEVR_COMPUTER_TOOL_NAME]);
  await hook.dispose();
});

test("the shared schema is flat, compiles, and lets a call pick its coordinate space", () => {
  const schema = sharedComputerToolInputSchema() as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(schema.properties.action.enum, [...COMPUTER_ACTION_VALUES]);
  assert.deepEqual(schema.properties.coordinate_space.enum, ["pixels", "normalized_1000"]);
  const text = JSON.stringify(schema);
  for (const banned of ["oneOf", "anyOf", "allOf", "$ref"]) assert.ok(!text.includes(banned), banned);
  const validate = new Ajv().compile(schema);
  assert.ok(validate({ action: "click", x: 500, y: 500, coordinate_space: "normalized_1000" }));
  assert.ok(!validate({ action: "click", coordinate_space: "inches" }));
});

test("calls go to the bridge under the scoped session id, emit items per session, and dispose releases the lock", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const path = lockFile();
  const lock = new DesktopLock({ path });
  const items: [string, ComputerActionItem][] = [];
  let n = 0;
  const hook = registerComputerUseOnAlevrMcp(mcp, {
    bridge,
    lock,
    session: resolve,
    onItem: (sessionId, item) => items.push([sessionId, item]),
    newCallId: () => `c${++n}`,
    heartbeatMs: 60_000,
  });
  const tool = mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!;
  const signal = new AbortController().signal;

  const result = await tool.handler({ action: "screenshot", app: "Finder" }, { sessionId: "s1", depth: 0 }, signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1]?.type, "image");
  const call = bridge.sent[0] as Extract<ComputerBridgeRequest, { type: "computer.call" }>;
  assert.equal(call.type, "computer.call");
  assert.equal(call.sessionId, "s1");
  assert.equal(call.callId, "c1");
  assert.equal(call.title, "Fix the build");
  assert.deepEqual(hook.activeSessions(), ["s1"]);
  assert.ok(items.length >= 2 && items.every(([sid]) => sid === "s1"));
  assert.equal(items.at(-1)![1].status, "completed");
  assert.equal(items.at(-1)![1].id, "ca_c1");

  // Another session can't take the desktop while s1 holds it.
  const blocked = await tool.handler({ action: "screenshot" }, { sessionId: "s2", depth: 0 }, signal);
  assert.equal(blocked.isError, true);
  assert.equal(bridge.sent.length, 1);

  // Closing s1 lets go: the bridge hears a release and s2 can act.
  await hook.disposeSession("s1");
  assert.equal(bridge.sent.at(-1)!.type, "computer.release");
  const freed = await tool.handler({ action: "screenshot" }, { sessionId: "s2", depth: 0 }, signal);
  assert.equal(freed.isError, undefined);
  await hook.dispose();
  assert.deepEqual(hook.activeSessions(), []);
});

test("an unknown session gets a plain error, never a bridge call", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, lock: new DesktopLock({ path: lockFile() }), session: resolve });
  const r = await mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!.handler({ action: "screenshot" }, { sessionId: "ghost", depth: 0 }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.equal(bridge.sent.length, 0);
  await hook.dispose();
});
