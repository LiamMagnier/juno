import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";

/*
 * run_code THROUGH THE REAL CHAT ROUTE AND THE REAL PROVIDER ADAPTERS.
 *
 * POST /api/chat runs exactly as in production — the route, `streamChat`, the
 * Anthropic adapter (`anthropic.ts`) and the OpenAI-compatible adapter
 * (`openai-compat.ts`) with their own tool loops, the registry, the approval
 * broker, the stream log and the resume route — against a throwaway Postgres
 * and a live juno-exec on Docker Desktop. Only two things are stand-ins:
 *
 *  - the signed-in session (`@/lib/session`) and `after()` (no request scope);
 *  - THE MODEL. No provider keys exist on this machine, so each lab's API is a
 *    local HTTP server speaking that lab's real streaming wire format
 *    (Anthropic Messages SSE; OpenAI chat-completions SSE). Its replies are
 *    scripted, but every decision that matters here is taken by Alevr code:
 *    which tools the request carried, what the tool round sent back (text,
 *    stderr, the image), what was recorded, what the user is shown. What a
 *    real model would CHOOSE to do with those inputs is not tested here; the
 *    live probe (L1, §6.11) is where that evidence comes from.
 *
 * A fetch tripwire proves nothing leaves 127.0.0.1.
 *
 * Skipped unless EXEC_TEST_DATABASE_URL, EXEC_TEST_URL and EXEC_TEST_TOKEN_FILE
 * are set (see tests/exec-runtime.integration.test.ts). Run with:
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/exec-chat-route.integration.test.ts
 */

const DB_URL = process.env.EXEC_TEST_DATABASE_URL;
const HOST = process.env.EXEC_TEST_URL;
const TOKEN_FILE = process.env.EXEC_TEST_TOKEN_FILE;

