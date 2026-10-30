import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import sharp from "sharp";

/*
 * RemoteComputerProvider (src/lib/computer/remote.ts) against a stub computer
 * host: every provider method maps to its one host call; the host URL and token
 * are checked before anything is sent; a host's words never reach a message;
 * and `state()` says `missing` only when the host says the container does not
 * exist, so an outage can never send the store into a recreate.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const remote = req("../src/lib/computer/remote") as typeof import("@/lib/computer/remote");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");
const providerModule = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");

const TOKEN = "0123456789abcdef".repeat(4);
const NAME = "juno-agent-cmagent1";
const HANDLE = { name: NAME, volume: NAME };

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}
type Answer = { status: number; json?: unknown; bytes?: Buffer; type?: string; hang?: boolean };

let server: Server;
let origin = "";
let seen: Seen[] = [];
let answers: Array<(s: Seen) => Answer | null> = [];
let png: Buffer;

function answer(s: Seen): Answer {
  for (const rule of answers) {
    const a = rule(s);
    if (a) return a;
  }
  return { status: 200, json: { ok: true } };
}

before(async () => {
  png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://stub");
      const s: Seen = {
        method: request.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks),
      };
      seen.push(s);
      const a = answer(s);
      if (a.hang) return; // never answers: the provider's timeout must fire
      const body = a.bytes ?? Buffer.from(JSON.stringify(a.json ?? null));
      response.writeHead(a.status, { "Content-Type": a.type ?? "application/json", "Content-Length": body.length });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  answers = [];
});

function provider(timeoutMs = 5_000) {
  return new remote.RemoteComputerProvider({ origin, token: TOKEN, timeoutMs });
}

function only(): Seen {
  assert.equal(seen.length, 1, JSON.stringify(seen.map((s) => `${s.method} ${s.path}`)));
  return seen[0];
}

test("every provider method maps to its one host call", async () => {
  const p = provider();
  const cases: Array<{
    call: () => Promise<unknown>;
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    reply?: Answer;
    expect?: unknown;
  }> = [
    { call: () => p.available(), method: "GET", path: "/v1/available", expect: { ok: true } },
    { call: () => p.preflight(), method: "GET", path: "/v1/preflight", expect: { ok: true } },
    {
      call: () => p.create({ agentId: "cmagent1", userId: "cmuser456", cdpToken: "t" }),
      method: "POST",
      path: "/v1/computers",
      body: { agentId: "cmagent1", userRef: remote.hostUserRef("cmuser456") },
      reply: { status: 200, json: { name: NAME, volume: NAME } },
      expect: HANDLE,
    },
    { call: () => p.start(HANDLE), method: "POST", path: `/v1/computers/${NAME}/start` },
    { call: () => p.stop(HANDLE), method: "POST", path: `/v1/computers/${NAME}/stop` },
    { call: () => p.pause(HANDLE), method: "POST", path: `/v1/computers/${NAME}/pause` },
    { call: () => p.unpause(HANDLE), method: "POST", path: `/v1/computers/${NAME}/unpause` },
    { call: () => p.destroy(HANDLE, { removeVolume: true }), method: "DELETE", path: `/v1/computers/${NAME}`, query: { volumes: "1" } },
    { call: () => p.destroy(HANDLE), method: "DELETE", path: `/v1/computers/${NAME}`, query: {} },
    { call: () => p.state(HANDLE), method: "GET", path: `/v1/computers/${NAME}/state`, reply: { status: 200, json: { state: "paused" } }, expect: "paused" },
    { call: () => p.provisionCdpToken(HANDLE, "the-cdp-token"), method: "PUT", path: `/v1/computers/${NAME}/cdp-token`, body: Buffer.from("the-cdp-token") },
    { call: () => p.click(HANDLE, { x: 1, y: 2, button: "right" }), method: "POST", path: `/v1/computers/${NAME}/input`, body: { kind: "click", x: 1, y: 2, button: "right" } },
    { call: () => p.type(HANDLE, "hi"), method: "POST", path: `/v1/computers/${NAME}/input`, body: { kind: "type", text: "hi" } },
    { call: () => p.key(HANDLE, "ctrl+l"), method: "POST", path: `/v1/computers/${NAME}/input`, body: { kind: "key", keys: "ctrl+l" } },
    { call: () => p.scroll(HANDLE, { x: 1, y: 2, dy: -3 }), method: "POST", path: `/v1/computers/${NAME}/input`, body: { kind: "scroll", x: 1, y: 2, dx: null, dy: -3 } },
    { call: () => p.drag(HANDLE, { x1: 1, y1: 2, x2: 3, y2: 4 }), method: "POST", path: `/v1/computers/${NAME}/input`, body: { kind: "drag", x1: 1, y1: 2, x2: 3, y2: 4 } },
    {
      call: () => p.exec(HANDLE, "ls", { timeoutSeconds: 999, cwd: "project" }),
      method: "POST",
      path: `/v1/computers/${NAME}/exec`,
      body: { command: "ls", timeoutSeconds: 300, cwd: "project" },
      reply: { status: 200, json: { stdout: "a\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 12 } },
      expect: { stdout: "a\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 12 },
    },
    {
      call: () => p.listFiles(HANDLE, "/home/agent/work"),
      method: "GET",
      path: `/v1/computers/${NAME}/files`,
      query: { path: "/home/agent/work" },
      reply: { status: 200, json: [{ name: "a.txt", path: "/home/agent/work/a.txt", type: "file", size: 3, modifiedAt: "2026-10-01T00:00:00.000Z" }, { bogus: 1 }] },
      expect: [{ name: "a.txt", path: "/home/agent/work/a.txt", type: "file", size: 3, modifiedAt: "2026-10-01T00:00:00.000Z" }],
    },
    {
      call: () => p.readFile(HANDLE, "/home/agent/work/a.bin", { maxBytes: 4 }),
      method: "GET",
      path: `/v1/computers/${NAME}/files/content`,
      query: { path: "/home/agent/work/a.bin", maxBytes: "4" },
      reply: { status: 200, bytes: Buffer.from([0, 255, 1, 254]), type: "application/octet-stream" },
      expect: Buffer.from([0, 255, 1, 254]),
    },
    {
      call: () => p.writeFile(HANDLE, "/home/agent/work/inbox/b.bin", Buffer.from([1, 2, 0]), { by: "person" }),
      method: "PUT",
      path: `/v1/computers/${NAME}/files/content`,
      query: { path: "/home/agent/work/inbox/b.bin", by: "person" },
      body: Buffer.from([1, 2, 0]),
    },
    {
      call: () => p.writeFile(HANDLE, "/home/agent/work/c.txt", "text"),
      method: "PUT",
      path: `/v1/computers/${NAME}/files/content`,
      query: { path: "/home/agent/work/c.txt", by: "agent" },
      body: Buffer.from("text"),
    },
    { call: () => p.diskUsageMb(HANDLE), method: "GET", path: `/v1/computers/${NAME}/disk`, reply: { status: 200, json: { mb: 42 } }, expect: 42 },
    {
      call: () => p.fileInfo(HANDLE, "a.txt"),
      method: "GET",
      path: `/v1/computers/${NAME}/files/info`,
      query: { path: "a.txt" },
      reply: { status: 200, json: { path: "/home/agent/work/a.txt", size: 3, type: "file" } },
      expect: { path: "/home/agent/work/a.txt", size: 3, type: "file" },
    },
    { call: () => p.fileInfo(HANDLE, "none"), method: "GET", path: `/v1/computers/${NAME}/files/info`, query: { path: "none" }, reply: { status: 200, json: null }, expect: null },
    { call: () => p.isVncRunning(HANDLE), method: "GET", path: `/v1/computers/${NAME}/vnc`, reply: { status: 200, json: { running: true } }, expect: true },
    {
      call: () => p.startVnc(HANDLE, { controlPassword: "Ctl12345", viewPassword: "Vw123456" }),
      method: "PUT",
      path: `/v1/computers/${NAME}/vnc`,
      body: { controlPassword: "Ctl12345", viewPassword: "Vw123456" },
    },
    { call: () => p.stopVnc(HANDLE), method: "DELETE", path: `/v1/computers/${NAME}/vnc` },
    { call: () => p.freezeAgent(HANDLE), method: "POST", path: `/v1/computers/${NAME}/freeze` },
    { call: () => p.thawAgent(HANDLE), method: "POST", path: `/v1/computers/${NAME}/thaw` },
    { call: () => p.browserSandbox(HANDLE), method: "GET", path: `/v1/computers/${NAME}/browser-sandbox`, reply: { status: 200, json: { state: "on" } }, expect: "on" },
    { call: () => p.isOutdated(HANDLE), method: "GET", path: `/v1/computers/${NAME}/outdated`, reply: { status: 200, json: { outdated: true } }, expect: true },
    {
      call: () => p.imageInfo(),
      method: "GET",
      path: "/v1/image",
      reply: { status: 200, json: { id: "sha256:x", label: "pipe-v4", createdAt: "2026-10-28T00:00:00Z" } },
      expect: { id: "sha256:x", label: "pipe-v4", createdAt: "2026-10-28T00:00:00Z" },
    },
    {
      call: () => p.listOwned(),
      method: "GET",
      path: "/v1/owned",
      reply: { status: 200, json: { containers: [{ name: NAME, agentId: "cmagent1", userId: "u_x", state: "dead" }, { name: "other" }], volumes: [NAME, "evil"] } },
      expect: { containers: [{ name: NAME, agentId: "cmagent1", userId: "u_x", state: "exited" }], volumes: [NAME] },
    },
  ];
  for (const c of cases) {
    seen = [];
    answers = c.reply ? [() => c.reply!] : [];
    const result = await c.call();
    const s = only();
    assert.equal(`${s.method} ${s.path}`, `${c.method} ${c.path}`);
    assert.equal(s.auth, `Bearer ${TOKEN}`);
    if (c.query) assert.deepEqual(s.query, c.query, c.path);
    if (Buffer.isBuffer(c.body)) {
      assert.equal(s.contentType, "application/octet-stream");
      assert.deepEqual(s.body, c.body);
    } else if (c.body !== undefined) {
      assert.equal(s.contentType, "application/json");
      assert.deepEqual(JSON.parse(s.body.toString()), c.body);
    }
    if ("expect" in c) assert.deepEqual(result, c.expect, `${c.method} ${c.path}`);
  }
});

test("endpoints mint one ticket per purpose and describe the tunnels", async () => {
  const p = provider();
  let n = 0;
  answers = [(s) => (s.path.endsWith("/tickets") ? { status: 200, json: { ticket: `${"t".repeat(42)}${n++}`, expiresAt: 1 } } : null)];
  const cdp = await p.endpoints(HANDLE, { purpose: "cdp" });
  assert.deepEqual(JSON.parse(only().body.toString()), { port: 9222 });
  assert.equal(cdp.cdpUrl, `${origin.replace("http:", "ws:")}/v1/tunnel`);
  assert.deepEqual(cdp.cdpHeaders, { "X-Juno-Tunnel-Ticket": `${"t".repeat(42)}0` });
  assert.equal(cdp.vncTunnel, undefined);
  seen = [];
  const vnc = await p.endpoints(HANDLE, { purpose: "vnc" });
  assert.deepEqual(JSON.parse(only().body.toString()), { port: 5900 });
  assert.deepEqual(vnc.vncTunnel, { origin, ticket: `${"t".repeat(42)}1` });
  assert.equal(vnc.cdpHeaders, undefined);
  seen = [];
  const both = await p.endpoints(HANDLE);
  assert.equal(seen.length, 2);
  assert.ok(both.cdpHeaders && both.vncTunnel);
  answers = [() => ({ status: 200, json: { ticket: "short" } })];
  await assert.rejects(() => p.endpoints(HANDLE, { purpose: "cdp" }), { message: errors.COMPUTER_UNREACHABLE });
  assert.equal(remote.tunnelUrl("https://computers.example.test"), "wss://computers.example.test/v1/tunnel");
});

test("the screenshot comes back as a JPEG", async () => {
  answers = [() => ({ status: 200, bytes: png, type: "image/png" })];
  const shot = await provider().screenshot(HANDLE);
  assert.equal(shot.jpeg.subarray(0, 2).toString("hex"), "ffd8");
  assert.equal(shot.sha256.length, 64);
});

test("http to a non-loopback host is refused, and production refuses http", () => {
  const ok = (url: string, nodeEnv = "development") => remote.remoteHostConfig({ url, token: TOKEN, nodeEnv }).ok;
  assert.equal(ok("https://computers.example.test"), true);
  assert.equal(ok("https://computers.example.test", "production"), true);
  assert.equal(ok("http://127.0.0.1:8750"), true);
  assert.equal(ok("http://localhost:8750"), true);
  assert.equal(ok("http://[::1]:8750"), true);
  assert.equal(ok("http://127.0.0.1:8750", "production"), false);
  assert.equal(ok("http://computers.example.test"), false);
  assert.equal(ok("http://10.0.0.4:8750"), false);
  assert.equal(ok("ftp://computers.example.test"), false);
  assert.equal(ok("https://computers.example.test/api"), false, "an origin only");
  assert.equal(ok("https://user:pass@computers.example.test"), false);
  assert.equal(ok("not a url"), false);
});

test("a malformed token keeps the provider off, and the reason never holds it", () => {
  for (const token of ["", "short", "0123456789ABCDEF".repeat(4) + "!", "a b c", "x".repeat(42)]) {
    const res = remote.remoteHostConfig({ url: "https://computers.example.test", token, nodeEnv: "production" });
    assert.equal(res.ok, false, token);
    if (!res.ok && token) assert.ok(!res.reason.includes(token));
  }
  assert.equal(remote.remoteHostConfig({ url: "https://h.test", token: "A".repeat(43), nodeEnv: "production" }).ok, true);
  const env = process.env as Record<string, string | undefined>;
  const saved = { p: env.COMPUTER_PROVIDER, u: env.COMPUTER_HOST_URL, t: env.COMPUTER_HOST_TOKEN };
  const errorsLogged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errorsLogged.push(args);
  try {
    env.COMPUTER_PROVIDER = "remote";
    env.COMPUTER_HOST_URL = "https://computers.example.test";
    env.COMPUTER_HOST_TOKEN = "not-a-generated-token";
    remote.resetRemoteComputerProviderForTest();
    assert.equal(providerModule.computerProvider(), null);
    assert.equal(providerModule.computerProvider(), null);
    assert.equal(errorsLogged.length, 1, "said once");
    assert.ok(!JSON.stringify(errorsLogged).includes("not-a-generated-token"));
    env.COMPUTER_HOST_TOKEN = TOKEN;
    assert.equal(providerModule.computerProvider()?.name, "remote");
  } finally {
    console.error = originalError;
    for (const [key, value] of [["COMPUTER_PROVIDER", saved.p], ["COMPUTER_HOST_URL", saved.u], ["COMPUTER_HOST_TOKEN", saved.t]] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    remote.resetRemoteComputerProviderForTest();
  }
});

test("host errors never reach the message", async () => {
  const p = provider();
  const leak = "secret-container-detail juno-agent-zzz 172.30.0.9 /home/agent/work/private.txt";
  const warned: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    for (const status of [400, 401, 409, 422, 500, 502, 503]) {
      answers = [() => ({ status, bytes: Buffer.from(JSON.stringify({ error: leak, message: leak })) })];
      for (const call of [() => p.start(HANDLE), () => p.exec(HANDLE, "ls"), () => p.readFile(HANDLE, "a"), () => p.listOwned()]) {
        const error = await call().then(() => null, (e: unknown) => e);
        assert.ok(error instanceof errors.ComputerError, `${status}`);
        assert.ok(!error.message.includes("secret") && !error.detail.includes("secret"), error.message + error.detail);
      }
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(!JSON.stringify(warned).includes("secret"), "nothing of the host's body is logged either");
  // A refused write says the provider's own sentence; an unreadable file its own.
  answers = [() => ({ status: 422, json: { error: "write_refused" } })];
  await assert.rejects(() => p.writeFile(HANDLE, "/home/agent/.bashrc", "x"), /never into a dotfile/);
  answers = [() => ({ status: 422, json: { error: "path_refused" } })];
  await assert.rejects(() => p.exec(HANDLE, "ls", { cwd: "/etc" }), { message: errors.COMPUTER_PATH_REFUSED });
  answers = [() => ({ status: 422, json: { error: "unreadable" } })];
  await assert.rejects(() => p.readFile(HANDLE, "a"), { message: "That file could not be read." });
  answers = [() => ({ status: 409, json: { error: "preflight", reason: "capacity" } })];
  await assert.rejects(() => p.start(HANDLE), { message: remote.HOST_PREFLIGHT_SENTENCES.capacity });
  answers = [() => ({ status: 409, json: { error: "sandbox_check_failed" } })];
  await assert.rejects(() => p.browserSandbox(HANDLE), /failed a safety check/);
});

test("state() is missing only on 404 and throws COMPUTER_UNREACHABLE on a transport error, a timeout or a 5xx", async () => {
  const p = provider(800);
  answers = [() => ({ status: 404, json: { error: "no_such_container" } })];
  assert.equal(await p.state(HANDLE), "missing");
  for (const reply of [
    { status: 500, json: { error: "host_error" } },
    { status: 502, json: { error: "host_error" } },
    { status: 503 },
    { status: 409, json: { error: "name_conflict" } },
    { status: 404, json: { error: "not_found" } },
    { status: 401, json: { error: "unauthorized" } },
  ]) {
    answers = [() => reply];
    await assert.rejects(() => p.state(HANDLE), { message: errors.COMPUTER_UNREACHABLE }, JSON.stringify(reply));
  }
  answers = [() => ({ status: 200, hang: true })];
  const started = Date.now();
  await assert.rejects(() => p.state(HANDLE), { message: errors.COMPUTER_UNREACHABLE });
  assert.ok(Date.now() - started < 5_000, "the timeout fired");
  const closed = new remote.RemoteComputerProvider({ origin: "http://127.0.0.1:9", token: TOKEN, timeoutMs: 2_000 });
  await assert.rejects(() => closed.state(HANDLE), { message: errors.COMPUTER_UNREACHABLE });
  // available() answers false (never throws) when the host does not answer.
  assert.deepEqual((await closed.available()).ok, false);
});

test("an idempotent GET is retried once on a transport error, a POST is not", async () => {
  let drops = 1;
  answers = [];
  const flaky = createServer((request, response) => {
    if (drops > 0) {
      drops -= 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ state: "running" }));
  });
  await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", () => resolve()));
  const p = new remote.RemoteComputerProvider({ origin: `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`, token: TOKEN, timeoutMs: 3_000 });
  try {
    assert.equal(await p.state(HANDLE), "running");
    drops = 1;
    await assert.rejects(() => p.start(HANDLE), { message: errors.COMPUTER_UNREACHABLE });
  } finally {
    flaky.closeAllConnections();
    await new Promise<void>((resolve) => flaky.close(() => resolve()));
  }
});

test("stop and stopVnc ignore the host's answer like Docker's, but not an unreachable host", async () => {
  answers = [() => ({ status: 502, json: { error: "host_error" } })];
  await provider().stop(HANDLE);
  await provider().stopVnc(HANDLE);
  const closed = new remote.RemoteComputerProvider({ origin: "http://127.0.0.1:9", token: TOKEN, timeoutMs: 2_000 });
  await assert.rejects(() => closed.stop(HANDLE), { message: errors.COMPUTER_UNREACHABLE });
});

test("an answer that is not the host's JSON is the unreachable sentence, never a parse error", async () => {
  answers = [() => ({ status: 200, bytes: Buffer.from("<html>502 Bad Gateway</html>"), type: "text/html" })];
  for (const call of [() => provider().state(HANDLE), () => provider().exec(HANDLE, "ls"), () => provider().listOwned()]) {
    await assert.rejects(call, { message: errors.COMPUTER_UNREACHABLE });
  }
  assert.deepEqual(await provider().available(), { ok: false, reason: "The computer host can't be reached right now." });
});

test("the host never learns a user id", () => {
  const ref = remote.hostUserRef("cmuser456");
  assert.match(ref, /^u_[0-9a-f]{32}$/);
  assert.ok(!ref.includes("cmuser456"));
  assert.equal(remote.hostUserRef("cmuser456"), ref);
});
