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
  sessions[scope.sessionId] ? { id: "ignored", title: sessions[scope.sessionId].title, runtimeMode: "ask" as const } : undefined;

test("registers one shared computer_use tool, visible only to sessions the resolver knows", async () => {
  const mcp = new FakeMcp();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge: new FakeBridge(), lock: new DesktopLock({ path: lockFile() }), session: resolve });
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 0 }), [ALEVR_COMPUTER_TOOL_NAME, "computer_release"]);
  assert.deepEqual(mcp.visible({ sessionId: "nope", depth: 0 }), []);
  const tool = mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!;
  assert.match(tool.description, /normalized_1000/);
  await hook.dispose();
  assert.equal(mcp.tools.size, 0);
});

test("subagents can be kept out", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, lock: new DesktopLock({ path: lockFile() }), session: resolve, subagents: false });
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 1 }), []);
  assert.deepEqual(mcp.visible({ sessionId: "s1", depth: 0 }), [ALEVR_COMPUTER_TOOL_NAME, "computer_release"]);
  const [use] = hook.engineTools({ sessionId: "s1", depth: 0 }) as { execute(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ isError?: boolean }> }[];
  assert.equal((await use!.execute({ action: "screenshot" }, { agentId: "child" })).isError, true);
  assert.equal(bridge.sent.length, 0);
  await hook.dispose();
});

test("built-in engine and children receive images, current permissions and separate desktop ownership", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  let mode: "full" | "read-only" = "full";
  const hook = registerComputerUseOnAlevrMcp(mcp, {
    bridge, lock: new DesktopLock({ path: lockFile() }),
    session: () => ({ id: "lead", title: "App task", runtimeMode: mode, images: true }),
  });
  type Tool = { spec: { name: string }; execute(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ output: string; isError?: boolean; images?: unknown[] }>; finishSubagent?(id: string): Promise<void> };
  const tools = hook.engineTools({ sessionId: "lead", depth: 0 }) as Tool[];
  const use = tools.find((t) => t.spec.name === "computer_use")!;
  const release = tools.find((t) => t.spec.name === "computer_release")!;
  const first = await use.execute({ action: "screenshot", app: "Safari" }, { callId: "first", permissionMode: "full" });
  assert.ok(first.images?.length);
  mode = "read-only";
  await use.execute({ action: "screenshot" }, { callId: "next", permissionMode: "plan" });
  assert.equal(bridge.sent.at(-1)?.runtimeMode, "read-only");
  await release.execute({}, {});
  mode = "full";
  const child = await use.execute({ action: "screenshot" }, { callId: "child-shot", agentId: "child", model: "gemini-3.8", permissionMode: "ask" });
  assert.ok(!child.isError);
  assert.equal(bridge.sent.at(-1)?.sessionId, "lead:agent:child");
  assert.equal(bridge.sent.at(-1)?.args?.coordinate_space, "normalized_1000");
  assert.equal(bridge.sent.at(-1)?.runtimeMode, "ask");
  await hook.finishTurn("lead");
  assert.ok(hook.activeSessions().includes("lead:agent:child"), "background children survive the lead's turn end");
  const competing = await use.execute({ action: "screenshot" }, { callId: "lead-competes" });
  assert.ok(competing.isError, "a parent cannot steal a child's active desktop");
  await use.finishSubagent!("child");
  assert.ok(!(await use.execute({ action: "screenshot" }, { callId: "lead-resumes" })).isError);
  await hook.dispose();
});

test("text models receive current accessibility controls and routed vision children receive images", async () => {
  const mcp = new FakeMcp();
  const sent: ComputerBridgeRequest[] = [];
  const bridge: ComputerBridge = {
    async send(request) {
      sent.push(request);
      return { id: "reply", ok: true, text: request.args?.action === "ax_find" ? "e12 AXButton Play" : "Screenshot of Safari",
        image: { data: "AAAA", mediaType: "image/png" } };
    },
  };
  const hook = registerComputerUseOnAlevrMcp(mcp, {
    bridge, lock: new DesktopLock({ path: lockFile() }),
    session: () => ({ id: "lead", title: "App task", runtimeMode: "full", images: false }),
  });
  type Tool = { execute(input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ output: string; images: unknown[] }>; finishSubagent?(id: string): Promise<void> };
  const [use, release] = hook.engineTools({ sessionId: "lead", depth: 0 }) as Tool[];
  try {
    const text = await use!.execute({ action: "open_app", app: "Safari" }, { callId: "open", supportsVision: false });
    assert.match(text.output, /e12 AXButton Play/);
    assert.deepEqual(text.images, []);
    assert.deepEqual(sent.map((request) => request.args?.action), ["open_app", "ax_find"]);
    await use!.execute({ action: "ax_find", app: "Safari" }, { callId: "find", supportsVision: false });
    assert.equal(sent.length, 3, "an explicit accessibility read is not repeated");
    await release!.execute({}, {});
    const child = await use!.execute({ action: "screenshot", app: "Safari" }, { callId: "shot", agentId: "vision", supportsVision: true });
    assert.equal(child.images.length, 1);
    assert.equal(sent.at(-1)?.sessionId, "lead:agent:vision");
    await use!.finishSubagent!("vision");
  } finally {
    await hook.dispose();
  }
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
  const call = bridge.sent[0] as ComputerBridgeRequest;
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