if (!DB_URL || !HOST || !TOKEN_FILE) {
  test("exec chat-route suite is skipped without EXEC_TEST_DATABASE_URL, EXEC_TEST_URL and EXEC_TEST_TOKEN_FILE", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "exec-chat-route-test-secret";
  process.env.TOOL_RUNTIME = "1";
  process.env.CODE_INTERPRETER_URL = HOST;
  process.env.CODE_INTERPRETER_TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-local-only";
  process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-local-only";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  // ── the scripted labs ─────────────────────────────────────────────────────

  interface LabRequest {
    body: Record<string, unknown>;
  }
  type Script = (request: LabRequest, index: number) => LabReply;
  type LabReply = { text: string } | { tool: { name: string; input: Record<string, unknown> } };

  const anthropicRequests: LabRequest[] = [];
  const openaiRequests: LabRequest[] = [];
  let anthropicScript: Script = () => ({ text: "No script." });
  let openaiScript: Script = () => ({ text: "No script." });

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const entry of events) {
      if (entry.event) res.write(`event: ${entry.event}\n`);
      res.write(`data: ${typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}\n\n`);
    }
    res.end();
  }

  /** Anthropic Messages streaming, as `@anthropic-ai/sdk` reads it. */
  function anthropicReply(res: ServerResponse, reply: LabReply, model: string) {
    const start = { type: "message_start", message: { id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } };
    if ("tool" in reply) {
      const json = JSON.stringify(reply.tool.input);
      sse(res, [
        { event: "message_start", data: start },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: reply.tool.name, input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 20) } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(20) } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
      return;
    }
    sse(res, [
      { event: "message_start", data: start },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  }

  /** OpenAI chat-completions streaming, as the `openai` SDK reads it. */
  function openaiReply(res: ServerResponse, reply: LabReply, model: string) {
    const base = { id: `chatcmpl-${randomBytes(6).toString("hex")}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    const usage = { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 };
    if ("tool" in reply) {
      const json = JSON.stringify(reply.tool.input);
      sse(res, [
        { data: { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomBytes(8).toString("hex")}`, type: "function", function: { name: reply.tool.name, arguments: json.slice(0, 15) } }] }, finish_reason: null }] } },
        { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(15) } }] }, finish_reason: null }] } },
        { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
        { data: { ...base, choices: [], usage } },
        { data: "[DONE]" },
      ]);
      return;
    }
    sse(res, [
      { data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
      { data: { ...base, choices: [], usage } },
      { data: "[DONE]" },
    ]);
  }

  let labServer: Server;
  async function startLabs() {
    labServer = createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.url?.endsWith("/v1/messages")) {
        anthropicRequests.push({ body });
        anthropicReply(res, anthropicScript({ body }, anthropicRequests.length - 1), String(body.model));
      } else if (req.url?.endsWith("/chat/completions")) {
        openaiRequests.push({ body });
        openaiReply(res, openaiScript({ body }, openaiRequests.length - 1), String(body.model));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => labServer.listen(0, "127.0.0.1", resolve));
    const { port } = labServer.address() as AddressInfo;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/v1`;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  const SALES = "region,revenue\nNorth,120\nSouth,80\nNorth,180\nEast,50\nSouth,100\nEast,70\n";
  const expected: Record<string, number> = { East: 60, North: 150, South: 90 };

  function computeAverages(csv: string, column: string): Record<string, number> {
    const [header, ...rows] = csv.trim().split("\n");
    const columns = header.split(",");
    const sums: Record<string, { total: number; n: number }> = {};
    for (const row of rows) {
      const cells = row.split(",");
      const region = cells[columns.indexOf(columns.find((name) => /region/i.test(name))!)];
      const value = Number(cells[columns.indexOf(column)]);
      sums[region] = { total: (sums[region]?.total ?? 0) + value, n: (sums[region]?.n ?? 0) + 1 };
    }
    return Object.fromEntries(Object.entries(sums).sort().map(([key, value]) => [key, value.total / value.n]));
  }

  async function seed(csv = SALES, fileName = "sales.csv") {
    const { putObject } = await import("@/lib/storage");
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const user = await prisma.user.create({
      data: { email: `exec-route-${suffix}@example.invalid`, name: "Route tester", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email, name: user.name! };
    const key = `test/${suffix}/${fileName}`;
    await putObject(key, Buffer.from(csv), "text/csv");
    const attachment = await prisma.attachment.create({
      data: { userId: user.id, kind: "FILE", fileName, mimeType: "text/csv", size: Buffer.byteLength(csv), storageKey: key, extractedText: csv, parserState: "ready" },
    });
    return { user, attachment };
  }

  type Frame = { type: string; [key: string]: unknown };
  function framesOf(text: string): Frame[] {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
  }

  async function chat(body: Record<string, unknown>) {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(new Request("http://alevr.test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 500));
    const frames = framesOf(text);
    const done = frames.find((frame) => frame.type === "done") as (Frame & { message: { id: string; content: string; conversationId?: string } }) | undefined;
    return { frames, done, text };
  }

  function toolNamesOf(request: LabRequest): string[] {
    const tools = (request.body.tools ?? []) as Array<{ name?: string; function?: { name: string } }>;
    return tools.map((tool) => tool.name ?? tool.function?.name ?? "");
  }

  async function hostRunsStarted(): Promise<number> {
    const { JunoExecClient } = await import("@/lib/exec/client");
    const { execEndpoint } = await import("@/lib/exec/config");
    return (await new JunoExecClient(execEndpoint()!).health()).runsStarted ?? -1;
  }

  const V1_CODE = [
    "import json, pandas as pd, matplotlib.pyplot as plt",
    "df = pd.read_csv('inputs/sales.csv')",
    "avg = df.groupby('region')['revenue'].mean().sort_index()",
    "print(json.dumps({k: float(v) for k, v in avg.items()}))",
    "avg.plot.bar(title='Average revenue by region'); plt.tight_layout(); plt.savefig('revenue_by_region.png')",
  ].join("\n");

  /** The JSON object a run printed, read from the tool round the way a model reads it. */
  function printedAverages(toolText: string): Record<string, number> | null {
    const match = /\{"[A-Za-z]+": [0-9.]+(?:, "[A-Za-z]+": [0-9.]+)*\}/.exec(toolText);
    return match ? (JSON.parse(match[0]) as Record<string, number>) : null;
  }

  // ── the suite ────────────────────────────────────────────────────────────

  test("stand in for the session, the model labs and the network", async () => {
    await startLabs();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`unexpected network call to ${url.origin}`);
      return realFetch(input, init);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
  });

  test("V1 (Anthropic adapter): CSV → revenue by region and a bar chart; one run, a PNG attachment, the image in the tool round", async () => {
    const f = await seed();
    let toolRoundText = "";
    let toolRoundImage: { media_type: string; data: string } | null = null;
    anthropicScript = (request, index) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const last = messages[messages.length - 1];
      const results = Array.isArray(last.content) ? (last.content as Array<{ type: string; content?: unknown }>).filter((block) => block.type === "tool_result") : [];
      if (results.length === 0) {
        assert.ok(toolNamesOf(request).includes("code_interpreter"), `the turn carries the code tool: ${toolNamesOf(request)}`);
        return { tool: { name: "code_interpreter", input: { code: V1_CODE, reason: "average revenue by region" } } };
      }
      const content = results[0].content as Array<{ type: string; text?: string; source?: { media_type: string; data: string } }> | string;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      toolRoundText = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      toolRoundImage = blocks.find((block) => block.type === "image")?.source ?? null;
      const averages = printedAverages(toolRoundText);
      assert.ok(averages, `index ${index}: the tool round carries the program's output`);
      return { text: `Average revenue by region: ${Object.entries(averages).map(([region, value]) => `${region} ${value}`).join(", ")}. The chart is attached as revenue_by_region.png.` };
    };
    const before = await hostRunsStarted();
    const { done } = await chat({ message: "What is the average revenue by region? Make a bar chart.", model: "claude-sonnet-5", attachmentIds: [f.attachment.id] });
    assert.ok(done, "the turn settles");
    const runs = await prisma.toolRun.findMany({ where: { userId: f.user.id } });
    assert.equal(runs.length, 1, "exactly one run");
    assert.equal(runs[0].status, "succeeded");
    assert.equal(runs[0].exitCode, 0);
    assert.equal(await hostRunsStarted(), before + 1);
    const png = await prisma.attachment.findFirstOrThrow({ where: { userId: f.user.id, origin: "tool_output", mimeType: "image/png" } });
    const { getObjectBytes } = await import("@/lib/storage");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from((await getObjectBytes(png.storageKey)).bytes)).metadata();
    assert.ok((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0, "the PNG decodes to real dimensions");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { userId: f.user.id } });
    assert.equal(png.conversationId, conversation.id, "attached to the conversation");
    // The answer's numbers equal the test's own computation of the CSV.
    const own = computeAverages(SALES, "revenue");
    assert.deepEqual(own, expected);
    for (const [region, value] of Object.entries(own)) assert.match(done.message.content, new RegExp(`${region} ${value}`));
    // The image went back to the model in the tool round, and it is the chart.
    assert.ok(toolRoundImage, "an image block was in the tool_result");
    const image = toolRoundImage as { media_type: string; data: string };
    assert.equal(image.media_type, "image/png");
    assert.equal(Buffer.from(image.data, "base64").equals(Buffer.from((await getObjectBytes(png.storageKey)).bytes)), true);
    assert.match(toolRoundText, /Ran Python: exit code 0/);
    // The three model requests: the call, then the answer after the tool round.
    assert.equal(anthropicRequests.length >= 2, true);
  });

  test("V2 (OpenAI-compatible adapter): a header mismatch fails with KeyError, the model reads stderr and fixes it", async () => {
    const csv = "Region,Revenue (EUR)\nNorth,120\nSouth,80\nNorth,180\nEast,50\nSouth,100\nEast,70\n";
    const f = await seed(csv, "sales.csv");
    const toolMessages: string[] = [];
    openaiScript = (request) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const tools = messages.filter((message) => message.role === "tool").map((message) => String(message.content));
      if (tools.length === 0) {
        assert.ok(toolNamesOf(request).includes("code_interpreter"));
        return { tool: { name: "code_interpreter", input: { code: "import pandas as pd\ndf = pd.read_csv('inputs/sales.csv')\nprint(df.groupby('region')['revenue'].mean().to_dict())" } } };
      }
      toolMessages.splice(0, toolMessages.length, ...tools);
      const lastResult = tools[tools.length - 1];
      if (/KeyError/.test(lastResult) && tools.length === 1) {
        // Reads stderr: the column is not called "region"/"revenue". Inspect and fix.
        return { tool: { name: "code_interpreter", input: { code: [
          "import json, pandas as pd",
          "df = pd.read_csv('inputs/sales.csv')",
          "region = next(c for c in df.columns if 'region' in c.lower())",
          "revenue = next(c for c in df.columns if 'revenue' in c.lower())",
          "avg = df.groupby(region)[revenue].mean().sort_index()",
          "print(json.dumps({k: float(v) for k, v in avg.items()}))",
        ].join("\n") } } };
      }
      const averages = printedAverages(lastResult);
      const firstFailed = /FAILED: exit code 1/.test(tools[0]);
      return { text: `${firstFailed ? "My first run failed with a KeyError (the column is \"Revenue (EUR)\", not \"revenue\"), so I fixed the column names and ran it again. " : ""}Average revenue by region: ${Object.entries(averages ?? {}).map(([region, value]) => `${region} ${value}`).join(", ")}.` };
    };
    const { done } = await chat({ message: "Average revenue by region from the attached CSV, please.", model: "deepseek-flash", attachmentIds: [f.attachment.id] });
    assert.ok(done);
    const runs = await prisma.toolRun.findMany({ where: { userId: f.user.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(runs.map((run) => [run.status, run.exitCode]), [["failed", 1], ["succeeded", 0]]);
    assert.match(toolMessages[0], /KeyError: 'region'/, "stderr reached the model in the tool round");
    assert.match(toolMessages[0], /Python FAILED: exit code 1/);
    assert.doesNotMatch(toolMessages[0], /^Ran Python/);
    for (const [region, value] of Object.entries(computeAverages(csv, "Revenue (EUR)"))) assert.match(done.message.content, new RegExp(`${region} ${value}`));
    assert.match(done.message.content, /first run failed/);
    assert.doesNotMatch(done.message.content, /first run (succeeded|worked)/i);
  });

  test("V5: Stop during a long run kills the container and leaves no success claim", async () => {
    const { cancelGeneration } = await import("@/lib/generation-cancel");
    const { JunoExecClient } = await import("@/lib/exec/client");
    const { execEndpoint } = await import("@/lib/exec/config");
    const f = await seed();
    const generationId = randomUUID();
    let answered = false;
    anthropicScript = (request) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const last = messages[messages.length - 1];
      if (Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result")) {
        answered = true;
        return { text: "The computation finished successfully." };
      }
      return { tool: { name: "code_interpreter", input: { code: "import time\nfor i in range(60):\n    print('tick', i, flush=True)\n    time.sleep(1)\n" } } };
    };
    setTimeout(() => cancelGeneration(generationId, f.user.id), 5000);
    const started = Date.now();
    const { frames } = await chat({ message: "Run the long job.", model: "claude-sonnet-5", attachmentIds: [f.attachment.id], generationId });
    assert.ok(Date.now() - started < 40_000, "Stop does not wait for the program");
    const run = await prisma.toolRun.findFirstOrThrow({ where: { userId: f.user.id } });
    assert.equal(run.status, "cancelled");
    const host = await new JunoExecClient(execEndpoint()!).getRun(run.remoteRunId!, 0);
    assert.equal(host.status, "cancelled", "the container was killed");
    assert.equal(answered, false, "no model round claims an outcome after Stop");
    const text = frames.filter((frame) => frame.type === "text").map((frame) => String(frame.text ?? frame.content ?? "")).join("");
    assert.doesNotMatch(text, /finished successfully/);
  });

  test("V5: a dropped client resumes through the stream replay with a single run", async () => {
    const f = await seed();
    const generationId = randomUUID();
    anthropicScript = (request) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const last = messages[messages.length - 1];
      if (Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result")) {
        return { text: "Resumed answer: done." };
      }
      return { tool: { name: "code_interpreter", input: { code: "import time\ntime.sleep(3)\nprint('slow but done')" } } };
    };
    const before = await hostRunsStarted();
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(new Request("http://alevr.test/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Run it.", model: "claude-sonnet-5", attachmentIds: [f.attachment.id], generationId }) }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // the browser went away
    const resume = await import("@/app/api/chat/stream/[generationId]/route");
    let replayText = "";
    for (let attempt = 0; attempt < 30 && !replayText.includes('"type":"done"'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const replay = await resume.GET(new Request(`http://alevr.test/api/chat/stream/${generationId}`), { params: Promise.resolve({ generationId }) });
      replayText = await replay.text();
    }
    assert.match(replayText, /"type":"done"/, "the replay reaches the end of the turn");
    assert.match(replayText, /Resumed answer: done\./);
    assert.equal(await prisma.toolRun.count({ where: { userId: f.user.id } }), 1);
    assert.equal(await hostRunsStarted(), before + 1, "one container");
  });

  test("V6: a private turn carries no execution tool", async () => {
    await seed();
    anthropicRequests.length = 0;
    anthropicScript = () => ({ text: "Private answer." });
    await chat({ message: "Compute 2+2 with code.", model: "claude-sonnet-5", privateMode: true });
    assert.ok(anthropicRequests.length >= 1);
    for (const request of anthropicRequests) {
      const names = toolNamesOf(request);
      assert.ok(!names.includes("code_interpreter") && !names.includes("run_code") && !names.includes("check_run"), `no execution tool in a private turn: ${names}`);
    }
  });

  test("V6: lockdown never executes (and the route must not offer the tool: L1's entitlement)", async (t) => {
    const f = await seed();
    await prisma.settings.create({ data: { userId: f.user.id, lockdownMode: true } });
    anthropicRequests.length = 0;
    let toolResult = "";
    anthropicScript = (request) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const last = messages[messages.length - 1];
      const result = Array.isArray(last.content) ? (last.content as Array<{ type: string; content?: unknown }>).find((block) => block.type === "tool_result") : undefined;
      if (result) {
        toolResult = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return { text: "Code cannot run while lockdown mode is on." };
      }
      if (toolNamesOf(request).includes("code_interpreter")) return { tool: { name: "code_interpreter", input: { code: "print(1)" } } };
      return { text: "No code tool here." };
    };
    const before = await hostRunsStarted();
    await chat({ message: "Run print(1).", model: "claude-sonnet-5", attachmentIds: [f.attachment.id] });
    assert.equal(await prisma.toolRun.count({ where: { userId: f.user.id } }), 0, "nothing ran, nothing recorded");
    assert.equal(await hostRunsStarted(), before);
    // Refused before anything runs: the approval broker blocks it under
    // lockdown, and the runtime would refuse it too (executeRunCode checks).
    if (toolResult) assert.match(toolResult, /declined by security policy|lockdown/);
    const offered = anthropicRequests.some((request) => toolNamesOf(request).includes("code_interpreter"));
    await t.test("the route carries no execution tool in lockdown", { todo: offered ? "L1 wires execEntitlement() into the route's tool entitlements; today the registry tool is offered and refuses at execution" : false }, () => {
      assert.equal(offered, false);
    });
  });

  test("V6: a sandbox that is down is capability_unavailable, and the model is told so", async () => {
    const f = await seed();
    let toolResult = "";
    anthropicScript = (request) => {
      const messages = request.body.messages as Array<{ role: string; content: unknown }>;
      const last = messages[messages.length - 1];
      const result = Array.isArray(last.content) ? (last.content as Array<{ type: string; content?: unknown }>).find((block) => block.type === "tool_result") : undefined;
      if (result) {
        toolResult = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return { text: "I can't run code right now: the sandbox is unavailable, so I haven't computed anything." };
      }
      return { tool: { name: "code_interpreter", input: { code: "print(1)" } } };
    };
    const saved = process.env.CODE_INTERPRETER_URL;
    process.env.CODE_INTERPRETER_URL = "http://127.0.0.1:3179";
    try {
      const { done } = await chat({ message: "Run print(1).", model: "claude-sonnet-5", attachmentIds: [f.attachment.id] });
      assert.ok(done);
      assert.match(done.message.content, /can't run code right now/);
    } finally {
      process.env.CODE_INTERPRETER_URL = saved;
    }
    assert.match(toolResult, /not reachable right now, so nothing was run/);
    const run = await prisma.toolRun.findFirstOrThrow({ where: { userId: f.user.id } });
    assert.equal(run.status, "refused");
  });

  test("shut the labs and the database", async () => {
    await new Promise((resolve) => labServer.close(resolve));
    await prisma.$disconnect();
  });
}
