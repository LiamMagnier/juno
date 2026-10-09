import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import type { ClientCommandType, ServerEventEnvelope, ServerMessage, SessionSnapshot } from "../src/contracts/code-v2.js";
import { applySessionEvent } from "../src/protocol/reducer.js";
import { classifyEvent } from "../src/contracts/code-v2.js";
import { AsyncQueue } from "../src/util.js";
import type { ClaudeQueryFn } from "../src/providers/claude-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `alevr-env-${prefix}-`));
}

/** A bin dir with fake vendor CLIs: codex, gemini (ACP), claude (version only). */
export function fakeBinDir(): string {
  const dir = tempDir("bin");
  const wrap = (name: string, script: string, extra = "") => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${extra}exec "${process.execPath}" "${path.join(FIXTURES, script)}" "$@"\n`, { mode: 0o755 });
  };
  wrap("codex", "fake-codex.mjs");
  wrap("gemini", "fake-acp.mjs");
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\necho "2.1.50 (Claude Code)"\n`, { mode: 0o755 });
  return dir;
}

export function initRepo(): string {
  const dir = tempDir("repo");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

export interface Received {
  envelope: ServerEventEnvelope;
}

/** A protocol client that keeps a per-session snapshot by applying events exactly like a real client. */
export class TestClient {
  readonly ws: WebSocket;
  readonly events: ServerEventEnvelope[] = [];
  readonly snapshots = new Map<string, SessionSnapshot>();
  readonly cursors = new Map<string, number>();
  readonly gaps: string[] = [];
  #nextId = 1;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #listeners = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.#onMessage(JSON.parse(data.toString()) as ServerMessage));
  }

  static async connect(url: string, token: string, opts: { protocols?: string[]; headers?: Record<string, string> } = {}): Promise<TestClient> {
    const ws = new WebSocket(url, opts.protocols ?? ["alevr-code-v2"], { headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return new TestClient(ws);
  }

  close(): void {
    this.ws.close();
  }

  command<T = Record<string, unknown>>(type: ClientCommandType, params: Record<string, unknown>): Promise<T> {
    const id = String(this.#nextId++);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, type, params }));
    });
  }

  #onMessage(msg: ServerMessage): void {
    if (msg.type === "response") {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (!p) return;
      if (msg.ok) p.resolve(msg.result ?? {});
      else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    } else {
      this.events.push(msg);
      if (msg.stream === "session" && msg.sessionId) {
        const cursor = this.cursors.get(msg.sessionId) ?? null;
        const disposition = classifyEvent(cursor, msg);
        if (disposition === "apply") {
          const base = this.snapshots.get(msg.sessionId);
          const next = msg.event.type === "session.snapshot" ? msg.event.session : base ? applySessionEvent(base, msg.event) : undefined;
          if (next) this.snapshots.set(msg.sessionId, next);
          this.cursors.set(msg.sessionId, msg.sequence);
        } else if (disposition === "gap") this.gaps.push(`${msg.sessionId}@${msg.sequence}`);
      }
    }
    for (const l of [...this.#listeners]) l();
  }

  waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 8000, label = "condition"): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = predicate();
        if (v) {
          cleanup();
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${label}; last events: ${this.events.slice(-6).map((e) => e.event.type).join(", ")}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#listeners.delete(check);
      };
      this.#listeners.add(check);
      check();
    });
  }

  sessionEvents(sessionId: string): ServerEventEnvelope[] {
    return this.events.filter((e) => e.stream === "session" && e.sessionId === sessionId);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const s = this.snapshots.get(sessionId);
    if (!s) throw new Error(`no snapshot for ${sessionId}`);
    return s;
  }

  turnCompleted(sessionId: string, turnId: string) {
    return this.waitFor(
      () => this.sessionEvents(sessionId).find((e) => e.event.type === "turn.completed" && e.event.turnId === turnId)?.event as Extract<ServerEventEnvelope["event"], { type: "turn.completed" }> | undefined,
      10000,
      `turn ${turnId} to complete`,
    );
  }
}

/**
 * A stand-in for the Claude Agent SDK's query(): consumes the prompt queue
 * like the real CLI and emits SDK messages. Prompt text picks the scenario:
 * "bash" asks canUseTool for Bash, "plan" calls ExitPlanMode, "ask" calls
 * AskUserQuestion, "limit" reports a rejected rate limit, "slow" streams until
 * interrupted.
 */
