/**
 * Antigravity end to end with a fake antigravity-acp runtime
 * (fixtures/fake-antigravity.mjs): managed install from a pinned archive,
 * Google sign-in through the runtime's 127.0.0.1 callback (direct and pasted),
 * one private profile per instance, no ambient Google credentials, probes that
 * only initialize, sessions, sign-out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { crc32 } from "node:zlib";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { ProviderInstance, ServerEventEnvelope } from "../src/contracts/code-v2.js";
import type { AntigravityReleaseAsset } from "../src/providers/antigravity/release.js";
import {
  browserCommand,
  parseAuthorizationUrl,
  profileDirectories,
  validateCallbackUrl,
  CallbackError,
  STRIPPED_ENV,
  runtimeEnv,
  prepareProfile,
} from "../src/providers/antigravity/auth-support.js";
import { readZipEntries } from "../src/providers/antigravity/zip.js";
import { TestClient, FIXTURES, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

const FAKE = path.join(FIXTURES, "fake-antigravity.mjs");
const runtimeScript = `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`;
const harnessScript = "#!/bin/sh\nexit 0\n";

/** A directory holding a hand-installed runtime pair, as on PATH. */
function runtimeDir(): string {
  const dir = tempDir("agy-bin");
  fs.writeFileSync(path.join(dir, "agy_acp_server.par"), runtimeScript, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "localharness_external"), harnessScript, { mode: 0o755 });
  return dir;
}

