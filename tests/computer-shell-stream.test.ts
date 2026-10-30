/**
 * The agent's shell output streams to the person's read-only terminal pane
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S5.1): pieces reach the store in
 * order while the command runs, the stored log stops at its cap and says so,
 * the model's result is exactly what it was, and the shell route returns only
 * the owner's rows. Through each provider: the fake, `docker` (a stand-in
 * binary on PATH, the same argv through `spawn`) and the remote host (a fake
 * fetch answering NDJSON).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const stubs = new Map<string, unknown>();
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, parent, isMain);
};

let currentUser = "pro_1";
const runs = new Map<string, { userId: string; agentId: string; status: string }>();
stubs.set("@/lib/code-remote", { requireUser: async () => ({ user: { id: currentUser }, error: null }) });
stubs.set("@/lib/agents/store", {
  findAgent: async (userId: string, agentId: string) => (userId === "intruder" && agentId === "agent_1" ? null : { id: agentId, name: "Mira" }),
  recordAgentEvent: async () => undefined,
});
stubs.set("@/lib/rate-limit", { rateLimit: async () => ({ success: true, remaining: 100, resetAt: new Date() }) });
stubs.set("@/lib/prisma", {
  prisma: {
    workRun: {
      findFirst: async ({ where }: { where: { id: string; userId: string; session: { agentId: string } } }) => {
        const run = runs.get(where.id);
        return run && run.userId === where.userId && run.agentId === where.session.agentId ? { status: run.status } : null;
      },
    },
  },
});

const req = createRequire(import.meta.url);
const shellOutput = req("../src/lib/computer/shell-output") as typeof import("@/lib/computer/shell-output");
const runTools = req("../src/lib/computer/run-tools") as typeof import("@/lib/computer/run-tools");
const { FakeProvider, fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { DockerProvider } = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const { RemoteComputerProvider } = req("../src/lib/computer/remote") as typeof import("@/lib/computer/remote");
const { spawnDockerStreaming } = req("../src/lib/docker-cli") as typeof import("@/lib/docker-cli");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const access = req("../src/lib/computer/access") as typeof import("@/lib/computer/access");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const { decryptSecret } = req("../src/lib/crypto") as typeof import("@/lib/crypto");

type ExecResult = import("@/lib/computer/types").ExecResult;
const handle = { name: "juno-agent-agent_1", volume: "juno-agent-agent_1" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function plain(rows: Array<{ stream: string; text: string; seq: number }>) {
  return rows
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({ stream: row.stream, text: decryptSecret(row.text), seq: row.seq }));
}

describe("shell output streams to the store while the command runs", () => {
  it("chunks reach the store in order while the command runs (a line a second shows within 2 s)", async () => {
    const memory = shellOutput.createInMemoryShellOutputPersistence();
    const log = shellOutput.createShellOutputLog({ userId: "u1", agentId: "agent_1", runId: "run_1", persistence: memory });
    const fake = new FakeProvider();
    const printedAt: number[] = [];
    let release!: () => void;
    const finished = new Promise<void>((resolve) => (release = resolve));
    fake.execHandler = async (_h, _command, opts) => {
      for (let line = 1; line <= 3; line += 1) {
        if (line > 1) await sleep(1000);
        printedAt.push(Date.now());
        opts?.onOutput?.({ stream: "stdout", text: `line ${line}\n` });
      }
      opts?.onOutput?.({ stream: "stderr", text: "warning: done\n" });
      await finished;
      return { stdout: "line 1\nline 2\nline 3\n", stderr: "warning: done\n", exitCode: 0, timedOut: false, durationMs: 2000 };
    };
    const running = runTools.runWatchedComputerShell(fake, handle, "for i in 1 2 3; do echo line $i; sleep 1; done", { timeoutSeconds: 30 }, log, "call_a");

    // Each line is stored, readable, within 2 s of being printed, while the command still runs.
    const seenAt: number[] = [];
    const deadline = Date.now() + 6000;
    while (seenAt.length < 3 && Date.now() < deadline) {
      const stored = plain(memory.rows).filter((row) => row.stream === "stdout").map((row) => row.text).join("");
      for (let line = seenAt.length + 1; line <= 3; line += 1) {
        if (stored.includes(`line ${line}\n`)) seenAt.push(Date.now());
        else break;
      }
      await sleep(50);
    }
    assert.equal(seenAt.length, 3, "all three lines were stored before the command ended");
    for (let i = 0; i < 3; i += 1) assert.ok(seenAt[i] - printedAt[i] < 2000, `line ${i + 1} stored ${seenAt[i] - printedAt[i]} ms after it was printed`);
    assert.equal(memory.rows.some((row) => row.stream === "exit"), false, "no exit row while it runs");

    release();
    const result = await running;
    assert.equal(result.stdout, "line 1\nline 2\nline 3\n");
    const rows = plain(memory.rows);
    assert.deepEqual(rows.map((row) => row.seq), rows.map((_, index) => index + 1), "seq numbered 1, 2, 3… in write order");
    assert.equal(rows[0].stream, "command");
    assert.equal(rows[0].text, "for i in 1 2 3; do echo line $i; sleep 1; done");
    assert.equal(rows[rows.length - 1].stream, "exit");
    assert.deepEqual(JSON.parse(rows[rows.length - 1].text), { exitCode: 0, timedOut: false, capped: false });
    assert.equal(rows.filter((row) => row.stream === "stdout").map((row) => row.text).join(""), "line 1\nline 2\nline 3\n");
    assert.equal(rows.filter((row) => row.stream === "stderr").map((row) => row.text).join(""), "warning: done\n");
    for (const row of memory.rows) assert.ok(row.text.startsWith("v") || row.text.split(".").length >= 3, "every row is encrypted");
    assert.equal(memory.rows.some((row) => row.text.includes("line 1")), false, "no plaintext at rest");
  });

  it("the stored log stops at the cap and says so", async () => {
    const memory = shellOutput.createInMemoryShellOutputPersistence();
    const log = shellOutput.createShellOutputLog({ userId: "u1", agentId: "agent_1", runId: "run_cap", persistence: memory, maxBytesPerCall: 1024, flushMs: 10 });
    const call = log.call("call_cap", "yes | head -c 5000");
    for (let i = 0; i < 50; i += 1) call.append({ stream: "stdout", text: "y\n".repeat(50) });
    await call.end({ exitCode: 0, timedOut: false });
    const rows = plain(memory.rows);
    const output = rows.filter((row) => row.stream === "stdout" && !row.text.includes(shellOutput.SHELL_OUTPUT_CAPPED_TEXT));
    assert.equal(output.map((row) => row.text).join("").length, 1024, "exactly the cap, no more");
    const notices = rows.filter((row) => row.text.includes(shellOutput.SHELL_OUTPUT_CAPPED_TEXT));
    assert.equal(notices.length, 1, "said once");
    assert.equal(rows.indexOf(notices[0]), rows.length - 2, "the notice is the last output row, before the exit row");
    assert.deepEqual(JSON.parse(rows[rows.length - 1].text), { exitCode: 0, timedOut: false, capped: true });
    for (const row of rows) assert.ok(Buffer.byteLength(row.text) <= shellOutput.SHELL_OUTPUT_ROW_BYTES);
  });

  it("a row never holds more than 16 KB and a character is never split", async () => {
    const memory = shellOutput.createInMemoryShellOutputPersistence();
    const log = shellOutput.createShellOutputLog({ userId: "u1", agentId: "agent_1", runId: "run_big", persistence: memory, maxBytesPerCall: 512 * 1024, flushMs: 10 });
    const call = log.call("call_big", "cat big");
    call.append({ stream: "stdout", text: "€".repeat(20_000) });
    await call.end({ exitCode: 0, timedOut: false });
    const rows = plain(memory.rows).filter((row) => row.stream === "stdout");
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.ok(Buffer.byteLength(row.text) <= 16 * 1024);
      assert.equal(row.text.includes("�"), false);
    }
    assert.equal(rows.map((row) => row.text).join(""), "€".repeat(20_000));
  });

  it("a failed write never fails the command", async () => {
    const broken: import("@/lib/computer/shell-output").ShellOutputPersistence = {
      maxSeq: async () => 0,
      insert: async () => {
        throw new Error("database down");
      },
      list: async () => [],
    };
    const log = shellOutput.createShellOutputLog({ userId: "u1", agentId: "agent_1", runId: "run_x", persistence: broken, flushMs: 5 });
    const fake = new FakeProvider();
    const result = await runTools.runWatchedComputerShell(fake, handle, "echo hi", { timeoutSeconds: 5 }, log, "call_x");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "echo hi\n");
  });
});

describe("the model's result is unchanged", () => {
  it("watched or not, the provider's result and the tool's output are the same", async () => {
    const answer: ExecResult = { stdout: "a\nb\n", stderr: "careful\n", exitCode: 2, timedOut: false, durationMs: 7 };
    const fake = new FakeProvider();
    fake.execHandler = () => ({ ...answer });
    const memory = shellOutput.createInMemoryShellOutputPersistence();
    const log = shellOutput.createShellOutputLog({ userId: "u1", agentId: "agent_1", runId: "run_same", persistence: memory, flushMs: 5 });
    const watched = await runTools.runWatchedComputerShell(fake, handle, "make", { timeoutSeconds: 30 }, log, "call_1");
    const unwatched = await runTools.runComputerShell(fake, handle, "make", { timeoutSeconds: 30 });
    assert.deepEqual(watched, unwatched);
    assert.deepEqual(watched, answer);
    const recorded = fake.calls.filter((c) => c.method === "exec").map((c) => c.args[2]);
    assert.deepEqual(recorded, [{ timeoutSeconds: 30 }, { timeoutSeconds: 30 }], "the exec options the fake records are the same either way");

    // Through agent-core's computer_shell: the same output whether the call had an id (watched) or not.
    const runtime = await import("../runner/agent-core/dist/work/index.js");
    const toolsFor = (watch: boolean) =>
      runtime.computerTools({
        isHealthy: () => true,
        pageTakesPayment: () => false,
        currentUrl: () => "",
        screenEpoch: () => 0,
        screenshot: async () => ({ mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 }),
        click: async () => ({ mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 }),
        type: async () => ({ mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 }),
        key: async () => ({ mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 }),
        scroll: async () => ({ mediaType: "image/jpeg" as const, data: "", width: 1, height: 1 }),
        exec: (command, opts) =>
          runTools.runWatchedComputerShell(fake, handle, command, { timeoutSeconds: opts.timeoutSeconds }, watch ? log : null, opts.callId),
        listFiles: async () => [],
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
      });
    const shellOf = (watch: boolean) => toolsFor(watch).find((tool) => tool.spec.name === "computer_shell")!;
    const ctx = { cwd: "/", callId: "call_2" };
    const a = await shellOf(true).execute({ command: "make" }, ctx);
    const b = await shellOf(false).execute({ command: "make" }, { cwd: "/" });
    assert.deepEqual(a, b);
    assert.equal(a.output, "a\nb\n\nstderr:\ncareful\n");
    await log.drain();
    assert.ok(memory.rows.some((row) => row.callId === "call_2"), "the call with an id was streamed under it");
  });
});

describe("Docker: the same exec argv through spawn, output as it arrives", () => {
  let dir: string;
  const savedPath = process.env.PATH;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "juno-s5-docker-"));
    // A stand-in `docker`: records its argv, then prints a line, waits, prints another (split UTF-8 across writes).
    writeFileSync(
      path.join(dir, "docker"),
      [
        "#!/usr/bin/env python3",
        "import json, sys, time, os",
        "open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'argv.json'), 'w').write(json.dumps(sys.argv[1:]))",
        "if sys.argv[1:3] == ['exec', '--user'] and 'realpath' in sys.argv:",
        "    print(sys.argv[-1]); sys.exit(0)",
        "sys.stdout.buffer.write(b'first \\xe2\\x82'); sys.stdout.flush(); time.sleep(0.05)",
        "sys.stdout.buffer.write(b'\\xac\\n'); sys.stdout.flush(); time.sleep(0.6)",
        "sys.stderr.write('oops\\n'); sys.stderr.flush()",
        "sys.stdout.write('second\\n'); sys.stdout.flush()",
        "sys.exit(4)",
      ].join("\n")
    );
    chmodSync(path.join(dir, "docker"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
  });
  after(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("chunks arrive before the command ends, decoded across a split character, and the result is the buffered one", async () => {
    const chunks: Array<{ stream: string; text: string; at: number }> = [];
    const started = Date.now();
    const result = await spawnDockerStreaming(["exec", "x"], (chunk) => chunks.push({ ...chunk, at: Date.now() - started }), { timeoutMs: 10_000 });
    assert.equal(result.exitCode, 4);
    assert.equal(result.stdout.toString("utf8"), "first €\nsecond\n");
    assert.equal(result.stderr.toString("utf8"), "oops\n");
    assert.equal(chunks.map((c) => (c.stream === "stdout" ? c.text : "")).join(""), "first €\nsecond\n");
    assert.equal(chunks.some((c) => c.text.includes("�")), false, "the euro sign split across two writes arrives whole");
    const first = chunks.find((c) => c.text.includes("first"))!;
    const second = chunks.find((c) => c.text.includes("second"))!;
    assert.ok(second.at - first.at >= 400, `the second line came later (${second.at - first.at} ms), not all at the end`);
  });

  it("DockerProvider.exec with onOutput sends exactly the argv it sends without", async () => {
    const provider = new DockerProvider();
    const seen: string[] = [];
    const { readFileSync } = await import("node:fs");
    const watched = await provider.exec(handle, "make all", { timeoutSeconds: 20, onOutput: (c) => seen.push(c.text) });
    const watchedArgv = JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8"));
    assert.equal(watched.exitCode, 4);
    assert.equal(watched.stdout, "first €\nsecond\n");
    assert.ok(seen.join("").includes("second"));
    assert.deepEqual(watchedArgv, [
      "exec", "--user", "1000", "--workdir", "/home/agent/work", handle.name, "/opt/juno/agent-exec", "run", "--",
      "timeout", "--signal=TERM", "--kill-after=5", "20", "bash", "--noprofile", "--norc", "-c", "make all",
    ]);
    await provider.exec(handle, "make all", { timeoutSeconds: 20 });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8")), watchedArgv, "the buffered call's argv is identical");
  });
});

describe("remote host: NDJSON as the command writes it", () => {
  const ORIGIN = "http://127.0.0.1:8750";
  const TOKEN = "a".repeat(64);
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

  it("each piece reaches onOutput before the answer ends; the result keeps the bytes as a buffered answer does", async () => {
    const sent: Array<{ accept: string | null; body: unknown }> = [];
    let pushLast!: () => void;
    const lastGate = new Promise<void>((resolve) => (pushLast = resolve));
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      sent.push({ accept: new Headers(init.headers).get("accept"), body: JSON.parse(String(init.body)) });
      const euro = Buffer.from("€");
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(line({ stream: "stdout", data_b64: b64(Buffer.concat([Buffer.from("one "), euro.subarray(0, 2)])) }));
          controller.enqueue(line({ stream: "stdout", data_b64: b64(Buffer.concat([euro.subarray(2), Buffer.from("\n")])) }));
          await lastGate;
          // A line split across two network reads.
          const tail = line({ stream: "stderr", data_b64: b64("two\n") });
          controller.enqueue(tail.subarray(0, 10));
          controller.enqueue(tail.subarray(10));
          controller.enqueue(line({ exit: 1, timedOut: false, durationMs: 1234, stdoutTruncated: false, stderrTruncated: false }));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }) as unknown as typeof fetch;
    const provider = new RemoteComputerProvider({ origin: ORIGIN, token: TOKEN, fetchImpl });
    const chunks: string[] = [];
    let sawFirstBeforeEnd = false;
    let text = "";
    const pending = provider.exec(handle, "ls", {
      timeoutSeconds: 10,
      cwd: "/home/agent/work",
      onOutput: (chunk) => {
        chunks.push(`${chunk.stream}:${chunk.text}`);
        text += chunk.text;
        if (!sawFirstBeforeEnd && text.includes("one €")) {
          sawFirstBeforeEnd = true;
          pushLast();
        }
      },
    });
    const result = await pending;
    assert.equal(sawFirstBeforeEnd, true, "the first piece arrived while the answer was still open");
    assert.deepEqual(chunks, ["stdout:one ", "stdout:€\n", "stderr:two\n"]);
    assert.deepEqual(result, { stdout: "one €\n", stderr: "two\n", exitCode: 1, timedOut: false, durationMs: 1234 });
    assert.deepEqual(sent, [{ accept: "application/x-ndjson", body: { command: "ls", timeoutSeconds: 10, cwd: "/home/agent/work" } }]);
  });

  it("a refusal before the command ran maps as a buffered one would; a host that answers whole still feeds the pane", async () => {
    const refusing = new RemoteComputerProvider({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: (async () => new Response(JSON.stringify({ error: "path_refused" }), { status: 422, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    await assert.rejects(refusing.exec(handle, "ls", { cwd: "/etc", onOutput: () => undefined }), /Paths must stay inside/);

    const whole = new RemoteComputerProvider({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ stdoutBase64: b64("whole\n"), stderrBase64: "", exitCode: 0, timedOut: false, durationMs: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    const result = await whole.exec(handle, "ls", { onOutput: (c) => chunks.push(c.text) });
    assert.deepEqual(chunks, ["whole\n"]);
    assert.equal(result.stdout, "whole\n");
  });

  it("an answer that ends before the exit line, or fails mid-answer, is the unreachable sentence", async () => {
    for (const lines of [[line({ stream: "stdout", data_b64: b64("x") })], [line({ stream: "stdout", data_b64: b64("x") }), line({ error: "host_error" })]]) {
      const provider = new RemoteComputerProvider({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const piece of lines) controller.enqueue(piece);
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )) as unknown as typeof fetch,
      });
      await assert.rejects(provider.exec(handle, "ls", { onOutput: () => undefined }), /could not reach the agent's computer|can't be reached|reach/i);
    }
  });
});

describe("the shell route returns only the owner's rows", () => {
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AGENT_COMPUTER_ALLOWLIST"];
  const saved: Record<string, string | undefined> = {};
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  let memory: ReturnType<typeof shellOutput.createInMemoryShellOutputPersistence>;
  const route = () => req("../src/app/api/agents/[id]/computer/shell/route") as { GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };
  const get = async (agentId: string, query: string) => {
    const res = await route().GET(new Request(`https://alevr.test/api/agents/${agentId}/computer/shell${query}`), { params: Promise.resolve({ id: agentId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    resetComputerProviderCache();
    access.resetComputerAvailabilityCacheForTest();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.accessUsers.set("pro_1", { id: "pro_1", email: null, emailVerified: null, plan: "PRO" });
    memDb.accessUsers.set("pro_2", { id: "pro_2", email: null, emailVerified: null, plan: "PRO" });
    memDb.accessUsers.set("free_1", { id: "free_1", email: null, emailVerified: null, plan: "FREE" });
    memory = shellOutput.createInMemoryShellOutputPersistence();
    shellOutput.setShellOutputPersistenceForTest(memory);
    runs.clear();
    runs.set("run_mine", { userId: "pro_1", agentId: "agent_1", status: "running" });
    runs.set("run_theirs", { userId: "pro_2", agentId: "agent_9", status: "completed" });
    const mine = shellOutput.createShellOutputLog({ userId: "pro_1", agentId: "agent_1", runId: "run_mine", persistence: memory, flushMs: 1 });
    const call = mine.call("call_1", "echo mine");
    call.append({ stream: "stdout", text: "\u001b[32mmine\u001b[0m\n" });
    await call.end({ exitCode: 0, timedOut: false });
    const theirs = shellOutput.createShellOutputLog({ userId: "pro_2", agentId: "agent_9", runId: "run_theirs", persistence: memory, flushMs: 1 });
    const other = theirs.call("call_9", "cat secrets.txt");
    other.append({ stream: "stdout", text: "theirs\n" });
    await other.end({ exitCode: 0, timedOut: false });
    currentUser = "pro_1";
  });
  afterEach(() => {
    shellOutput.setShellOutputPersistenceForTest(null);
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  it("the owner reads their run's rows after the cursor, decrypted, and nobody else's", async () => {
    const all = await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(all.status, 200);
    const rows = all.body.rows as Array<{ seq: number; stream: string; text: string; callId: string }>;
    assert.deepEqual(rows.map((r) => [r.stream, r.text]), [["command", "echo mine"], ["stdout", "\u001b[32mmine\u001b[0m\n"], ["exit", JSON.stringify({ exitCode: 0, timedOut: false, capped: false })]]);
    assert.equal(all.body.runLive, true);
    assert.equal(all.body.running, false);
    const afterFirst = await get("agent_1", `?runId=run_mine&after=${rows[0].seq}`);
    assert.deepEqual((afterFirst.body.rows as Array<{ seq: number }>).map((r) => r.seq), rows.slice(1).map((r) => r.seq));
    assert.equal(JSON.stringify(all.body).includes("theirs"), false);

    // Another account's run through this account's agent, or through theirs: not found, nothing read.
    const crossRun = await get("agent_1", "?runId=run_theirs&after=0");
    assert.equal(crossRun.status, 404);
    assert.equal(JSON.stringify(crossRun.body).includes("secrets"), false);
    currentUser = "pro_2";
    const otherAgent = await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(otherAgent.status, 404, "the run is not theirs");
  });

  it("gated like the view: plan, server off, bad input; never a raw error", async () => {
    currentUser = "free_1";
    const free = await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(free.status, 403);
    assert.equal(free.body.error, "plan");
    assert.equal("rows" in free.body, false);
    currentUser = "pro_1";
    for (const query of ["?runId=run_mine&after=-1", "?runId=../../x&after=0", "?after=0", "?runId=run_mine&after=1e9"]) {
      assert.equal((await get("agent_1", query)).status, 400, query);
    }
    delete process.env.AGENT_COMPUTER_PROVIDER;
    resetComputerProviderCache();
    const off = await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(off.body.error, "server_off");
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    resetComputerProviderCache();
    shellOutput.setShellOutputPersistenceForTest({
      maxSeq: async () => 0,
      insert: async () => undefined,
      list: async () => {
        throw new Error("relation \"ComputerShellOutput\" does not exist at 10.0.0.4:5432");
      },
    });
    const broken = await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(broken.status, 502);
    assert.equal(JSON.stringify(broken.body).includes("10.0.0.4"), false, "never the raw message");
  });

  it("the route only reads: it has no handler that writes and never touches the provider", async () => {
    const handlers = route() as Record<string, unknown>;
    assert.deepEqual(Object.keys(handlers).filter((key) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(key)), ["GET"]);
    fakeComputerProvider.calls = [];
    await get("agent_1", "?runId=run_mine&after=0");
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "exec" || c.method === "writeFile"), false);
  });
});

it("sha256 helper sanity (used by the evidence script)", () => {
  assert.equal(createHash("sha256").update("").digest("hex").slice(0, 12), "e3b0c44298fc");
});
