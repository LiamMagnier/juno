#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC over stdio, enough of the v2
// surface for the env server's adapter tests. The prompt text picks the
// scenario: "approve" asks for a command approval, "slow" streams until it is
// interrupted or steered, "limit" fails with usageLimitExceeded, "write <file>"
// writes a file into the cwd like a shell command would.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.0\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") {
  process.stderr.write("fake codex: only app-server is emulated\n");
  process.exit(2);
}

const signedOut = process.env.FAKE_CODEX_SIGNED_OUT === "1";
let nextId = 1000;
const pending = new Map();
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

let thread = null;
let active = null; // { id, steered: [], interrupted: false, wake }
let turnSeq = 0;
let initialized = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(params) {
  const turnId = `turn_${++turnSeq}`;
  const text = params.input.map((i) => i.text ?? "").join(" ");
  const turn = { id: turnId, steered: [], interrupted: false, wake: null };
  active = turn;
  notify("turn/started", { threadId: thread, turn: { id: turnId, status: "inProgress", items: [] } });
  const finish = (status, error) => {
    notify("thread/tokenUsage/updated", {
      threadId: thread,
      turnId,
      tokenUsage: {
        total: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, reasoningOutputTokens: 10, totalTokens: 1280 },
        last: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, reasoningOutputTokens: 10, totalTokens: 1280 },
        modelContextWindow: 272000,
      },
    });
    notify("turn/completed", { threadId: thread, turn: { id: turnId, status, items: [], ...(error ? { error } : {}) } });
    active = null;
  };
  // Reasoning summary first.
  notify("item/started", { threadId: thread, turnId, startedAtMs: Date.now(), item: { id: "r1", type: "reasoning", summary: [], content: [] } });
  notify("item/reasoning/summaryTextDelta", { threadId: thread, turnId, itemId: "r1", summaryIndex: 0, delta: "Thinking about it." });
  notify("item/completed", { threadId: thread, turnId, completedAtMs: Date.now(), item: { id: "r1", type: "reasoning", summary: ["Thinking about it."], content: [] } });

  if (/limit/.test(text)) {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, resetsAt, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } });
    notify("error", { threadId: thread, turnId, willRetry: false, error: { message: "You've hit your usage limit. Try again in 1 hour.", codexErrorInfo: "usageLimitExceeded" } });
    finish("failed", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" });
    return;
  }

  if (/approve/.test(text)) {
    notify("item/started", { threadId: thread, turnId, startedAtMs: Date.now(), item: { id: "c1", type: "commandExecution", command: "npm test", cwd: params.cwd ?? "/", commandActions: [], status: "inProgress" } });
    const answer = await request("item/commandExecution/requestApproval", { threadId: thread, turnId, itemId: "c1", command: "npm test", cwd: params.cwd, reason: "Run the test suite", startedAtMs: Date.now() });
    if (answer.decision === "accept" || answer.decision === "acceptForSession") {
      notify("item/commandExecution/outputDelta", { threadId: thread, turnId, itemId: "c1", delta: "ok 1 - passes\n" });
      notify("item/completed", { threadId: thread, turnId, completedAtMs: Date.now(), item: { id: "c1", type: "commandExecution", command: "npm test", cwd: params.cwd ?? "/", commandActions: [], status: "completed", exitCode: 0, aggregatedOutput: "ok 1 - passes\n", durationMs: 12 } });
    } else {
      notify("item/completed", { threadId: thread, turnId, completedAtMs: Date.now(), item: { id: "c1", type: "commandExecution", command: "npm test", cwd: "/", commandActions: [], status: "declined" } });
    }
  }

  const write = text.match(/write (\S+)/);
  if (write && params.cwd) {
    fs.writeFileSync(path.join(params.cwd, write[1]), `written by fake codex turn ${turnSeq}\n`);
    notify("item/completed", {
      threadId: thread,
      turnId,
      completedAtMs: Date.now(),
      item: { id: "f1", type: "fileChange", status: "completed", changes: [{ path: write[1], kind: { type: "add" }, diff: `+written by fake codex turn ${turnSeq}` }] },
    });
  }

  if (/slow/.test(text)) {
    notify("item/started", { threadId: thread, turnId, startedAtMs: Date.now(), item: { id: "m0", type: "agentMessage", text: "" } });
    for (let i = 0; i < 400 && !turn.interrupted && turn.steered.length === 0; i++) {
      notify("item/agentMessage/delta", { threadId: thread, turnId, itemId: "m0", delta: "." });
      await wait(10);
    }
    notify("item/completed", { threadId: thread, turnId, completedAtMs: Date.now(), item: { id: "m0", type: "agentMessage", text: "..." } });
    if (turn.interrupted) {
      finish("interrupted");
      return;
    }
  }

  const reply = turn.steered.length ? `Done, and noted: ${turn.steered.join(" / ")}` : `Done: ${text}`;
  notify("item/started", { threadId: thread, turnId, startedAtMs: Date.now(), item: { id: "m1", type: "agentMessage", text: "" } });
  for (const word of reply.split(/(?= )/)) notify("item/agentMessage/delta", { threadId: thread, turnId, itemId: "m1", delta: word });
  notify("item/completed", { threadId: thread, turnId, completedAtMs: Date.now(), item: { id: "m1", type: "agentMessage", text: reply } });
  finish("completed");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg.result ?? {});
    return;
  }
  const { id, method, params = {} } = msg;
  const reply = (result) => send({ id, result });
  const fail = (message, data) => send({ id, error: { code: -32000, message, ...(data ? { data } : {}) } });
  switch (method) {
    case "initialize":
      if (!params.clientInfo?.name) return fail("clientInfo required");
      return reply({ userAgent: "fake-codex/0.160.0" });
    case "initialized":
      initialized = true;
      return;
    case "account/read":
      return reply(signedOut ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresOpenaiAuth: true });
    case "model/list":
      if (!params.cursor)
        return reply({
          data: [{ id: "gpt-6.1-codex", model: "gpt-6.1-codex", displayName: "GPT-6.1 Codex", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }] }],
          nextCursor: "p2",
        });
      return reply({ data: [{ id: "gpt-6.1-mini", model: "gpt-6.1-mini", displayName: "GPT-6.1 mini", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null });
    case "account/rateLimits/read":
      return reply({ rateLimits: { primary: { usedPercent: 12, resetsAt: Math.floor(Date.now() / 1000) + 7200, windowDurationMins: 300 }, secondary: { usedPercent: 30, windowDurationMins: 10080 } } });
    case "thread/start":
      if (!initialized) return fail("not initialized");
      thread = `thr_${Date.now()}`;
      if (process.env.FAKE_CODEX_RECORD) fs.appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ method, params }) + "\n");
      return reply({ thread: { id: thread, turns: [] }, model: params.model ?? "gpt-6.1-codex" });
    case "thread/resume":
      thread = params.threadId;
      return reply({ thread: { id: thread, turns: [] } });
    case "turn/start": {
      if (process.env.FAKE_CODEX_RECORD) fs.appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ method, params }) + "\n");
      const turnId = `turn_${turnSeq + 1}`;
      reply({ turn: { id: turnId, status: "inProgress", items: [] } });
      void runTurn(params);
      return;
    }
    case "turn/steer":
      if (!active || params.expectedTurnId !== active.id) return fail("no active turn");
      active.steered.push(params.input.map((i) => i.text).join(" "));
      return reply({ turnId: active.id });
    case "turn/interrupt":
      if (active) active.interrupted = true;
      return reply({});
    case "thread/revert":
      return reply({});
    default:
      return fail(`unknown method ${method}`);
  }
});