/** A stored (uncompressed) zip with Unix modes, like Google's release archives. */
function zip(files: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((f.mode ?? 0o100755) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function serve(body: Buffer): Promise<{ url: string; close: () => void; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/zip", "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/agy.zip`, close: () => server.close(), hits: () => hits };
}

function releaseFor(archive: Buffer, url: string, version = "1.3.0"): AntigravityReleaseAsset {
  return {
    version,
    url,
    sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.length,
    executable: { name: "agy_acp_server.par", bytes: Buffer.byteLength(runtimeScript) },
    harness: { name: "localharness_external", bytes: Buffer.byteLength(harnessScript) },
  };
}

async function boot(options: { searchDirs?: string[]; release?: AntigravityReleaseAsset | null; instances?: unknown[]; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? tempDir("agy-data");
  if (options.instances) fs.writeFileSync(path.join(dataDir, "instances.json"), JSON.stringify(options.instances));
  const searchDirs = options.searchDirs ?? [tempDir("empty-bin")];
  const server = await startEnvServer({
    dataDir,
    searchDirs,
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    forcePipeTerminals: true,
    computerUse: false,
    antigravity: { release: options.release ?? null, searchDirs: () => searchDirs, authTimeoutMs: 20_000 },
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  return { server, client, dataDir };
}

function latestInstance(client: TestClient, id: string): ProviderInstance | undefined {
  const updates = client.events.filter(
    (e): e is ServerEventEnvelope & { event: { type: "provider.updated"; instance: ProviderInstance } } =>
      e.stream === "global" && e.event.type === "provider.updated" && e.event.instance.id === id,
  );
  return updates.at(-1)?.event.instance;
}

async function waitAuth(client: TestClient, id: string, phase: string): Promise<ProviderInstance> {
  return client.waitFor(() => {
    const instance = latestInstance(client, id);
    return instance?.auth?.phase === phase ? instance : undefined;
  }, 15_000, `auth ${phase}`);
}

const ask = { runtimeMode: "ask", interactionMode: "default" } as const;

// ── Pure pieces ─────────────────────────────────────────────────────────────

test("antigravity: authorization URLs and pasted redirects are checked against the flow", () => {
  const good = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A52011%2F&response_type=code&state=abc";
  const parsed = parseAuthorizationUrl(good);
  assert.deepEqual(parsed && { r: parsed.redirectUri, s: parsed.state }, { r: "http://127.0.0.1:52011/", s: "abc" });
  assert.equal(parseAuthorizationUrl(good.replace("accounts.google.com", "accounts.google.com.evil.test")), null);
  assert.equal(parseAuthorizationUrl(good.replace("127.0.0.1%3A52011", "localhost%3A52011")), null);
  assert.equal(parseAuthorizationUrl(good.replace("52011", "80")), null);
  assert.equal(parseAuthorizationUrl(`${good}&state=two`), null);

  const pending = { redirectUri: "http://127.0.0.1:52011/", state: "abc" };
  assert.equal(validateCallbackUrl(pending, "http://127.0.0.1:52011/?state=abc&code=4%2F0A&iss=https%3A%2F%2Faccounts.google.com").searchParams.get("code"), "4/0A");
  assert.ok(validateCallbackUrl(pending, "http://127.0.0.1:52011/?state=abc&error=access_denied"));
  for (const bad of [
    "http://127.0.0.1:52011/?state=zzz&code=1",
    "http://127.0.0.1:52012/?state=abc&code=1",
    "http://localhost:52011/?state=abc&code=1",
    "https://127.0.0.1:52011/?state=abc&code=1",
    "http://127.0.0.1:52011/x?state=abc&code=1",
    "http://127.0.0.1:52011/?state=abc&code=1&code=2",
    "http://127.0.0.1:52011/?state=abc&code=1&error=x",
    "http://127.0.0.1:52011/?state=abc&code=1&iss=https%3A%2F%2Fevil.test",
    "http://user@127.0.0.1:52011/?state=abc&code=1",
    "not a url",
  ]) {
    assert.throws(() => validateCallbackUrl(pending, bad), CallbackError, bad);
  }
});

test("antigravity: profile per instance, file token storage, no ambient credentials", () => {
  const data = tempDir("agy-profile");
  const a = profileDirectories(data, "acp:antigravity");
  const b = profileDirectories(data, "acp:antigravity:work");
  const c = profileDirectories(data, "acp:Antigravity:work");
  assert.notEqual(a.profile, b.profile);
  assert.notEqual(b.profile, c.profile, "case-only differences stay apart");
  const profile = prepareProfile(data, "acp:antigravity");
  assert.equal(fs.statSync(profile.geminiHome).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.acpDirectory, "settings.json"), "utf8")), { auth: { type: "oauth-personal" } });
  const env = runtimeEnv(profile, "/x/localharness_external", { GEMINI_API_KEY: "leak", GOOGLE_CLOUD_PROJECT: "p", BROWSER: "firefox", MY_FLAG: "1" });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(env.MY_FLAG, "1");
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(env.GEMINI_HOME, profile.geminiHome);
  assert.notEqual(env.BROWSER, "firefox");
  assert.ok(STRIPPED_ENV.has("GOOGLE_APPLICATION_CREDENTIALS"));
  assert.throws(() => browserCommand("/Applications/Odd:Name/node"));
});

// ── Install ─────────────────────────────────────────────────────────────────

test("antigravity: install downloads the pinned archive, verifies it and activates it; a tampered one changes nothing", async () => {
  const files = [
    { name: "agy_acp_server.par", data: Buffer.from(runtimeScript) },
    { name: "localharness_external", data: Buffer.from(harnessScript) },
  ];
  const archive = zip(files);
  assert.deepEqual(
    readZipEntries((() => {
      const f = path.join(tempDir("zip"), "a.zip");
      fs.writeFileSync(f, archive);
      return f;
    })()).map((e) => e.name),
    ["agy_acp_server.par", "localharness_external"],
  );
  const host = await serve(archive);
  try {
    // A release whose hash does not match what is served: nothing is installed.
    const bad = { ...releaseFor(archive, host.url), sha256: "0".repeat(64) };
    const first = await boot({ release: bad });
    const started = await first.client.command<{ install: { phase: string } }>("provider.install", { instanceId: "acp:antigravity", action: "start" });
    assert.equal(started.install.phase, "downloading");
    const failed = await first.server.antigravity.installer.settled();
    assert.equal(failed.phase, "failed");
    assert.match(failed.message ?? "", /SHA-256/);
    assert.equal(fs.existsSync(path.join(first.server.antigravity.installer.managedDirectory, "active.json")), false);

    // The real thing.
    const { server, client } = await boot({ release: releaseFor(archive, host.url) });
    let probe = await client.command<{ instance: ProviderInstance }>("provider.probe", { instanceId: "acp:antigravity" });
    assert.equal(probe.instance.status, "not-installed");
    await client.command("provider.install", { instanceId: "acp:antigravity", action: "start" });
    const done = await server.antigravity.installer.settled();
    assert.equal(done.phase, "succeeded", done.message);
    assert.equal(done.installedVersion, "1.3.0");
    const managed = server.antigravity.installer.managedDirectory;
    assert.ok(fs.existsSync(path.join(managed, "active.json")));
    const exe = server.antigravity.installer.resolve();
    assert.equal(exe.source, "managed");
    assert.equal(fs.statSync(exe.executablePath).mode & 0o111, 0o111);
    probe = await client.command<{ instance: ProviderInstance }>("provider.probe", { instanceId: "acp:antigravity" });
    assert.equal(probe.instance.status, "signed-out");
    assert.equal(probe.instance.install?.phase, "succeeded");
    assert.equal(probe.instance.capabilities?.rollback, false);
    assert.equal(probe.instance.capabilities?.mcpInjection, true);
    // Removing the runtime keeps nothing behind.
    await client.command("provider.install", { instanceId: "acp:antigravity", action: "remove" });
    assert.equal(fs.existsSync(managed), false);
  } finally {
    host.close();
  }
});

test("antigravity: an archive with an extra file is refused", async () => {
  const archive = zip([
    { name: "agy_acp_server.par", data: Buffer.from(runtimeScript) },
    { name: "localharness_external", data: Buffer.from(harnessScript) },
    { name: "../evil", data: Buffer.from("x") },
  ]);
  const host = await serve(archive);
  try {
    const { server, client } = await boot({ release: releaseFor(archive, host.url) });
    await client.command("provider.install", { instanceId: "acp:antigravity", action: "start" });
    const state = await server.antigravity.installer.settled();
    assert.equal(state.phase, "failed");
    assert.match(state.message ?? "", /exactly/);
  } finally {
    host.close();
  }
});

// ── Sign-in, sessions, sign-out ─────────────────────────────────────────────

test("antigravity: probe only initializes; Google sign-in finishes on the loopback, a session runs without ambient keys, sign-out stops it", async () => {
  const bin = runtimeDir();
  const logFile = path.join(tempDir("agy-log"), "methods.log");
  const previous = { gemini: process.env.GEMINI_API_KEY, gcp: process.env.GOOGLE_CLOUD_PROJECT };
  process.env.GEMINI_API_KEY = "ambient-leak";
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-project";
  try {
    const { server, client, dataDir } = await boot({
      searchDirs: [bin],
      instances: [{ id: "acp:antigravity", env: { FAKE_AGY_LOG: logFile, GEMINI_API_KEY: "instance-leak" } }],
    });
    const probe = await client.command<{ instance: ProviderInstance }>("provider.probe", { instanceId: "acp:antigravity" });
    assert.equal(probe.instance.status, "signed-out");
    assert.equal(probe.instance.version, "1.3.0");
    assert.deepEqual(fs.readFileSync(logFile, "utf8").trim().split("\n"), ["initialize"], "a probe calls initialize and nothing else");

    // Signed out: turns are refused with a plain sentence.
    const repo = tempDir("agy-cwd");
    const selection = { instanceId: "acp:antigravity", model: "default" };
    const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd: repo, selection });
    await assert.rejects(client.command("turn.start", { sessionId, input: { text: "hi" }, selection, ...ask }), /Sign in/);

    // Sign in: the browser on this Mac lands on the runtime's loopback directly.
    const start = await client.command<{ auth: { phase: string; flowId: string } }>("provider.auth", { instanceId: "acp:antigravity", action: "start" });
    assert.equal(start.auth.phase, "starting");
    const waiting = await waitAuth(client, "acp:antigravity", "waiting");
    const authUrl = new URL(waiting.auth!.authorizationUrl!);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
    redirect.searchParams.set("code", "direct-code");
    const res = await fetch(redirect);
    assert.equal(res.status, 200);
    await waitAuth(client, "acp:antigravity", "succeeded");
    const ready = await client.waitFor(() => {
      const i = latestInstance(client, "acp:antigravity");
      return i?.status === "ready" ? i : undefined;
    }, 10_000, "ready");
    assert.deepEqual(ready.models?.map((m) => m.id), ["gemini-3-pro", "gemini-3-flash"]);
    const profile = profileDirectories(dataDir, "acp:antigravity").profile;
    assert.ok(fs.existsSync(path.join(profile, "antigravity-acp", "acp_token.json")), "the token lives in the instance's own profile");

    // A session: no ambient or instance-level Google key reaches the runtime.
    const t = await client.command<{ turnId: string }>("turn.start", { sessionId, input: { text: "env" }, selection, ...ask });
    await client.turnCompleted(sessionId, t.turnId);
    const reply = [...client.snapshot(sessionId).items].reverse().find((i) => i.kind === "assistant_message") as { text: string } | undefined;
    const seen = JSON.parse(reply?.text ?? "{}") as Record<string, unknown>;
    assert.equal(seen.gemini, false);
    assert.equal(seen.gcp, false);
    assert.equal(seen.home, profile);
    assert.equal(seen.fileStorage, "1");
    assert.equal(path.basename(String(seen.harness)), "localharness_external");

    // Sign out: the runtime's own logout, the session stops, the instance is signed out.
    const out = await client.command<{ auth: { phase: string } }>("provider.auth", { instanceId: "acp:antigravity", action: "logout" });
    assert.equal(out.auth.phase, "idle");
    assert.equal(fs.existsSync(path.join(profile, "antigravity-acp", "acp_token.json")), false);
    assert.equal(server.registry.get("acp:antigravity")?.status, "signed-out");
  } finally {
    if (previous.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous.gemini;
    if (previous.gcp === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = previous.gcp;
  }
});

test("antigravity: from another device the pasted redirect finishes sign-in; a foreign one is refused; each account has its own profile", async () => {
  const bin = runtimeDir();
  const { client, dataDir } = await boot({
    searchDirs: [bin],
    instances: [{ id: "acp:antigravity:work", kind: "acp", label: "Antigravity (work)", acpCommand: ["antigravity-acp"] }],
  });
  await client.command("provider.auth", { instanceId: "acp:antigravity:work", action: "start" });
  const waiting = await waitAuth(client, "acp:antigravity:work", "waiting");
  const flowId = waiting.auth!.flowId!;
  const authUrl = new URL(waiting.auth!.authorizationUrl!);
  const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);

  const foreign = new URL(redirect);
  foreign.searchParams.set("state", "not-this-flow");
  foreign.searchParams.set("code", "x");
  await assert.rejects(
    client.command("provider.auth", { instanceId: "acp:antigravity:work", action: "complete", flowId, callbackUrl: foreign.href }),
    (e: Error & { code?: string }) => e.code === "bad_request",
  );

  const pasted = new URL(redirect);
  pasted.searchParams.set("state", authUrl.searchParams.get("state")!);
  pasted.searchParams.set("code", "pasted-code");
  pasted.searchParams.set("iss", "https://accounts.google.com");
  const completed = await client.command<{ auth: { phase: string } }>("provider.auth", { instanceId: "acp:antigravity:work", action: "complete", flowId, callbackUrl: pasted.href });
  assert.equal(completed.auth.phase, "verifying");
  await waitAuth(client, "acp:antigravity:work", "succeeded");
  const work = profileDirectories(dataDir, "acp:antigravity:work").profile;
  const personal = profileDirectories(dataDir, "acp:antigravity").profile;
  assert.match(fs.readFileSync(path.join(work, "antigravity-acp", "acp_token.json"), "utf8"), /pasted-code/);
  assert.equal(fs.existsSync(path.join(personal, "antigravity-acp", "acp_token.json")), false, "the other account is still signed out");

  // A second complete for a finished flow is refused.
  await assert.rejects(
    client.command("provider.auth", { instanceId: "acp:antigravity:work", action: "complete", flowId, callbackUrl: pasted.href }),
    (e: Error & { code?: string }) => e.code === "not_found",
  );
});

test("antigravity: the runtime's own stdout prompt also starts the flow, and cancel stops it", async () => {
  const bin = runtimeDir();
  const { client, server } = await boot({ searchDirs: [bin], instances: [{ id: "acp:antigravity", env: { FAKE_AGY_PROMPT: "stdout" } }] });
  await client.command("provider.auth", { instanceId: "acp:antigravity", action: "start" });
  const waiting = await waitAuth(client, "acp:antigravity", "waiting");
  await client.command("provider.auth", { instanceId: "acp:antigravity", action: "cancel", flowId: waiting.auth!.flowId });
  const state = await server.antigravity.settled("acp:antigravity");
  assert.equal(state?.phase, "cancelled");
  assert.equal(server.registry.get("acp:antigravity")?.auth?.phase, "cancelled");
});

test("antigravity: install and sign-in commands are refused for CLI providers", async () => {
  const { client } = await boot();
  await assert.rejects(client.command("provider.install", { instanceId: "codex:default", action: "start" }), (e: Error & { code?: string }) => e.code === "unsupported");
  await assert.rejects(client.command("provider.auth", { instanceId: "acp:gemini", action: "start" }), (e: Error & { code?: string }) => e.code === "unsupported");
});
