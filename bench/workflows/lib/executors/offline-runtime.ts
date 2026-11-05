/**
 * Offline plans for behavioural workflows. Each drives a real Alevr module —
 * the calculator, the web reader and injection scanner, the extractors, the
 * MCP client path, the tool dispatcher, the resumable stream, the stall
 * watchdog — and writes a trace of what HARNESS-OWNED instrumentation saw:
 * the fake MCP server's request log, the bench tools' execution log, the raw
 * SSE bytes each simulated device received. The validators read that trace.
 *
 * Product modules are imported lazily (several are server-only and need
 * NODE_OPTIONS=--conditions=react-server, which `npm run bench:workflows` sets).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ExecutionContext } from "../runner";
import type { ChatToolset, ResolvedTool } from "@/lib/tools/types";

const writeJson = (ctx: ExecutionContext, name: string, value: unknown) => writeFileSync(path.join(ctx.outputsDir, name), `${JSON.stringify(value, null, 2)}\n`);
const env = process.env as Record<string, string | undefined>;

// ── Calculator ──────────────────────────────────────────────────────────────

async function calcSteps(ctx: ExecutionContext, expressions: string[], finalLabel: (values: number[]) => string): Promise<void> {
  const { calculate } = await import("@/lib/tools/calc");
  const steps = expressions.map((expression) => {
    const result = calculate(expression);
    if (!result.ok) throw new Error(`calculate(${expression}) failed: ${JSON.stringify(result.error)}`);
    return { expression, value: result.value };
  });
  const answer = steps.at(-1)!.value;
  writeJson(ctx, "trace.json", { tool: "calculate", steps, answer });
  writeFileSync(path.join(ctx.outputsDir, "answer.md"), `${steps.map((s) => `- ${s.expression} = ${s.value}`).join("\n")}\n\n${finalLabel(steps.map((s) => s.value))}\nANSWER: ${answer}\n`);
}

export async function calcParcels(ctx: ExecutionContext): Promise<void> {
  // Each call uses the previous result, as a model chaining tool calls would.
  const { calculate } = await import("@/lib/tools/calc");
  const days = [1240];
  const expressions: string[] = [];
  for (let i = 0; i < 4; i++) {
    const expression = `floor(${days[i]} * 1.15)`;
    const result = calculate(expression);
    if (!result.ok) throw new Error(`calculate(${expression}) failed`);
    expressions.push(expression);
    days.push(result.value);
  }
  expressions.push(days.join(" + "));
  await calcSteps(ctx, expressions, (v) => `Monday to Friday: ${[1240, ...v.slice(0, 4)].join(", ")}.`);
}

export async function calcCents(ctx: ExecutionContext): Promise<void> {
  // The sum step adds the three tool results, as a model chaining calls would.
  const { calculate } = await import("@/lib/tools/calc");
  const conversions = ["floor(4.35 * 100)", "floor(0.29 * 100)", "floor(1.10 * 100)"];
  const parts = conversions.map((e) => {
    const r = calculate(e);
    if (!r.ok) throw new Error(`calculate(${e}) failed`);
    return r.value;
  });
  await calcSteps(ctx, [...conversions, parts.join(" + ")], () => "Sum of the three amounts in cents.");
}

// ── Web reader + injection defences ─────────────────────────────────────────

export async function webInjection(ctx: ExecutionContext): Promise<void> {
  const { htmlToCleanText } = await import("@/lib/web/html-text");
  const { scanUntrusted } = await import("@/lib/web/injection");
  const { wrapUntrusted } = await import("@/lib/untrusted-content");
  const html = readFileSync(path.join(ctx.inputsDir, "research/hostile-page.html"), "utf8");
  const url = "https://northwind.example/meridian-pilot";
  const page = htmlToCleanText(html, url);
  const verdict = scanUntrusted(page.text);
  writeJson(ctx, "trace.json", {
    url,
    extractedChars: page.text.length,
    verdict: { severity: verdict.severity, signals: verdict.signals, matchCount: verdict.matchCount },
    wrapped: wrapUntrusted(url, page.text),
  });
}

// ── Extraction ──────────────────────────────────────────────────────────────

async function extract(ctx: ExecutionContext, input: string, mimeType: string): Promise<void> {
  const { extractDocument } = await import("@/lib/knowledge/extract");
  const bytes = readFileSync(path.join(ctx.inputsDir, input));
  const result = await extractDocument({ bytes: new Uint8Array(bytes), fileName: path.basename(input), mimeType });
  if (!result) throw new Error(`no extractor for ${input}`);
  writeJson(ctx, "extraction.json", result);
  if (result.status === "failed") throw new Error(`extraction failed: ${JSON.stringify((result as { reason?: string }).reason ?? "")}`);
}

export const extractXlsx = (ctx: ExecutionContext) => extract(ctx, "files/invoices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
export const extractPdf = (ctx: ExecutionContext) => extract(ctx, "files/pilot-report.pdf", "application/pdf");
export const extractDocx = (ctx: ExecutionContext) => extract(ctx, "files/meeting-notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

// ── Custom MCP connector ────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

export async function mcpConnector(ctx: ExecutionContext): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { z } = await import("zod");

  const previousEnv = env.NODE_ENV;
  // The loopback exception in mcp-safe-fetch opens only for development/test.
  env.NODE_ENV = "test";
  const { probeCustomMcpServer } = await import("@/lib/custom-connectors");
  const { safeMcpFetch } = await import("@/lib/mcp-safe-fetch");
  const { createPkce, discoverEndpoints, exchangeMcpCode, registerClient } = await import("@/lib/mcp-oauth");

  const TOKEN = `bench-${Math.random().toString(36).slice(2)}`;
  const log = { registrations: 0, tokenRequests: [] as Array<{ hasVerifier: boolean }>, requests: [] as Array<Record<string, unknown>>, unauthenticatedRejected: false };
  const makeMcp = () => {
    const server = new McpServer({ name: "Acme Tools", version: "1.0.0" });
    server.registerTool("search_tickets", { description: "Find tickets", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, async ({ query }) => ({
      content: [{ type: "text" as const, text: `found 3 tickets for ${query}` }],
    }));
    server.registerTool("create_ticket", { description: "File a ticket", inputSchema: { title: z.string() } }, async ({ title }) => ({
      content: [{ type: "text" as const, text: `created ${title}` }],
    }));
    return server;
  };
  const http = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      log.registrations += 1;
      await readBody(req);
      return json(res, 201, { client_id: `client-${log.registrations}` });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      log.tokenRequests.push({ hasVerifier: Boolean(form.get("code_verifier")) });
      if (form.get("code") !== "bench-code" || !form.get("code_verifier")) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: TOKEN, refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization === `Bearer ${TOKEN}`;
      if (!auth) {
        log.unauthenticatedRejected = true;
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const body = JSON.parse(await readBody(req)) as { method?: string; params?: { name?: string; arguments?: unknown } } | Array<{ method?: string }>;
      for (const message of Array.isArray(body) ? body : [body]) {
        const m = message as { method?: string; params?: { name?: string; arguments?: unknown } };
        if (m.method) log.requests.push({ method: m.method, auth, ...(m.method === "tools/call" ? { tool: m.params?.name, args: m.params?.arguments } : {}) });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeMcp();
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(http);
  // The address the server listens on, not "localhost": safeMcpFetch pins the
  // first answer, and where localhost resolves to ::1 first (GitHub's
  // runners) the IPv4-only server refused it and tools-01 failed there only.
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const client: Record<string, unknown> = {};
  // A product error is recorded in the trace rather than thrown, so the
  // validators can say which step broke (probe, sign-in, list or call).
  try {
    const probe = await probeCustomMcpServer(mcpUrl);
    client.probeOk = probe.ok;
    client.probe = probe.ok ? { ok: true, authHost: probe.authHost } : probe;
    const endpoints = await discoverEndpoints(mcpUrl, safeMcpFetch);
    const registered = await registerClient(endpoints, { clientName: "Alevr", clientUri: "https://alevr.test", redirectUri: "https://alevr.test/api/connectors/custom/callback" }, safeMcpFetch);
    const pkce = createPkce();
    const tokens = await exchangeMcpCode(
      { tokenEndpoint: endpoints.tokenEndpoint, client: registered, code: "bench-code", codeVerifier: pkce.verifier, redirectUri: "https://alevr.test/api/connectors/custom/callback", resource: endpoints.resource },
      safeMcpFetch
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, fetch: safeMcpFetch });
    const mcp = new Client({ name: "alevr", version: "1.0.0" });
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    client.toolsListed = tools.map((t) => t.name).sort();
    const result = await mcp.callTool({ name: "search_tickets", arguments: { query: "login" } });
    const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
    client.callResult = content.map((c) => c.text ?? "").join("");
    await mcp.close();
  } catch (error) {
    client.error = (error as Error).message ?? String(error);
  } finally {
    await close(http);
    env.NODE_ENV = previousEnv;
  }
  writeJson(ctx, "trace.json", { server: log, client });
}

export async function mcpSsrf(ctx: ExecutionContext): Promise<void> {
  let connections = 0;
  const canary = createServer((_req, res) => {
    res.writeHead(200);
    res.end("canary");
  });
  canary.on("connection", () => (connections += 1));
  const port = await listen(canary);
  const previousEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  const attempts: Array<Record<string, unknown>> = [];
  try {
    const { customMcpUrlProblem, safeMcpFetch } = await import("@/lib/mcp-safe-fetch");
    const { probeCustomMcpServer } = await import("@/lib/custom-connectors");
    for (const target of ["https://169.254.169.254/latest/meta-data", "https://10.0.0.8/mcp", `http://localhost:${port}/mcp`, `http://127.0.0.1:${port}/mcp`, `http://[::1]:${port}/mcp`]) {
      const policy = customMcpUrlProblem(target);
      let fetchRefused = false;
      let error = "";
      try {
        const res = await safeMcpFetch(target, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000) });
        await res.body?.cancel().catch(() => undefined);
      } catch (e) {
        fetchRefused = true;
        error = (e as Error).message;
      }
      const probe = await probeCustomMcpServer(target);
      attempts.push({ target, policyProblem: policy, fetchRefused, probeOk: probe.ok, refused: Boolean(policy) && fetchRefused && !probe.ok, error: error.slice(0, 160) });
    }
  } finally {
    env.NODE_ENV = previousEnv;
    await close(canary);
  }
  writeJson(ctx, "trace.json", { attempts, canary: { port, connections } });
}

// ── Tool dispatcher ─────────────────────────────────────────────────────────

interface BenchToolLog {
  executions: Array<{ name: string; callId?: string; startedAt: number }>;
  effects: Array<{ name: string; at: number }>;
}

async function benchToolset(log: BenchToolLog, opts: { slowMs?: number; onRunning?: () => void; brokeredWrite?: boolean } = {}) {
  const t0 = performance.now();
  const now = () => Math.round((performance.now() - t0) * 1000) / 1000;
  const lookup: ResolvedTool = {
    name: "lookup_invoice",
    origin: "alevr",
    title: "Look up invoice",
    risk: "read",
    parallelSafe: true,
    timeoutMs: 5_000,
    dedupe: false,
    input: { type: "object", properties: { id: { type: "string", description: "Invoice id." } }, required: ["id"] },
  };
  const publish: ResolvedTool = {
    name: "publish_note",
    origin: "alevr",
    title: "Publish note",
    risk: "write",
    parallelSafe: false,
    timeoutMs: 5_000,
    dedupe: false,
    input: { type: "object", properties: { text: { type: "string", description: "Note text." } }, required: ["text"] },
    spec: {
      id: "publish_note",
      title: "Publish note",
      description: "Publish a note to the team feed.",
      input: { type: "object", properties: { text: { type: "string", description: "Note text." } }, required: ["text"] },
      risk: "write",
      parallelSafe: false,
      timeoutMs: 5_000,
      broker: "juno_runtime",
      async execute(args) {
        log.executions.push({ name: "publish_note", startedAt: now() });
        log.effects.push({ name: "publish_note", at: now() });
        return { status: "succeeded", text: `published: ${String(args.text)}`, body: `published: ${String(args.text)}` };
      },
    },
  };
  const slow: ResolvedTool = {
    name: "slow_import",
    origin: "alevr",
    title: "Slow import",
    risk: "write",
    parallelSafe: false,
    timeoutMs: 10_000,
    dedupe: false,
    input: { type: "object", properties: { batch: { type: "string", description: "Batch." } }, required: ["batch"] },
  };
  const tools = [lookup, publish, slow];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const toolset: ChatToolset = {
    tools: tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.title, parameters: tool.input as unknown as Record<string, unknown> } })),
    resolve: (name: string) => byName.get(name),
    labelFor: (name: string) => byName.get(name)?.title ?? name,
    accessFor: (name: string) => (byName.get(name)?.risk === "read" ? "read" : "write"),
    async execute(name, args, signal, callId, execOpts) {
      log.executions.push({ name, callId, startedAt: now() });
      execOpts?.onAuthorized?.();
      if (name === "slow_import") {
        opts.onRunning?.();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            // The side effect commits only if nobody stopped the call.
            log.effects.push({ name, at: now() });
            resolve();
          }, opts.slowMs ?? 300);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      const text = `${name}:${JSON.stringify(args)}`;
      return { text, body: text, ok: true };
    },
    close: async () => {},
  } as ChatToolset;
  return { toolset, now };
}

type DispatchEvent = { type?: string; phase?: string; callId?: string; status?: string; error?: { code?: string } };

async function drain(gen: AsyncGenerator<unknown, unknown>): Promise<{ events: DispatchEvent[]; threw: unknown }> {
  const events: DispatchEvent[] = [];
  try {
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value as DispatchEvent);
    }
    return { events, threw: null };
  } catch (error) {
    return { events, threw: error };
  }
}

const callInput = (callId: string, name: string, argsText: string, index: number) => ({ callId, name, argsText, round: 1, index });

export async function toolDispatch(ctx: ExecutionContext): Promise<void> {
  const { executeToolBatch } = await import("@/lib/tools/dispatch");
  const log: BenchToolLog = { executions: [], effects: [] };
  const { toolset } = await benchToolset(log);
  const authorizationRequests: Array<{ toolName: unknown }> = [];
  const calls = [
    callInput("call-1", "lookup_invoice", '{"id":"I01"}', 0),
    callInput("call-2", "lookup_invoice", '{"id":"I02"}', 1),
    callInput("call-3", "publish_note", '{"text":"I01 and I02 are paid"}', 2),
    callInput("call-4", "lookup_invoice", '{"id":', 3),
    callInput("call-5", "delete_everything", "{}", 4),
  ];
  const { events } = await drain(
    executeToolBatch(calls, new AbortController().signal, {
      toolset,
      toolContext: { userId: "bench-user", conversationId: "bench-conversation", generationId: "bench-generation" },
      ports: {
        authorizeExternalAction: async (request) => {
          authorizationRequests.push({ toolName: request.toolName });
          return { kind: "refused", receiptId: "bench-receipt", reason: "The person denied this action.", status: "denied" };
        },
      },
    })
  );
  const results = events.filter((e) => e.type === "tool" && e.phase === "result").map((e) => ({ callId: e.callId, status: e.status, error: e.error ?? null }));
  // The same write with no authorization broker wired at all must fail closed.
  const brokerlessLog: BenchToolLog = { executions: [], effects: [] };
  const { toolset: brokerlessToolset } = await benchToolset(brokerlessLog);
  const brokerless = await drain(executeToolBatch([callInput("call-b1", "publish_note", '{"text":"x"}', 0)], new AbortController().signal, { toolset: brokerlessToolset, ports: {} }));
  const brokerlessResult = brokerless.events.find((e) => e.type === "tool" && e.phase === "result");
  writeJson(ctx, "trace.json", {
    callOrder: calls.map((c) => c.callId),
    executions: log.executions,
    authorizationRequests,
    results,
    brokerless: { executed: brokerlessLog.executions.length > 0, status: brokerlessResult?.status ?? null, errorCode: brokerlessResult?.error?.code ?? null },
  });
}

export async function toolStop(ctx: ExecutionContext): Promise<void> {
  const { executeToolBatch } = await import("@/lib/tools/dispatch");
  const log: BenchToolLog = { executions: [], effects: [] };
  const controller = new AbortController();
  let stopAt = Number.POSITIVE_INFINITY;
  const { toolset, now } = await benchToolset(log, {
    slowMs: 400,
    onRunning: () => {
      // Press Stop 100 ms after the slow write starts running.
      setTimeout(() => {
        stopAt = now();
        controller.abort(new DOMException("Stopped by the person", "AbortError"));
      }, 100);
    },
  });
  const calls = [
    callInput("call-1", "slow_import", '{"batch":"A"}', 0),
    callInput("call-2", "lookup_invoice", '{"id":"I01"}', 1),
    callInput("call-3", "slow_import", '{"batch":"B"}', 2),
  ];
  const { events, threw } = await drain(executeToolBatch(calls, controller.signal, { toolset }));
  // Let any tool that ignored the abort reach its commit time before we look.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const results = events.filter((e) => e.type === "tool" && e.phase === "result").map((e) => ({ callId: e.callId, status: e.status, wasRunningOrQueued: true }));
  writeJson(ctx, "trace.json", { stopAt, calls: calls.length, executions: log.executions, effects: log.effects, results, threwAbort: Boolean(threw) });
}

// ── Resumable stream: drop + resume, second device ──────────────────────────

const ANSWER = Array.from({ length: 24 }, (_, i) => `Sentence ${i + 1} of the Meridian answer — median response 12 → 9 hours (é, 東京, 🚀). `).join("");

interface LogRow {
  generationId: string;
  seq: number;
  kind: string;
  payload: string;
}

/** A fake ReadableStreamDefaultController that records bytes until the client "drops". */
function connection(device: string, label: string) {
  const decoder = new TextDecoder();
  const record = { device, label, raw: "", dropped: false };
  const controller = {
    desiredSize: 1,
    enqueue(bytes: Uint8Array) {
      if (record.dropped) throw new TypeError("Invalid state: the client disconnected");
      record.raw += decoder.decode(bytes);
    },
    close() {},
    error() {},
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { record, controller };
}

async function streamScenario(ctx: ExecutionContext, mode: "resume" | "second-device"): Promise<void> {
  const { createStreamLog } = await import("@/lib/chat/stream-log");
  const { createSseSender, encodeSseFrame, parseSseFrame } = await import("@/lib/chat-stream");
  const { replayStream, createFrameSequencer } = await import("@/lib/chat/stream-replay");
  const generationId = "bench-generation";
  const store: LogRow[] = [];
  let terminal = false;
  const log = createStreamLog({ generationId, write: async (rows) => void store.push(...rows), flushEvery: 1 });
  const live = connection("deviceA", "live");
  const sender = createSseSender(live.controller, { log });
  const connections = [live.record];
  const port = {
    eventsAfter: async (_g: string, after: number, limit: number) => store.filter((r) => r.seq > after).slice(0, limit),
    liveness: async () => (terminal ? ("terminal" as const) : ("running" as const)),
  };
  const replay = async (device: string, label: string, after: number, stopAfterFrames = Number.POSITIVE_INFINITY) => {
    const conn = connection(device, label);
    connections.push(conn.record);
    const abort = new AbortController();
    let frames = 0;
    for await (const event of replayStream(port, { generationId, after, signal: abort.signal, pollMs: 1, terminalGraceMs: 50, heartbeatMs: 10_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })) {
      if (event.type === "frame") {
        conn.controller.enqueue(encodeSseFrame(event.payload, event.seq));
        frames += 1;
        if (frames >= stopAfterFrames) {
          conn.record.dropped = true;
          abort.abort();
          break;
        }
      }
      if (event.type === "end") break;
    }
    return conn.record;
  };

  // The provider's text, split the way a model streams it.
  const pieces = ANSWER.match(/.{1,37}/gsu) ?? [ANSWER];
  sender.send({ type: "meta", conversationId: "bench-conversation", userMessageId: "bench-user-message", title: "Meridian", generationId, resumable: true });
  const half = Math.floor(pieces.length / 2);
  let deviceB: Promise<unknown> | null = null;
  for (let i = 0; i < pieces.length; i++) {
    sender.send({ type: "delta", text: pieces[i] });
    await log.flush();
    // Yield to the timer queue so a concurrent reader really interleaves.
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (mode === "resume" && i === half) live.record.dropped = true; // the network drops
    if (mode === "second-device" && i === half) deviceB = replay("deviceB", "phone-joins", 0);
  }
  sender.send({
    type: "done",
    message: { id: "bench-assistant-message", role: "ASSISTANT", content: ANSWER, createdAt: new Date(0).toISOString(), attachments: [] } as never,
    artifacts: [],
    memoryUpdated: false,
    quota: { plan: "PRO", used: 1, limit: 100, remaining: 99 } as never,
    finishReason: "stop",
  });
  await log.close();
  terminal = true;

  // Client-side stitching with the product's own SSE parser and frame sequencer.
  const clientText: Record<string, string> = {};
  const applyAll = (device: string, raws: string[]) => {
    const sequencer = createFrameSequencer(0);
    let text = "";
    for (const raw of raws) {
      for (const block of raw.split("\n\n")) {
        const frame = parseSseFrame(block);
        if (!frame || !sequencer.accept(frame.id)) continue;
        const chunk = JSON.parse(frame.data) as { type: string; text?: string };
        if (chunk.type === "delta" && chunk.text) text += chunk.text;
      }
    }
    clientText[device] = text;
  };

  if (mode === "resume") {
    // Reconnect from the last seq device A applied, drop again after 5 frames,
    // then RETRY with the same stale cursor — the overlap the sequencer must absorb.
    const seen = createFrameSequencer(0);
    for (const block of live.record.raw.split("\n\n")) {
      const frame = parseSseFrame(block);
      if (frame) seen.accept(frame.id);
    }
    const cursor = seen.lastSeq;
    await replay("deviceA", "resume-1 (drops again)", cursor, 5);
    await replay("deviceA", "resume-2 (retried with the same cursor)", cursor);
    applyAll("deviceA", connections.filter((c) => c.device === "deviceA").map((c) => c.raw));
  } else {
    await deviceB;
    applyAll("deviceA", [live.record.raw]);
    applyAll("deviceB", connections.filter((c) => c.device === "deviceB").map((c) => c.raw));
    writeFileSync(path.join(ctx.outputsDir, "device-b.sse"), connections.filter((c) => c.device === "deviceB").map((c) => c.raw).join(""));
  }
  writeJson(ctx, "trace.json", { truthText: ANSWER, loggedFrames: store.length, connections, clientText });
}

export const streamResume = (ctx: ExecutionContext) => streamScenario(ctx, "resume");
export const secondDevice = (ctx: ExecutionContext) => streamScenario(ctx, "second-device");

// ── Stall watchdog ──────────────────────────────────────────────────────────

export async function stallWatchdog(ctx: ExecutionContext): Promise<void> {
  const { createStallWatchdog, stallMessageFor } = await import("@/lib/chat-stall");
  const idleMs = 300;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const partial = ["The pilot ", "raised volume ", "by 25% and "];
  let text = "";
  let lastEventAt = 0;
  let stalledAt = -1;
  const stalled = await new Promise<boolean>((resolve) => {
    // A referenced guard: the watchdog's own timer is unref'd (it must never
    // hold a server open), so without this the process could exit mid-wait.
    // It also bounds the wait when the watchdog never fires.
    const guard = setTimeout(() => resolve(false), 3_000);
    const watchdog = createStallWatchdog(() => {
      stalledAt = now();
      clearTimeout(guard);
      resolve(true);
    }, idleMs, 2_000);
    let i = 0;
    const tick = () => {
      if (i < partial.length) {
        text += partial[i++];
        lastEventAt = now();
        watchdog.touch();
        setTimeout(tick, 40);
      }
      // …then the provider goes silent.
    };
    tick();
  });
  // Second scenario: a tool runs longer than the idle window under a hold.
  const holdStalled = await new Promise<boolean>((resolve) => {
    let fired = false;
    const watchdog = createStallWatchdog(() => (fired = true), idleMs, 2_000);
    watchdog.touch();
    const release = watchdog.hold();
    setTimeout(() => {
      release();
      watchdog.stop();
      resolve(fired);
    }, idleMs * 3);
  });
  writeJson(ctx, "trace.json", {
    idleMs,
    stalled,
    stalledAt,
    lastEventAt,
    userMessage: stallMessageFor({ startedStreaming: true }),
    partialText: text,
    truthPartial: partial.join(""),
    holdScenario: { toolRunMs: idleMs * 3, stalled: holdStalled },
  });
}
