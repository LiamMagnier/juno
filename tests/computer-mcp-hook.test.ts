import assert from "node:assert/strict";
import { test } from "node:test";
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
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge: new FakeBridge(), session: resolve });
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
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, session: resolve, subagents: false });
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
    bridge,
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
  // Parent and child keep separate holds on the Mac (which refuses whichever
  // reaches for the app the other is in); here they only need distinct ids.
  await use.execute({ action: "screenshot" }, { callId: "lead-competes" });
  assert.equal(bridge.sent.at(-1)?.sessionId, "lead");
  await use.finishSubagent!("child");
  assert.deepEqual({ type: bridge.sent.at(-1)?.type, sessionId: bridge.sent.at(-1)?.sessionId }, { type: "computer.release", sessionId: "lead:agent:child" });
  assert.ok(!(await use.execute({ action: "screenshot" }, { callId: "lead-resumes" })).isError);
  await hook.dispose();
});

test("text models receive current accessibility controls and routed vision children receive images", async () => {
  const mcp = new FakeMcp();
  const sent: Omit<ComputerBridgeRequest, "id" | "token">[] = [];
  const bridge: ComputerBridge = {
    async send(request) {
      sent.push(request);
      return { id: "reply", ok: true, text: request.args?.action === "ax_find" ? "e12 AXButton Play" : "Screenshot of Safari",
        image: { data: "AAAA", mediaType: "image/png" } };
    },
  };
  const hook = registerComputerUseOnAlevrMcp(mcp, {
    bridge,
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

test("calls go to the bridge under the scoped session id, emit items per session, and dispose releases the hold", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const items: [string, ComputerActionItem][] = [];
  let n = 0;
  const hook = registerComputerUseOnAlevrMcp(mcp, {
    bridge,
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

  // Many chats at once: another conversation is forwarded too; the Mac's
  // per-app holds decide, so two threads in different apps both run.
  const second = await tool.handler({ action: "screenshot", app: "Notes" }, { sessionId: "s2", depth: 0 }, signal);
  assert.equal(second.isError, undefined);
  assert.equal(bridge.sent.length, 2);
  assert.equal(bridge.sent[1].sessionId, "s2");

  // Closing s1 lets go: the bridge hears a release for s1 only.
  await hook.disposeSession("s1");
  assert.deepEqual({ type: bridge.sent.at(-1)!.type, sessionId: bridge.sent.at(-1)!.sessionId }, { type: "computer.release", sessionId: "s1" });
  assert.deepEqual(hook.activeSessions(), ["s2"]);
  await hook.dispose();
  assert.deepEqual(hook.activeSessions(), []);
});

test("an unknown session gets a plain error, never a bridge call", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, session: resolve });
  const r = await mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!.handler({ action: "screenshot" }, { sessionId: "ghost", depth: 0 }, new AbortController().signal);
  assert.equal(r.isError, true);
  assert.equal(bridge.sent.length, 0);
  await hook.dispose();
});

// ── One conversation, many turns (the owner's "only one conversation" report) ──

/** A Mac that answers like ComputerBridgeExecutor: Accessibility missing first, then granted. */
class PermissionThenGrantedBridge implements ComputerBridge {
  sent: ComputerBridgeRequest[] = [];
  granted = false;
  async send(request: ComputerBridgeRequest): Promise<ComputerBridgeResponse> {
    this.sent.push(request);
    if (request.type !== "computer.call") return { id: "r", ok: true, text: "Released." } as ComputerBridgeResponse;
    if (!this.granted) {
      return { id: "r", ok: false, text: "Alevr needs Accessibility.", endsTurn: true, missingPermissions: ["accessibility"] } as ComputerBridgeResponse;
    }
    return { id: "r", ok: true, text: "Opened Safari." } as ComputerBridgeResponse;
  }
}

test("a permission failure in turn 1 ends that turn's computer use, and turn 2 in the same thread gets through", async () => {
  const mcp = new FakeMcp();
  const bridge = new PermissionThenGrantedBridge();
  let n = 0;
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, session: resolve, newCallId: () => `c${++n}` });
  const tool = mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!;
  const signal = new AbortController().signal;

  const first = await tool.handler({ action: "open_app", app: "Safari" }, { sessionId: "s1", depth: 0 }, signal);
  assert.equal(first.isError, true);
  assert.match((first.content[0] as { text: string }).text, /Accessibility/);
  // The rest of turn 1 does not reach for the Mac again.
  const retry = await tool.handler({ action: "open_app", app: "Safari" }, { sessionId: "s1", depth: 0 }, signal);
  assert.match((retry.content[0] as { text: string }).text, /Computer use stopped/);
  assert.equal(bridge.sent.filter((r) => r.type === "computer.call").length, 1);

  // Turn 1 ends: the Mac hears the release for this thread, under its own id.
  await hook.finishTurn("s1");
  assert.deepEqual({ type: bridge.sent.at(-1)!.type, sessionId: bridge.sent.at(-1)!.sessionId }, { type: "computer.release", sessionId: "s1" });
  assert.deepEqual(hook.activeSessions(), []);

  // The reader grants Accessibility; turn 2 of the same thread acts.
  bridge.granted = true;
  const second = await tool.handler({ action: "open_app", app: "Safari" }, { sessionId: "s1", depth: 0 }, signal);
  assert.equal(second.isError, undefined);
  const calls = bridge.sent.filter((r) => r.type === "computer.call");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.sessionId === "s1"), "every turn of a thread uses the same hold id");
  await hook.dispose();
});

test("turn end releases the thread's hold; computer_release reaches the Mac even with no tools left", async () => {
  const mcp = new FakeMcp();
  const bridge = new FakeBridge();
  const hook = registerComputerUseOnAlevrMcp(mcp, { bridge, session: resolve });
  const signal = new AbortController().signal;
  await mcp.tools.get(ALEVR_COMPUTER_TOOL_NAME)!.handler({ action: "screenshot" }, { sessionId: "s1", depth: 0 }, signal);
  await hook.finishTurn("s1");
  assert.equal(bridge.sent.at(-1)!.type, "computer.release");
  const before = bridge.sent.length;
  // A fresh env server (or tools already disposed): the model's release still lets go on the Mac.
  await mcp.tools.get("computer_release")!.handler({}, { sessionId: "s1", depth: 0 }, signal);
  assert.equal(bridge.sent.length, before + 1);
  assert.deepEqual({ type: bridge.sent.at(-1)!.type, sessionId: bridge.sent.at(-1)!.sessionId }, { type: "computer.release", sessionId: "s1" });
  await hook.dispose();
});