export function fakeClaudeQuery(record: { options?: unknown[]; prompts?: string[] } = {}): ClaudeQueryFn {
  return ({ prompt, options }) => {
    record.options?.push(options);
    const out = new AsyncQueue<Record<string, unknown>>();
    const session_id = "claude-session-1";
    let interrupted = false;
    let steered: string[] = [];
    let steeredUuids: string[] = [];
    const isProbe = Array.isArray(options.allowedTools) && options.allowedTools.length === 0 && options.persistSession === false;
    const stream = (event: Record<string, unknown>) => out.push({ type: "stream_event", event, parent_tool_use_id: null, uuid: `ev_${Math.random()}`, session_id });
    let busy = false;
    const handle = async (msg: { message: { content: { text: string }[] }; uuid?: string; priority?: string }) => {
      const text = msg.message.content.map((c) => c.text).join(" ");
      record.prompts?.push(text);
      if (busy) {
        steered.push(text);
        if (msg.uuid) steeredUuids.push(msg.uuid);
        return;
      }
      busy = true;
      interrupted = false;
      const consumed = [msg.uuid];
      stream({ type: "message_start" });
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm." } });
      const blocks: Record<string, unknown>[] = [{ type: "thinking", thinking: "Hmm." }];
      // Like the real CLI, every text block is streamed before the assistant message repeats it.
      let answered = "";
      if (/bash/.test(text)) {
        out.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la", description: "List files" } }] }, parent_tool_use_id: null, uuid: "a-tool", session_id });
        const r = await options.canUseTool!("Bash", { command: "ls -la" }, { signal: new AbortController().signal, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }], toolUseID: "tu1" } as never);
        const allowed = r.behavior === "allow";
        out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: allowed ? "README.md\nsrc" : "The user declined this action.", is_error: !allowed }] }, parent_tool_use_id: null, session_id });
        if ((r as { interrupt?: boolean }).interrupt) interrupted = true;
      }
      if (/plan/.test(text)) {
        const r = await options.canUseTool!("ExitPlanMode", { plan: "1. Read the code\n2. Fix the bug" }, { signal: new AbortController().signal, toolUseID: "tu-plan" } as never);
        out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-plan", content: r.behavior === "deny" ? r.message : "ok", is_error: r.behavior === "deny" }] }, parent_tool_use_id: null, session_id });
      }
      if (/ask/.test(text)) {
        const r = await options.canUseTool!("AskUserQuestion", { questions: [{ question: "Which browser?", header: "browser", options: [{ label: "WebKit" }, { label: "Chromium" }] }] }, { signal: new AbortController().signal, toolUseID: "tu-ask" } as never);
        answered = ` answers=${JSON.stringify((r as { updatedInput?: { answers?: unknown } }).updatedInput?.answers ?? null)}`;
      }
      if (/limit/.test(text)) {
        const resetsAt = Math.floor(Date.now() / 1000) + 1800;
        out.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1 }, uuid: "rl", session_id });
        out.push({ type: "assistant", message: { content: [{ type: "text", text: `Claude AI usage limit reached|${resetsAt}` }] }, parent_tool_use_id: null, uuid: "a-limit", session_id, error: "rate_limit" });
        out.push({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${resetsAt}`, usage: { input_tokens: 5, output_tokens: 1 }, user_message_uuids: consumed, session_id });
        busy = false;
        return;
      }
      if (/slow/.test(text)) {
        stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        for (let i = 0; i < 300 && !interrupted && steered.length === 0; i++) {
          stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "." } });
          await new Promise((r) => setTimeout(r, 10));
        }
        if (interrupted) {
          out.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted (interrupt)"], usage: { input_tokens: 5, output_tokens: 1 }, user_message_uuids: consumed, session_id });
          busy = false;
          return;
        }
      }
      const reply = (steered.length ? `Claude heard: ${text} + ${steered.join(" + ")}` : `Claude says: ${text}`) + answered;
      consumed.push(...steeredUuids);
      steered = [];
      steeredUuids = [];
      stream({ type: "content_block_start", index: 9, content_block: { type: "text", text: "" } });
      stream({ type: "content_block_delta", index: 9, delta: { type: "text_delta", text: reply } });
      blocks.push({ type: "text", text: reply });
      out.push({ type: "assistant", message: { content: blocks }, parent_tool_use_id: null, uuid: `a-${Date.now()}`, session_id });
      out.push({ type: "result", subtype: "success", is_error: false, result: reply, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, user_message_uuids: consumed, session_id });
      busy = false;
    };
    void (async () => {
      out.push({ type: "system", subtype: "init", session_id, model: "claude-opus-5-5", tools: [], mcp_servers: [] });
      for await (const msg of prompt) void handle(msg as never);
      out.end();
    })();
    const iterator = out[Symbol.asyncIterator]();
    const q = {
      next: () => iterator.next(),
      return: () => iterator.return!(),
      throw: (e: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]() {
        return q;
      },
      interrupt: async () => {
        interrupted = true;
        return undefined;
      },
      setPermissionMode: async () => {},
      setModel: async () => {},
      initializationResult: async () => ({
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: [],
        models: [
          { value: "default", displayName: "Default (recommended)", description: "", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportedEffortLevels: ["low", "high", "max"] },
        ],
        account: { email: "me@example.com", subscriptionType: "max", tokenSource: "claude.ai" },
      }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 22, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 61, resets_at: null } },
      }),
      close: () => out.end(),
    };
    if (isProbe) record.prompts?.push("<probe>");
    return q as never;
  };
}
