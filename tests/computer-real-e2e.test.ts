/**
 * Agent computers for real, end to end, for both providers
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S4.1): a real computer container,
 * reached through the provider the app uses (`docker` on one box, or `remote`
 * through deploy/computer-host over TLS), driven through the real store (on its
 * in-memory persistence), the relay's real upgrade handler, the product's agent
 * browser, and agent-core's Work loop from `dist`, with the scripted Work model.
 * No AI model is called anywhere here, and no browser step needs the network: every
 * page is put in place with `page.setContent` or a `data:` URL.
 *
 * Opt-in, and only on a machine prepared for it (root: a Docker network, iptables
 * rules, addresses on lo):
 *
 *   sudo -E python3 tests/computer_host_fixture.py up
 *   JUNO_COMPUTER_E2E=1 JUNO_COMPUTER_E2E_PROVIDER=docker npx tsx --test tests/computer-real-e2e.test.ts
 *   JUNO_COMPUTER_HOST_PYTHON=<python with websockets 10.4..14> sudo -E python3 tests/computer_host_fixture.py host-up
 *   . /run/juno-computer-fixture/host.env      # NODE_EXTRA_CA_CERTS must be set when Node starts
 *   JUNO_COMPUTER_E2E=1 JUNO_COMPUTER_E2E_PROVIDER=remote npx tsx --test tests/computer-real-e2e.test.ts
 *   sudo -E python3 tests/computer_host_fixture.py down
 *
 * Needs `npm run test:prepare` (agent-core's dist), the relay's dependencies
 * (`npm ci --prefix relay`) and Playwright. The remote suite runs as root (test 14
 * stops and starts the host service). At most one computer container is awake at a
 * time, with COMPUTER_MEMORY_MB=1024 unless set. Every timed assertion multiplies by
 * JUNO_COMPUTER_TEST_SLACK (CI sets 2.5). JUNO_COMPUTER_E2E_EVIDENCE names a
 * directory for the screenshots and a record of the run.
 *
 * The tests share one computer and run in order; each starts by putting it back in a
 * known state (no take over, awake, nothing of the agent's running). Test 10 rebuilds
 * the image, so it runs last.
 *
 * Without JUNO_COMPUTER_E2E=1 every test here is skipped: the unit shards run
 * tests/*.test.ts, and this suite needs a prepared machine.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { chunkReader, rfbHandshake, type RfbHandshakeResult, type RfbTransport } from "./helpers/vnc-auth";

const OPT_IN = process.env.JUNO_COMPUTER_E2E === "1";
const PROVIDER = (process.env.JUNO_COMPUTER_E2E_PROVIDER ?? "docker").trim();
const SLACK = Number(process.env.JUNO_COMPUTER_TEST_SLACK) || 1;
const FIXTURE_STATE = process.env.JUNO_COMPUTER_FIXTURE_STATE || "/run/juno-computer-fixture/state.json";
const EVIDENCE = process.env.JUNO_COMPUTER_E2E_EVIDENCE || "";
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/computer_host_fixture.py");
const SKIP = OPT_IN ? false : "set JUNO_COMPUTER_E2E=1 on a machine prepared with tests/computer_host_fixture.py up";

// The account and agent: a Pro account on the allowlist (the production rollout
// default), so the plan's own caps (one computer, 120 minutes a week) apply.
const USER = "user_e2e";
const AGENT = `e2e${PROVIDER === "remote" ? "r" : "d"}${randomBytes(4).toString("hex")}`;
const NAME = `juno-agent-${AGENT}`;
/** The docker suite's own tag of the image, so test 10's rebuild never retags juno-computer:1. */
const DOCKER_TAG = "juno-computer:e2e";
const RELAY_ORIGIN = "http://app.test";

if (OPT_IN) {
  // The app's modules import "server-only", which throws outside a server build.
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = loader._load;
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

type Store = typeof import("@/lib/computer/store");
type Provider = import("@/lib/computer/types").ComputerProvider;
type Handle = import("@/lib/computer/types").ComputerHandle;
type Secrets = import("@/lib/computer/types").ComputerSecrets;
type Memory = ReturnType<Store["createInMemoryComputerPersistence"]>;
type Runtime = typeof import("../runner/agent-core/src/work/index.js");
type WorkApprovalRequest = import("../runner/agent-core/src/work/types.js").WorkApprovalRequest;
type WorkEmittedEvent = import("../runner/agent-core/src/work/types.js").WorkEmittedEvent;
type ScriptedWorkScript = import("../runner/agent-core/src/work/scripted-model.js").ScriptedWorkScript;
type Page = import("playwright").Page;
/** The slice of the relay's `ws` client (relay/node_modules/ws, 8.x) this suite uses. */
interface WS {
  once(event: string, listener: (...args: never[]) => void): void;
  on(event: string, listener: (...args: never[]) => void): void;
  send(data: Buffer): void;
  close(): void;
}
type WSConstructor = new (url: string, protocols?: string[] | Record<string, unknown>, options?: Record<string, unknown>) => WS;

interface Awake {
  handle: Handle;
  secrets: Secrets;
  provider: Provider;
}

interface FixtureState {
  pid: number;
  network: string;
  policyFile: string;
  egressMap: string;
  sandbox: boolean;
  sandboxReason: string;
  seccompProfile: string | null;
  image: string;
}

interface HostState {
  url: string;
  tokenFile: string;
  caFile: string;
}

const lib = {} as {
  store: Store;
  providerModule: typeof import("@/lib/computer/provider");
  remote: typeof import("@/lib/computer/remote");
  access: typeof import("@/lib/computer/access");
  remoteBrowser: typeof import("@/lib/computer/remote-browser");
  runTools: typeof import("@/lib/computer/run-tools");
  takeover: typeof import("@/lib/computer/takeover");
  sweep: typeof import("@/lib/computer/sweep");
  relay: typeof import("../relay/src/computer-view");
  WebSocket: WSConstructor;
  runtime: Runtime;
};
let mem: Memory;
let fixture: FixtureState;
let relayServer: Server | null = null;
let relayPort = 0;
let originalImageId = "";
let shimDirectory = "";
const savedEnv: Record<string, string | undefined> = {};
const record: Record<string, unknown> = { provider: PROVIDER, agent: AGENT, startedAt: new Date().toISOString() };

// ── Small helpers ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | null | false | undefined>, everyMs = 200): Promise<T> {
  const deadline = Date.now() + seconds * 1000 * SLACK;
  let last: T | null | false | undefined = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${seconds * SLACK}s waiting for ${what}`);
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * The Docker CLI itself, for the suite's own setup and observations. Resolved before
 * the docker suite puts the broker shim first on PATH (below), so these calls never
 * go through the broker, and the provider's always do.
 */
let dockerBin = "docker";

function docker(...args: string[]): string {
  return execFileSync(dockerBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }).trim();
}

const dockerQuiet = (...args: string[]) => spawnSync(dockerBin, args);

/** Looks inside the computer as the browser uid, outside the provider (an observation, never an action under test). */
function observe(argv: string[], opts: { display?: boolean; allowFail?: boolean } = {}): string {
  const result = spawnSync(dockerBin, ["exec", "--user", "1001", ...(opts.display ? ["-e", "DISPLAY=:0"] : []), NAME, ...argv], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`observe ${argv.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Every uid-1000 process: its pid, its state, and its arguments. A process in
 * uninterruptible sleep (D) with SIGSTOP pending reads as "Tp": it runs none of its
 * own code again before it stops, and agent-exec's freeze counts it as stopped.
 */
function agentProcesses(): Array<{ pid: number; state: string; args: string }> {
  return observe(["python3", "-I", "-c", AGENT_PROCESSES_PROBE], { allowFail: true })
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]!))
    .map((parts) => ({ pid: Number(parts[0]), state: parts[1]!, args: parts.slice(2).join("\t") }));
}

/** Stopped (T, t, or D with the stop pending) or gone (Z, X). */
const frozen = (p: { state: string }) => /^[TtZX]/.test(p.state);
const runningAgentProcesses = () => agentProcesses().filter((p) => !frozen(p));

function evidence(name: string, data: Buffer | string): void {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, `${PROVIDER}-${name}`), data);
}

function note(test: string, value: unknown): void {
  record[test] = value;
}

function fixtureCommand(...args: string[]): string {
  return execFileSync("python3", [FIXTURE, ...args], { encoding: "utf8", timeout: 240_000, env: process.env }).trim();
}

// ── The computer, through the store ─────────────────────────────────────────────

async function wake(): Promise<Awake> {
  const awake = await lib.store.ensureAwake(USER, AGENT, { by: "person", actor: "web", autoEnable: true });
  return { handle: awake.handle, secrets: awake.secrets, provider: awake.provider };
}

/**
 * Back to a known state before a test: no take over open, awake, thawed, and none
 * of the agent's processes left over from the test before.
 */
async function fresh(): Promise<Awake> {
  const row = await mem.findByAgent(USER, AGENT);
  if (row && (row.takeoverBy || row.takeoverUntil)) {
    await lib.store.heartbeatComputerViewSession(USER, AGENT, { mode: "control", ended: true, actor: "web" }).catch(() => undefined);
  }
  const awake = await wake();
  await awake.provider.thawAgent(awake.handle).catch(() => undefined);
  await awake.provider.exec(awake.handle, "kill -9 -1 2>/dev/null; true", { timeoutSeconds: 20 }).catch(() => undefined);
  await waitFor("the agent's processes to be gone", 10, async () => agentProcesses().length === 0);
  return awake;
}

/** The product's agent browser for one job, then disconnected (the gate allows one CDP client at a time). */
async function withAgentPage<T>(awake: Awake, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = lib.remoteBrowser.connectAgentBrowser(awake.handle, awake.secrets, { provider: awake.provider });
  try {
    return await browser.withPage(fn);
  } finally {
    await browser.close();
  }
}

/**
 * The page the screen shows: every other tab closed (never Chromium's own WebUI
 * pages, which have no window; closing them is not this test's business), this
 * one in front. The agent browser drives a tab, never one of those.
 */
async function onlyTab(page: Page): Promise<void> {
  assert.ok(await lib.remoteBrowser.isBrowserTab(page), `the agent browser drives a real tab, not ${page.url()}`);
  for (const other of page.context().pages()) {
    if (other !== page && !other.isClosed() && (await lib.remoteBrowser.isBrowserTab(other))) await other.close().catch(() => undefined);
  }
  await page.bringToFront();
}

// ── The relay and RFB ───────────────────────────────────────────────────────────

interface RfbSession {
  ws: WS;
  transport: RfbTransport;
  /** Resolves with Date.now() when the relay closes the connection. */
  closed: Promise<number>;
}

async function openRfb(token: string): Promise<RfbSession> {
  const reader = chunkReader();
  const ws = new lib.WebSocket(`ws://127.0.0.1:${relayPort}/voice-relay/computer`, [`juno-view.${token}`, "binary"], {
    headers: { Origin: RELAY_ORIGIN },
  });
  const closed = new Promise<number>((resolve) => {
    ws.once("close", () => {
      reader.close("the relay closed the connection");
      resolve(Date.now());
    });
  });
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    reader.push(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_request: unknown, response: { statusCode?: number }) => reject(new Error(`the relay answered ${response.statusCode}`)));
  });
  return { ws, transport: { read: reader.read, write: (bytes: Buffer) => ws.send(bytes) }, closed };
}

async function rfbLogin(token: string, password: string): Promise<{ session: RfbSession; result: RfbHandshakeResult }> {
  const session = await openRfb(token);
  const result = await rfbHandshake(session.transport, password, 20_000 * SLACK);
  return { session, result };
}

async function viewSession(mode: "watch" | "control") {
  const view = await lib.store.openComputerViewSession(USER, AGENT, mode, { actor: "web", agentName: "Mira" });
  assert.equal(view.kind, "direct");
  if (view.kind !== "direct") throw new Error("expected a direct view session");
  return view;
}

function tokenVersion(token: string): number {
  return (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { v: number }).v;
}

/** Another 8-character password that is certainly not this one. */
const notThePassword = (password: string) => password.split("").reverse().join("").replace(/^./, (c) => (c === "Z" ? "Y" : "Z"));

// ── A background loop of the agent's, and how far it got ────────────────────────

const TICKS = "/home/agent/work/e2e/ticks";

async function startTicker(awake: Awake): Promise<void> {
  const res = await awake.provider.exec(
    awake.handle,
    `mkdir -p /home/agent/work/e2e && rm -f ${TICKS} && setsid nohup sh -c 'while true; do date +%s%N >> ${TICKS}; sleep 0.2; done' >/dev/null 2>&1 &`,
    { timeoutSeconds: 20 },
  );
  assert.equal(res.exitCode, 0, res.stderr);
  await waitFor("the ticker to write", 10, async () => (await tickCount()) > 3);
}

function ticks(): number[] {
  return observe(["cat", TICKS], { allowFail: true })
    .split("\n")
    .filter((line) => /^\d{19}$/.test(line.trim()))
    .map((line) => Math.floor(Number(BigInt(line.trim()) / 1_000_000n)));
}

const tickCount = async () => ticks().length;

/** Opens a take over through the store; the agent is frozen, the person logged in over RFB. */
async function takeOver(): Promise<{ person: RfbSession; password: string }> {
  const control = await viewSession("control").catch((error: unknown) => {
    // What x11vnc said, when starting the person's stream is what failed.
    const vnc = observe(["tail", "-n", "15", "/tmp/x11vnc.log"], { allowFail: true });
    throw new Error(`take over failed: ${error instanceof Error ? error.message : String(error)}\nx11vnc.log:\n${vnc}`);
  });
  assert.equal(control.freeze, "ok", "the store froze the agent at take over");
  const { session, result } = await rfbLogin(control.token, control.password);
  assert.equal(result.ok, true, `the control password logs in: ${JSON.stringify(result)}`);
  return { person: session, password: control.password };
}

async function handBack(): Promise<void> {
  await lib.store.heartbeatComputerViewSession(USER, AGENT, { mode: "control", ended: true, actor: "web" });
}

// ── Set up and tear down ────────────────────────────────────────────────────────

describe(`agent computers for real (${PROVIDER})`, { skip: SKIP }, () => {
  before(async () => {
    if (PROVIDER !== "docker" && PROVIDER !== "remote") throw new Error(`JUNO_COMPUTER_E2E_PROVIDER must be docker or remote, not ${PROVIDER}`);
    // Refuses to run without the fixture: the network, the firewall and the proxy are the arrangement under test.
    if (!existsSync(FIXTURE_STATE)) throw new Error(`no fixture: run \`sudo -E python3 tests/computer_host_fixture.py up\` first (${FIXTURE_STATE})`);
    fixture = JSON.parse(readFileSync(FIXTURE_STATE, "utf8")) as FixtureState;
    try {
      process.kill(fixture.pid, 0);
    } catch {
      throw new Error(`the fixture's holder (pid ${fixture.pid}) is not running; bring it up again`);
    }
    docker("network", "inspect", fixture.network);

    const req = createRequire(__filename);
    lib.store = req("../src/lib/computer/store") as Store;
    lib.providerModule = req("../src/lib/computer/provider") as typeof lib.providerModule;
    lib.remote = req("../src/lib/computer/remote") as typeof lib.remote;
    lib.access = req("../src/lib/computer/access") as typeof lib.access;
    lib.remoteBrowser = req("../src/lib/computer/remote-browser") as typeof lib.remoteBrowser;
    lib.runTools = req("../src/lib/computer/run-tools") as typeof lib.runTools;
    lib.takeover = req("../src/lib/computer/takeover") as typeof lib.takeover;
    lib.sweep = req("../src/lib/computer/sweep") as typeof lib.sweep;
    lib.relay = req("../relay/src/computer-view") as typeof lib.relay;
    lib.WebSocket = (req("../relay/node_modules/ws") as { WebSocket: WSConstructor }).WebSocket;
    lib.runtime = (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

    const authSecret = randomBytes(32).toString("hex");
    setEnv({
      COMPUTER_PROVIDER: PROVIDER,
      AGENT_COMPUTER_PROVIDER: undefined,
      AGENT_COMPUTER_ROLLOUT: "allowlist",
      AGENT_COMPUTER_ALLOWLIST: USER,
      AUTH_SECRET: authSecret,
      COMPUTER_MEMORY_MB: process.env.COMPUTER_MEMORY_MB || "1024",
      COMPUTER_MIN_FREE_DISK_GB: process.env.COMPUTER_MIN_FREE_DISK_GB || "4",
      AGENT_COMPUTER_COST_USD_PER_MIN: undefined,
      COMPUTER_COST_MICRO_USD_PER_SECOND: undefined,
      AGENT_COMPUTER_REQUIRE_BROWSER_SANDBOX: undefined,
    });
    dockerBin = execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
    if (PROVIDER === "docker") {
      // The image under its own tag (test 10 rebuilds that tag), Chromium's sandbox as the fixture decided it.
      originalImageId = docker("image", "inspect", "--format", "{{.Id}}", fixture.image);
      docker("tag", originalImageId, DOCKER_TAG);
      setEnv({ COMPUTER_DOCKER_IMAGE: DOCKER_TAG, AGENT_COMPUTER_IMAGE: undefined, JUNO_COMPUTER_SECCOMP_PROFILE: fixture.seccompProfile ?? "" });
      // Production's single-box path: every docker call the provider makes goes through the
      // real broker (deploy/agent-computers/docker-broker.py: its validate(), its namespace
      // check and its egress-map hooks), under the fixture's policy for this suite's tag.
      // Outside production the provider runs `docker` from PATH; here that is the broker.
      shimDirectory = mkdtempSync(path.join(tmpdir(), "juno-e2e-broker-"));
      const policy = { ...(JSON.parse(readFileSync(fixture.policyFile, "utf8")) as Record<string, unknown>), image: DOCKER_TAG };
      const policyFile = path.join(shimDirectory, "computer-broker.json");
      writeFileSync(policyFile, JSON.stringify(policy));
      const shim = path.join(shimDirectory, "docker");
      writeFileSync(
        shim,
        `#!/bin/sh\necho "$1" >> ${path.join(shimDirectory, "calls.log")}\nexec python3 -I -c '${BROKER_SHIM}' ${[path.join(ROOT, "deploy/agent-computers/docker-broker.py"), policyFile,
          path.join(ROOT, "deploy/agent-computers/egress-map.py"), fixture.egressMap].join(" ")} "$@"\n`,
      );
      chmodSync(shim, 0o755);
      setEnv({ PATH: `${shimDirectory}:${process.env.PATH ?? ""}` });
    } else {
      const hostPath = process.env.JUNO_COMPUTER_E2E_HOST_STATE || path.join(path.dirname(FIXTURE_STATE), "host.json");
      if (!existsSync(hostPath)) throw new Error("no computer host: run `sudo -E python3 tests/computer_host_fixture.py host-up` first");
      const host = JSON.parse(readFileSync(hostPath, "utf8")) as HostState;
      if (process.env.NODE_EXTRA_CA_CERTS !== host.caFile) {
        throw new Error(`start Node with NODE_EXTRA_CA_CERTS=${host.caFile} (source host.env): the host's TLS is the production path`);
      }
      originalImageId = docker("image", "inspect", "--format", "{{.Id}}", "juno-computer:1");
      // A short per-request timeout, so test 14's outage is quick to observe.
      setEnv({ COMPUTER_HOST_URL: host.url, COMPUTER_HOST_TOKEN: readFileSync(host.tokenFile, "utf8").trim(), COMPUTER_HOST_TIMEOUT_MS: "8000" });
      lib.remote.resetRemoteComputerProviderForTest();
    }
    lib.providerModule.resetComputerProviderCache();
    lib.access.resetComputerAvailabilityCacheForTest();
    lib.sweep.resetSweepLogsForTest();
    lib.sweep.resetOrphanTrackingForTest();

    mem = lib.store.createInMemoryComputerPersistence();
    lib.store.setComputerStorePersistenceForTest(mem);
    mem.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "PRO" });
    mem.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: "allowed" });
    const provider = lib.providerModule.computerProvider();
    assert.equal(provider?.name, PROVIDER, "the provider the suite asked for (a malformed host URL or token keeps it off)");

    // The relay's real upgrade handler on an ephemeral port.
    const handler = lib.relay.createComputerViewUpgradeHandler({
      allowedOrigins: [RELAY_ORIGIN],
      authSecret,
      computerHosts: PROVIDER === "remote" ? [new URL(process.env.COMPUTER_HOST_URL!).origin] : [],
    });
    relayServer = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    relayServer.on("upgrade", (request, socket, head) => {
      if (!handler.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => relayServer!.listen(0, "127.0.0.1", () => resolve()));
    relayPort = (relayServer.address() as AddressInfo).port;

    const started = Date.now();
    await wake();
    note("setup", { wokeInMs: Date.now() - started, sandbox: fixture.sandbox, sandboxReason: fixture.sandboxReason });
  });

  after(async () => {
    try {
      const provider = lib.providerModule?.computerProvider();
      const row = mem ? await mem.findByAgent(USER, AGENT) : null;
      if (provider && row?.containerRef) {
        await provider.destroy(lib.store.decodeHandle(row.containerRef, AGENT), { removeVolume: true }).catch(() => undefined);
      }
    } finally {
      // Whatever a failure left behind: this suite's container and volumes only.
      dockerQuiet("rm", "-f", NAME);
      dockerQuiet("volume", "rm", "-f", NAME, `${NAME}-browser`);
      if (PROVIDER === "docker") dockerQuiet("image", "rm", DOCKER_TAG);
      if (shimDirectory) rmSync(shimDirectory, { recursive: true, force: true });
      if (relayServer) await new Promise<void>((resolve) => relayServer!.close(() => resolve()));
      lib.store?.setComputerStorePersistenceForTest(null);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      record.finishedAt = new Date().toISOString();
      evidence("record.json", JSON.stringify(record, null, 1));
    }
  });

  // ── 1, 2: the CDP gate ─────────────────────────────────────────────────────────

  it("1. CDP through the gate: the agent browser reads back a page it set", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    const endpoint = await awake.provider.endpoints(awake.handle, { purpose: "cdp" });
    // Docker: the gate on the computer's address. Remote: the host's tunnel, a ticket in a header.
    assert.equal(Boolean(endpoint.cdpHeaders?.["X-Juno-Tunnel-Ticket"]), PROVIDER === "remote");
    const read = await withAgentPage(awake, async (page) => {
      await page.setContent(`<!doctype html><title>e2e-${PROVIDER}</title><p id="p">set through the gate</p>`);
      return { title: await page.title(), text: await page.textContent("#p"), agent: await page.evaluate(() => navigator.userAgent) };
    });
    assert.equal(read.title, `e2e-${PROVIDER}`);
    assert.equal(read.text, "set through the gate");
    assert.match(read.agent, /Chrome\//);
    if (PROVIDER === "docker") {
      // Every docker call of the provider's went through the broker (the shim logs the operation).
      const operations = new Set(readFileSync(path.join(shimDirectory, "calls.log"), "utf8").split("\n").filter(Boolean));
      for (const operation of ["volume", "create", "start", "exec", "inspect"]) assert.ok(operations.has(operation), `the broker saw ${operation}`);
      note("broker", [...operations].sort());
    }
    note("1", { cdpUrl: lib.remoteBrowser.cdpConnectUrl(endpoint).replace(/\d+\.\d+\.\d+\.\d+/, "<ip>"), userAgent: read.agent.replace(/.*(Chrome\/[\d.]+).*/, "$1") });
  });

  it("2. the gate refuses a connection without the token and with a wrong one", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    /** One WebSocket attempt: "open", or the HTTP status that refused it. */
    const attempt = async (headers: Record<string, string>): Promise<string> => {
      const endpoint = await awake.provider.endpoints(awake.handle, { purpose: "cdp" });
      const url = lib.remoteBrowser.cdpConnectUrl(endpoint);
      const ws = new lib.WebSocket(url, { headers: { ...(endpoint.cdpHeaders ?? {}), ...headers }, handshakeTimeout: 20_000 });
      return new Promise<string>((resolve) => {
        ws.once("open", () => {
          ws.close();
          resolve("open");
        });
        ws.once("unexpected-response", (_request: unknown, response: { statusCode?: number; resume: () => void }) => {
          response.resume();
          resolve(String(response.statusCode));
        });
        ws.once("error", (error: Error) => resolve(`error: ${error.message}`));
      });
    };
    const without = await attempt({});
    const wrong = await attempt({ "X-Juno-Cdp-Token": "not-the-token" });
    const right = await attempt({ "X-Juno-Cdp-Token": awake.secrets.cdpToken });
    // The host refuses a tunnel with no CDP token itself (400); the gate refuses a wrong one (403, through the tunnel).
    assert.equal(without, PROVIDER === "remote" ? "400" : "403", "no token");
    assert.equal(wrong, "403", "a wrong token");
    assert.equal(right, "open", "control: the right token opens");
    note("2", { without, wrong, right });
  });

  // ── 3: the display ────────────────────────────────────────────────────────────

  it("3. screenshot and xdotool act on the real display: a click and typed text reach the page", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    const sharp = (await import("sharp")).default;
    const result = await withAgentPage(awake, async (page) => {
      await onlyTab(page);
      await page.setContent(
        `<!doctype html><title>e2e display</title>
         <body style="margin:0;background:#00ff7f">
         <input id="i" autocomplete="off" style="position:absolute;left:100px;top:100px;width:400px;height:60px;font-size:30px;border:2px solid #000;background:#fff">
         <script>window.__clicks=[];document.addEventListener("mousedown",e=>window.__clicks.push({x:e.clientX,y:e.clientY,target:e.target.id||e.target.tagName}),true)</script></body>`,
      );
      await page.bringToFront();
      const m = await page.evaluate(() => ({
        x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
        y: window.screenY + (window.outerHeight - window.innerHeight),
      }));
      // The screenshot is the real display: the page's colour where the viewport is, the input's white inside it.
      const before = await awake.provider.screenshot(awake.handle);
      evidence("3-before.jpg", before.jpeg);
      const { data, info } = await sharp(before.jpeg).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => {
        const at = (Math.round(y) * info.width + Math.round(x)) * info.channels;
        return [data[at]!, data[at + 1]!, data[at + 2]!];
      };
      const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]!) <= 40);
      const green = pixel(m.x + 800, m.y + 400);
      const white = pixel(m.x + 300, m.y + 130);
      assert.ok(near(green, [0, 255, 127]), `the page's colour is on the screen at its viewport: ${green}`);
      assert.ok(near(white, [255, 255, 255]), `the input is on the screen where the page put it: ${white}`);
      // A click on the input at screen coordinates, then typing: both through xdotool on the display.
      await awake.provider.click(awake.handle, { x: m.x + 300, y: m.y + 130 });
      await awake.provider.type(awake.handle, "typed-by-xdotool");
      const value = await waitFor("the typed text in the input", 10, async () => {
        const v = await page.inputValue("#i");
        return v === "typed-by-xdotool" ? v : null;
      });
      const clicks = (await page.evaluate(() => (window as unknown as { __clicks: unknown[] }).__clicks)) as Array<{ x: number; y: number; target: string }>;
      const after = await awake.provider.screenshot(awake.handle);
      evidence("3-after.jpg", after.jpeg);
      return { value, clicks, metrics: m, size: [before.width, before.height], changed: before.sha256 !== after.sha256 };
    });
    assert.equal(result.value, "typed-by-xdotool");
    assert.equal(result.clicks.length, 1, JSON.stringify(result.clicks));
    assert.equal(result.clicks[0]!.target, "i", "the click landed on the input");
    assert.ok(Math.abs(result.clicks[0]!.x - 300) <= 2 && Math.abs(result.clicks[0]!.y - 130) <= 2, JSON.stringify(result.clicks[0]));
    assert.deepEqual(result.size, [1280, 800]);
    assert.ok(result.changed, "the screenshot after typing differs");
    note("3", { click: result.clicks[0], viewportAt: result.metrics });
  });

  // ── 4: the live view ───────────────────────────────────────────────────────────

  it("4. RFB through the relay: the view password authenticates and a wrong one is refused", { timeout: 120_000 * SLACK }, async () => {
    await fresh();
    const watch = await viewSession("watch");
    // Docker: a version 1 token (the relay dials the computer). Remote: version 2, a host ticket sealed inside.
    assert.equal(tokenVersion(watch.token), PROVIDER === "remote" ? 2 : 1);
    const good = await rfbLogin(watch.token, watch.password);
    assert.deepEqual({ ok: good.result.ok, size: good.result.ok ? [good.result.width, good.result.height] : null }, { ok: true, size: [1280, 800] });
    good.session.ws.close();
    // A token opens one connection only.
    await assert.rejects(() => openRfb(watch.token), /the relay answered 40\d/);
    const again = await viewSession("watch");
    assert.equal(again.password, watch.password, "a second viewer shares the running stream");
    const bad = await rfbLogin(again.token, notThePassword(again.password));
    assert.equal(bad.result.ok, false, "a wrong password is refused");
    assert.equal(!bad.result.ok && bad.result.stage, "auth");
    bad.session.ws.close();
    note("4", { version: good.result.version, refused: bad.result });
  });

  // ── 5, 6: lifecycle ───────────────────────────────────────────────────────────

  it("5. pause and unpause: the browser answers again after unpause", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    const browser = lib.remoteBrowser.connectAgentBrowser(awake.handle, awake.secrets, { provider: awake.provider });
    try {
      await browser.withPage((page) => page.setContent("<!doctype html><title>before the pause</title>"));
      await awake.provider.pause(awake.handle);
      assert.equal(await awake.provider.state(awake.handle), "paused");
      await sleep(1000);
      // A wake through the store unpauses it (and hands the gate its token again).
      await wake();
      assert.equal(await awake.provider.state(awake.handle), "running");
      assert.equal(await browser.withPage((page) => page.evaluate(() => 1 + 1)), 2, "the connection held through the pause answers");
      assert.equal(await browser.withPage((page) => page.title()), "before the pause");
    } finally {
      await browser.close();
    }
    assert.equal(await withAgentPage(awake, (page) => page.evaluate(() => document.title)), "before the pause", "a new connection answers too");
    assert.ok(mem.audits.some((a) => a.kind === "woke" && a.agentId === AGENT));
  });

  it("6. cookies and files survive stop and start", { timeout: 180_000 * SLACK }, async () => {
    const awake = await fresh();
    const cookieValue = randomBytes(12).toString("hex");
    const fileValue = `kept-${randomBytes(6).toString("hex")}`;
    await withAgentPage(awake, async (page) => {
      await page.context().addCookies([
        { name: "juno_e2e", value: cookieValue, url: "https://example.test/", expires: Math.floor(Date.now() / 1000) + 86_400 },
      ]);
      const set = await page.context().cookies("https://example.test/");
      assert.ok(set.some((c) => c.name === "juno_e2e" && c.value === cookieValue), "control: the cookie is set");
    });
    await awake.provider.writeFile(awake.handle, "/home/agent/work/e2e/persist.txt", fileValue);
    await lib.store.sleepComputer(USER, AGENT, { reason: "person", actor: "web" });
    assert.equal(await awake.provider.state(awake.handle), "exited");
    assert.equal((await mem.findByAgent(USER, AGENT))?.status, "asleep");
    const again = await wake();
    assert.equal(again.handle.name, awake.handle.name, "the same container, started again");
    assert.equal((await again.provider.readFile(again.handle, "/home/agent/work/e2e/persist.txt")).toString("utf8"), fileValue);
    const cookies = await withAgentPage(again, (page) => page.context().cookies("https://example.test/"));
    assert.ok(
      cookies.some((c) => c.name === "juno_e2e" && c.value === cookieValue),
      `the cookie survived the stop: ${JSON.stringify(cookies.map((c) => c.name))}`,
    );
    assert.ok(mem.audits.some((a) => a.kind === "slept" && a.agentId === AGENT));
  });

  // ── 7, 8: take over ───────────────────────────────────────────────────────────

  it("7. take over freezes the agent's running command and hand back resumes it", { timeout: 180_000 * SLACK }, async () => {
    const awake = await fresh();
    await startTicker(awake);
    const { person } = await takeOver();
    const frozenAt = ticks().length;
    await sleep(2000 * SLACK);
    assert.equal(ticks().length, frozenAt, "the agent's loop wrote while the person had control");
    assert.deepEqual(runningAgentProcesses(), [], "every agent process is stopped");
    assert.equal(await lib.store.computerBlockedReason(USER, AGENT), lib.takeover.TAKEOVER_REFUSAL, "the agent's tools are fenced");
    const refused = await awake.provider.exec(awake.handle, "echo should-not-run", { timeoutSeconds: 20 });
    assert.equal(refused.exitCode, 75, "a new agent command is refused while frozen");
    assert.ok(!refused.stdout.includes("should-not-run"));

    const handedBackAt = Date.now();
    await handBack();
    const closedAt = await Promise.race([person.closed, sleep(20_000 * SLACK).then(() => 0)]);
    assert.ok(closedAt > 0, "hand back ended the person's VNC session");
    await waitFor("the loop to resume", 10, async () => ticks().length > frozenAt + 2);
    const resumedAt = ticks()[frozenAt]!;
    assert.ok(closedAt <= resumedAt, `the person's session ended (${closedAt}) before the agent resumed (${resumedAt})`);
    const audits = mem.audits.filter((a) => a.agentId === AGENT).map((a) => a.kind);
    assert.ok(audits.includes("takeover_started") && audits.includes("takeover_handed_back"), audits.join(","));
    note("7", { closedAfterHandBackMs: closedAt - handedBackAt, resumedAfterCloseMs: resumedAt - closedAt });
  });

  it("8. a lapsed take over ends the person's session, rotates the VNC password, then thaws", { timeout: 180_000 * SLACK }, async () => {
    const awake = await fresh();
    await startTicker(awake);
    const { person, password } = await takeOver();
    const frozenAt = ticks().length;
    const row = await mem.findByAgent(USER, AGENT);
    assert.ok(row?.takeoverUntil, "a take over window is open");
    // The runner's tick, at a moment past the window (nobody sent a heartbeat).
    const settled = await lib.store.settleLapsedTakeovers(new Date(row.takeoverUntil.getTime() + 1000));
    assert.equal(settled, 1);
    const closedAt = await Promise.race([person.closed, sleep(20_000 * SLACK).then(() => 0)]);
    assert.ok(closedAt > 0, "the lapse ended the person's VNC session");
    await waitFor("the loop to resume", 10, async () => ticks().length > frozenAt + 2);
    const resumedAt = ticks()[frozenAt]!;
    assert.ok(closedAt <= resumedAt, `the session ended (${closedAt}) before the agent resumed (${resumedAt})`);
    const after = await mem.findByAgent(USER, AGENT);
    assert.equal(after?.takeoverBy ?? null, null, "the window is closed");
    const rotated = lib.store.decodeSecrets(after!.secrets).vncControlPassword;
    assert.ok(rotated && rotated !== password, "the control password rotated");
    // The old control password no longer logs in; the stream itself is up (a viewer gets in).
    const watch = await viewSession("watch");
    const old = await rfbLogin(watch.token, password);
    assert.equal(old.result.ok, false, "the lapsed control password is refused");
    old.session.ws.close();
    const viewer = await rfbLogin((await viewSession("watch")).token, lib.store.decodeSecrets((await mem.findByAgent(USER, AGENT))!.secrets).vncViewPassword!);
    assert.equal(viewer.result.ok, true, "control: the current view password works");
    viewer.session.ws.close();
    assert.ok(mem.audits.some((a) => a.agentId === AGENT && a.kind === "takeover_lapsed"));
    note("8", { resumedAfterCloseMs: resumedAt - closedAt });
  });

  // ── 11, 12, 13 ────────────────────────────────────────────────────────────────

  it("11. a CDP reply over 1 MiB arrives intact", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    const size = 2 * 1024 * 1024;
    const outcome = await withAgentPage(awake, async (page) => {
      const reply = await page.evaluate((n) => {
        let text = "";
        for (let i = 0; text.length < n; i++) text += `${i % 10}`.repeat(1024);
        return text.slice(0, n);
      }, size);
      // And the other way: a 2 MiB argument from the client to the page.
      const sent = "q".repeat(size);
      const echoed = await page.evaluate((s) => s.length, sent);
      return { length: reply.length, sha: createHash("sha256").update(reply).digest("hex"), echoed };
    });
    let expected = "";
    for (let i = 0; expected.length < size; i++) expected += `${i % 10}`.repeat(1024);
    assert.equal(outcome.length, size);
    assert.equal(outcome.sha, createHash("sha256").update(expected.slice(0, size)).digest("hex"));
    assert.equal(outcome.echoed, size);
  });

  it("12. take over holds against a fork loop and a racing command, releases a held modifier, and a resumed typer cannot type", { timeout: 300_000 * SLACK }, async () => {
    // (a) A fork loop: after the take over no agent task runs, for 2 s.
    let awake = await fresh();
    await awake.provider.exec(awake.handle, "setsid nohup sh -c 'while true; do (sleep 0.05 &) ; done' >/dev/null 2>&1 &", { timeoutSeconds: 20 });
    await sleep(1000);
    let held = await takeOver();
    for (let i = 0; i < 10 * SLACK; i++) {
      assert.deepEqual(runningAgentProcesses(), [], "a forked task ran during the take over");
      await sleep(200);
    }
    await handBack();
    held.person.ws.close();

    // (b) A command racing the take over: one started before it is stopped, one after it is refused (75).
    awake = await fresh();
    const exec = (command: string) =>
      awake.provider.exec(awake.handle, command, { timeoutSeconds: 120 }).then(
        (res) => ({ code: res.exitCode, at: Date.now() }),
        (error: unknown) => ({ code: -1, at: Date.now(), error: String(error) }),
      );
    const early = [exec("sleep 90 && touch /home/agent/work/e2e/raced-early"), exec("sleep 90 && touch /home/agent/work/e2e/raced-early")];
    await waitFor("the early commands to run", 10, async () => agentProcesses().filter((p) => p.args.includes("sleep 90")).length >= 2);
    const racing = exec("sleep 90 && touch /home/agent/work/e2e/raced");
    held = await takeOver();
    const tookAt = Date.now();
    const late = await exec("touch /home/agent/work/e2e/raced-late");
    assert.equal(late.code, 75, "a command after the take over is refused");
    assert.deepEqual(runningAgentProcesses(), [], "a command that raced the take over runs unfrozen");
    const stopped = agentProcesses().filter((p) => p.args.includes("sleep 90"));
    assert.ok(stopped.length >= 2 && stopped.every(frozen), `control: the early commands are stopped: ${JSON.stringify(stopped)}`);
    await handBack();
    held.person.ws.close();
    // The early ones resume at hand back; end them before their write.
    await awake.provider.exec(awake.handle, "pkill -u agent -x sleep; true", { timeoutSeconds: 20 });
    const settled = await Promise.all([...early, racing]);
    assert.ok(settled.every((s) => s.code === 75 || s.at > tookAt), `nothing finished during the take over: ${JSON.stringify(settled)}`);
    assert.equal(observe(["sh", "-c", "ls /home/agent/work/e2e/ | grep -c raced || true"]).trim(), "0", "no racer wrote");

    // (c) A held modifier and button are released for the person.
    awake = await fresh();
    const probe = () =>
      JSON.parse(observe(["python3", "-I", "-c", HELD_INPUT_PROBE], { display: true })) as Record<string, boolean>;
    const down = await awake.provider.exec(awake.handle, "xdotool keydown Control_L keydown a mousedown 1", { timeoutSeconds: 20 });
    assert.equal(down.exitCode, 0, down.stderr);
    assert.deepEqual(probe(), { Control_L: true, a: true, button1: true }, "control: the X server reports them held");
    held = await takeOver();
    assert.deepEqual(probe(), { Control_L: false, a: false, button1: false }, "a key or button stayed held for the person");
    await handBack();
    held.person.ws.close();

    // (d) A typer resumed at hand back cannot type, also a renamed copy of xdotool.
    awake = await fresh();
    await awake.provider.exec(awake.handle, "mkdir -p /home/agent/work/e2e && cp /usr/bin/xdotool /home/agent/work/e2e/t", { timeoutSeconds: 20 });
    const browser = lib.remoteBrowser.connectAgentBrowser(awake.handle, awake.secrets, { provider: awake.provider });
    const typerNotes: Record<string, number> = {};
    try {
      for (const typer of ["xdotool", "/home/agent/work/e2e/t"]) {
        await browser.withPage(async (page) => {
          await onlyTab(page);
          await page.setContent("<!doctype html><title>typer</title><input id=i autofocus style='width:90%'>");
          await page.bringToFront();
          await page.focus("#i");
        });
        const typed = () => browser.withPage((page) => page.inputValue("#i")).then((v) => v.length);
        await awake.provider.exec(awake.handle, `setsid nohup ${typer} type --delay 200 ${"a".repeat(120)} >/dev/null 2>&1 &`, { timeoutSeconds: 20 });
        await waitFor(`${typer} to reach the page`, 15, async () => (await typed()) >= 3);
        held = await takeOver();
        const atFreeze = await typed();
        await handBack();
        held.person.ws.close();
        await sleep(3000 * SLACK);
        assert.equal(await typed(), atFreeze, `${typer} typed after the person took control`);
        assert.ok(!agentProcesses().some((p) => p.args.includes(`${typer} type`)), `${typer} exited when it was resumed`);
        typerNotes[typer] = atFreeze;
      }
    } finally {
      await browser.close();
    }
    note("12", { typedBeforeTheFreeze: typerNotes });
  });

  it("13. the agent's shell cannot create a user namespace", { timeout: 120_000 * SLACK }, async () => {
    const awake = await fresh();
    const res = await awake.provider.exec(awake.handle, `python3 -c '${NAMESPACE_PROBE.replace(/'/g, "'\\''")}'`, { timeoutSeconds: 60 });
    assert.equal(res.exitCode, 0, res.stderr);
    const report = JSON.parse(res.stdout) as Record<string, string>;
    for (const call of ["unshare -Ur", "unshare -n", "clone(CLONE_NEWUSER)", "clone(CLONE_NEWNET)", "unshare(CLONE_NEWUSER)", "setns"]) {
      assert.equal(report[call], "EPERM", `${call}: ${report[call]}`);
    }
    assert.equal(report.clone3, "ENOSYS");
    const sandbox = await awake.provider.browserSandbox(awake.handle);
    assert.equal(sandbox, fixture.sandbox ? "on" : "off", `the sandbox state is what the fixture decided (${fixture.sandboxReason})`);
    let namespaces: { gate: string; renderers: string[] } | null = null;
    if (sandbox === "on") {
      await withAgentPage(awake, (page) => page.setContent("<p>renderer</p>"));
      const [gate, ...renderers] = observe(["python3", "-c", RENDERER_NAMESPACES]).trim().split(/\s+/);
      namespaces = { gate: gate!, renderers };
      assert.ok(renderers.length > 0, "a renderer is running");
      assert.ok(!renderers.includes(gate!), "with the sandbox on, renderers run in their own user namespace");
    }
    note("13", { sandbox, namespaces });
  });

  // ── 9: a Work run ───────────────────────────────────────────────────────────────

  it("9. a scripted agent-core loop uses the shell, files and the browser on the real computer", { timeout: 300_000 * SLACK }, async () => {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/computer-e2e-script.json"), "utf8")) as Record<string, unknown>;
    const allowedScript = lib.runtime.parseScriptedWorkScript(scripts.allowed);
    const askScript = lib.runtime.parseScriptedWorkScript(scripts.ask);
    const formPage = "data:text/html," + encodeURIComponent(
      "<!doctype html><title>Juno e2e form</title><h1>Order</h1><p>juno-e2e-marker</p><label for=name>Name</label><input id=name name=name>",
    );
    const placeForm = (awake: Awake) =>
      withAgentPage(awake, async (page) => {
        await onlyTab(page);
        await page.goto(formPage);
      });

    // Run A: policy "allowed", the computer awake. The page the agent reads is put in place by the
    // test first (the agent never navigates: data: URLs are refused to it). The shell still asks.
    mem.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: "allowed" });
    await placeForm(await fresh());
    const runA = await scriptedRun({ script: allowedScript, runId: `run_${AGENT}_a` });
    const transcriptA = JSON.stringify({ said: runA.said, results: runA.results.map((r) => ({ ...r, output: r.output.slice(0, 300) })) });
    assert.deepEqual(runA.failures, [], `every tool call succeeded: ${transcriptA}`);
    assert.ok(runA.said.some((text) => text.startsWith("Done: a file from the shell")), `the run finished: ${transcriptA}`);
    assert.ok(!runA.approvals.some((a) => a.action === "work.computer.start"), "no start card under allowed");
    const shellCard = runA.approvals.find((a) => a.action === "work.computer.shell");
    assert.ok(shellCard, `the shell asked: ${runA.approvals.map((a) => a.action).join(",")}`);
    assert.equal(shellCard.risk, "sensitive");
    const after = await wake();
    assert.equal((await after.provider.readFile(after.handle, "/home/agent/work/e2e-run/shell.txt")).toString(), "from-the-shell");
    assert.equal((await after.provider.readFile(after.handle, "/home/agent/work/e2e-run/note.txt")).toString(), "written-by-the-files-tool");
    assert.equal(await withAgentPage(after, (page) => page.inputValue("#name")), "typed by the agent", "the browser tool typed into the computer's page");
    assert.ok(mem.audits.some((a) => a.agentId === AGENT && a.kind === "started" && a.detail.by === "run"));

    // Run B: policy "ask", the computer asleep. Browsing first uses the temporary browser, asks nothing
    // and starts nothing; the first computer call raises the start card, and its approval starts the
    // computer (the agent starting its own computer); the repeated call asks for the shell itself;
    // once the computer is on, `browser` is the computer's.
    mem.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: "ask" });
    await lib.store.sleepComputer(USER, AGENT, { reason: "person", actor: "web" });
    const stateAtStartCard: string[] = [];
    const runB = await scriptedRun({
      script: askScript,
      runId: `run_${AGENT}_b`,
      beforeAnswer: async (request) => {
        if (request.action === "work.computer.start") stateAtStartCard.push(await after.provider.state(after.handle));
        // By the shell's own card the approved start has woken the computer: the page goes back in place
        // (a stop and start leaves Chromium on about:blank).
        if (request.action === "work.computer.shell") await placeForm(await wake());
      },
    });
    assert.deepEqual(stateAtStartCard, ["exited"], "browsing did not start the computer; it was still asleep at the start card");
    const transcriptB = JSON.stringify({ said: runB.said, results: runB.results.map((r) => ({ ...r, output: r.output.slice(0, 300) })) });
    assert.ok(runB.said.some((text) => text.startsWith("Done: the computer started")), `the run finished: ${transcriptB}`);
    assert.deepEqual(runB.approvals.map((a) => a.action), ["work.computer.start", "work.computer.shell"]);
    assert.equal(runB.approvals[0]!.summary, "Start Mira’s computer");
    assert.deepEqual(runB.temporaryLog, ["temporary:read"], "only the first read used the temporary browser");
    assert.ok(mem.audits.some((a) => a.agentId === AGENT && a.kind === "woke" && a.detail.by === "run"), "the run woke the computer");
    mem.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: "allowed" });
    note("9", { approvalsA: runA.approvals.map((a) => `${a.action}:${a.risk}`), approvalsB: runB.approvals.map((a) => `${a.action}:${a.risk}`) });
  });

  // ── 14: losing the host ─────────────────────────────────────────────────────────

  it("14. losing the host mid-run: unreachable, nothing recreated or reaped, no awake time, then it works again", {
    timeout: 300_000 * SLACK,
    skip: PROVIDER === "remote" ? false : "remote only: the docker provider has no separate host",
  }, async () => {
    await fresh();
    const containerId = docker("inspect", "-f", "{{.Id}}", NAME);
    const containerRef = (await mem.findByAgent(USER, AGENT))?.containerRef;
    const outage: Record<string, unknown> = {};
    const script: ScriptedWorkScript = {
      version: 1,
      vision: false,
      steps: [
        { call: { name: "computer_shell", input: { command: "echo before-the-outage", timeoutSeconds: 30 } } },
        { expect: "before-the-outage", call: { name: "computer_shell", input: { command: "echo during-the-outage", timeoutSeconds: 30 } } },
        { expect: "could not reach the agent's computer right now", call: { name: "computer_shell", input: { command: "echo after-the-outage", timeoutSeconds: 30 } } },
        { expect: "after-the-outage", say: "Done after the outage.", end: true },
      ],
    };
    let shellCards = 0;
    const run = await scriptedRun({
      script,
      runId: `run_${AGENT}_outage`,
      beforeAnswer: async (request) => {
        if (request.action !== "work.computer.shell") return;
        shellCards += 1;
        if (shellCards === 2) {
          // The host service stops while the run is between two calls.
          const contact = await lib.sweep.sweepAgentComputers();
          assert.deepEqual(contact.skipped, [], "control: the host answers before the outage");
          outage.usageBefore = await lib.store.computerWeekUsageSeconds(USER);
          outage.stoppedAt = Date.now();
          fixtureCommand("host-service", "stop");
          lib.access.resetComputerAvailabilityCacheForTest();
          await sleep(15_000 * SLACK);
          const during = await lib.sweep.sweepAgentComputers();
          outage.during = during;
          assert.ok(during.skipped.includes(AGENT), `the sweep could not reach it: ${JSON.stringify(during)}`);
          assert.deepEqual(during.reapedOrphans, [], "nothing is reaped while the host is gone");
          const row = await mem.findByAgent(USER, AGENT);
          assert.equal(row?.lastResumedAt ?? null, null, "nothing accrues during the outage");
          assert.equal(row?.status, "awake", "never marked as an error or asleep");
          assert.equal(row?.containerRef, containerRef, "not recreated");
        }
        if (shellCards === 3) {
          fixtureCommand("host-service", "start");
          lib.access.resetComputerAvailabilityCacheForTest();
          const back = await lib.sweep.sweepAgentComputers();
          outage.back = back;
          outage.backAt = Date.now();
          assert.deepEqual(back.skipped, [], "the first sweep afterwards reaches it");
        }
      },
    });
    assert.deepEqual(run.failures.map((f) => f.tool), ["computer_shell"], "only the call during the outage failed");
    assert.match(run.failures[0]!.output, /could not reach the agent's computer right now/);
    assert.ok(run.said.includes("Done after the outage."), run.said.join(" | "));
    assert.equal(docker("inspect", "-f", "{{.Id}}", NAME), containerId, "the same container throughout");
    const minutes = mem.audits.filter((a) => a.agentId === AGENT && a.kind === "host_reachable");
    assert.equal(mem.audits.filter((a) => a.agentId === AGENT && a.kind === "host_unreachable").length, 1);
    assert.equal(minutes.length, 1);
    const usageAfter = await lib.store.computerWeekUsageSeconds(USER);
    const outageSeconds = ((outage.backAt as number) - (outage.stoppedAt as number)) / 1000;
    const metered = usageAfter - (outage.usageBefore as number);
    assert.ok(metered < outageSeconds / 2, `the outage (${outageSeconds.toFixed(1)} s) was not metered: ${metered} s`);
    note("14", { outageSeconds, meteredSecondsAcrossIt: metered });
  });

  // ── 10: an image rebuild (last: it changes the image) ──────────────────────────

  it("10. an outdated container is rebuilt on its volumes at the next wake", { timeout: 300_000 * SLACK }, async () => {
    const awake = await fresh();
    const marker = `before-the-rebuild-${randomBytes(4).toString("hex")}`;
    await awake.provider.writeFile(awake.handle, "/home/agent/work/e2e/rebuild.txt", marker);
    await lib.store.sleepComputer(USER, AGENT, { reason: "person", actor: "web" });
    const tag = PROVIDER === "docker" ? DOCKER_TAG : "juno-computer:1";
    const base = `juno-computer-e2e-base:${PROVIDER}`;
    const build = path.join(ROOT, ".e2e-rebuild-" + randomBytes(4).toString("hex"));
    let rebuilt = "";
    try {
      // A rebuild under the same tag and label with one changed file: a new image id, as a Chromium security rebuild would be.
      docker("tag", originalImageId, base);
      mkdirSync(build);
      writeFileSync(path.join(build, "rebuilt"), randomBytes(8).toString("hex"));
      writeFileSync(path.join(build, "Dockerfile"), `FROM ${base}\nCOPY rebuilt /opt/juno/rebuilt\n`);
      docker("build", "-q", "-t", tag, build);
      rebuilt = docker("image", "inspect", "--format", "{{.Id}}", tag);
      assert.notEqual(rebuilt, originalImageId);
      assert.equal(docker("image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', tag), "pipe-v4", "the same label");
      assert.equal(await awake.provider.isOutdated(awake.handle), true, "the container is outdated");
      const woken = await wake();
      assert.equal(docker("inspect", "-f", "{{.Image}}", NAME), rebuilt, "recreated from the rebuilt image");
      assert.equal(await woken.provider.isOutdated(woken.handle), false);
      assert.equal((await woken.provider.readFile(woken.handle, "/home/agent/work/e2e/rebuild.txt")).toString(), marker, "on its volumes");
      assert.ok(mem.audits.some((a) => a.agentId === AGENT && a.kind === "rebuilt"));
      assert.equal(await withAgentPage(woken, (page) => page.evaluate(() => 6 * 7)), 42, "its browser answers");
    } finally {
      spawnSync("rm", ["-rf", build]);
      // The tag goes back to the image it was; the rebuilt image goes with this suite's container (after()).
      docker("tag", originalImageId, tag);
      dockerQuiet("image", "rm", base);
      if (rebuilt) {
        const provider = lib.providerModule.computerProvider();
        const row = await mem.findByAgent(USER, AGENT);
        if (provider && row?.containerRef) await provider.destroy(lib.store.decodeHandle(row.containerRef, AGENT), { removeVolume: true }).catch(() => undefined);
        dockerQuiet("rm", "-f", NAME);
        dockerQuiet("image", "rm", rebuilt);
      }
    }
  });
});

// ── The scripted run (test 9 and 14) ─────────────────────────────────────────────

interface ScriptedRunResult {
  approvals: WorkApprovalRequest[];
  events: WorkEmittedEvent[];
  said: string[];
  failures: Array<{ tool: string; output: string }>;
  results: Array<{ tool: string; output: string; isError: boolean }>;
  temporaryLog: string[];
}

/**
 * The Work runner's computer wiring (scripts/work-runner.ts buildTools and the
 * attach), in miniature: the store's lazy plan, the holder, the start gate, the
 * computer tools over the real provider, and the `browser` tool switching between
 * a temporary browser (a recording stand-in here) and the computer's own browser
 * (the product's agent browser over CDP, behind the take-over guard). Approvals are
 * answered "allowed" by the test.
 */
async function scriptedRun(opts: {
  script: ScriptedWorkScript;
  runId: string;
  beforeAnswer?: (request: WorkApprovalRequest) => Promise<void>;
}): Promise<ScriptedRunResult> {
  const { runtime, store, runTools } = lib;
  const plan = await store.prepareRunComputer({ userId: USER, agentId: AGENT, runId: opts.runId, attended: true, vision: opts.script.vision });
  assert.equal(plan.kind, "lazy", "the run may use the computer");
  if (plan.kind !== "lazy") throw new Error("unreachable");
  const rows: Array<{ action: string; decision: string }> = [];
  const lazy = runTools.createLazyRunComputer({
    plan,
    userId: USER,
    runId: opts.runId,
    connectBrowser: (attachment) =>
      lib.takeover.guardBrowserForTakeover(
        lib.remoteBrowser.connectAgentBrowser(attachment.handle, attachment.secrets, {
          provider: attachment.provider,
          navigationRefusal: (url) => {
            const blocked = runtime.blockedFetchTarget(url);
            return blocked ? `Alevr will not open that: ${blocked}` : null;
          },
        }),
        () => store.computerTakeoverFence(USER, AGENT, new Date(), opts.runId),
      ),
    readStartApproval: async () =>
      runTools.startApprovalStateOf([...rows].reverse().find((row) => row.action === "work.computer.start")?.decision ?? null),
  });
  await lazy.refresh();
  const attached = () => {
    const attachment = lazy.attachment();
    if (!attachment) throw new Error("The computer is not started.");
    return attachment;
  };
  // agent-core's computer tools take bytes since S5 (binary-safe files) and text before it.
  const bytesApi = readFileSync(path.join(ROOT, "runner/agent-core/dist/work/computer-tools.js"), "utf8").includes("decodeTextFile");
  let epoch = 0;
  const shot = async () => {
    const s = await attached().provider.screenshot(attached().handle);
    return { mediaType: "image/jpeg" as const, data: s.jpeg.toString("base64"), width: s.width, height: s.height, hash: s.sha256 };
  };
  const computerDeps = {
    isHealthy: () => true,
    blockedReason: () => store.computerBlockedReason(USER, AGENT, new Date(), opts.runId),
    takeoverEpoch: async () => (await store.computerTakeoverFence(USER, AGENT)).epoch,
    pageTakesPayment: () => false,
    currentUrl: () => "",
    screenEpoch: () => epoch,
    screenshot: shot,
    click: async (o: { x: number; y: number; button?: "left" | "right" | "double" }) => (await attached().provider.click(attached().handle, o), shot()),
    type: async (text: string) => (await attached().provider.type(attached().handle, text), shot()),
    key: async (keys: string) => (await attached().provider.key(attached().handle, keys), shot()),
    scroll: async (o: { x: number; y: number; direction: string; amount: number }) =>
      (await attached().provider.scroll(attached().handle, { x: o.x, y: o.y, dy: o.direction === "up" ? -o.amount : o.amount }), shot()),
    exec: async (command: string, o: { timeoutSeconds: number; cwd?: string }) => {
      const res = await runTools.runComputerShell(attached().provider, attached().handle, command, o);
      epoch += 1;
      return res;
    },
    listFiles: (dir: string) => attached().provider.listFiles(attached().handle, dir),
    readFile: async (p: string, max: number) => {
      const bytes = await attached().provider.readFile(attached().handle, p, { maxBytes: max });
      return bytesApi ? bytes : bytes.toString("utf8");
    },
    writeFile: async (p: string, content: string | Uint8Array) => {
      await attached().provider.writeFile(attached().handle, p, typeof content === "string" ? content : Buffer.from(content));
      epoch += 1;
    },
    settle: false,
  };
  const tools = runtime
    .computerTools(computerDeps as unknown as Parameters<Runtime["computerTools"]>[0])
    .filter((tool) => runTools.computerToolNamesFor({ vision: opts.script.vision }).includes(tool.spec.name))
    .map((tool) => runtime.withComputerStart(tool, lazy.gate));

  const temporaryLog: string[] = [];
  const temporaryPage = { url: "https://temporary.example/", title: "temporary-browser-page", html: "<p>temporary-browser-page</p>", elements: [] };
  const temporary = {
    available: () => true,
    open: async () => (temporaryLog.push("temporary:open"), { ok: true as const, page: temporaryPage }),
    read: async () => (temporaryLog.push("temporary:read"), { ok: true as const, page: temporaryPage }),
    click: async () => (temporaryLog.push("temporary:click"), { ok: true as const, page: temporaryPage }),
    typeText: async () => (temporaryLog.push("temporary:type"), { ok: true as const, page: temporaryPage }),
    submit: async () => (temporaryLog.push("temporary:submit"), { ok: true as const, page: temporaryPage }),
    currentUrl: () => temporaryPage.url,
    submitMethod: () => null,
    pageTakesPayment: () => false,
    close: async () => undefined,
  };
  const browserSwitch = runTools.createRunBrowserSwitch({ lazy: lazy as never, temporary: () => temporary as never });
  const browser = browserSwitch.browser as unknown as import("@/lib/work/browser").WorkBrowser;
  const browserTool = runTools.withBrowserNotice(
    runtime.browserTool({
      available: () => browser.available(),
      open: (url) => browser.open(url) as never,
      read: () => browser.read() as never,
      click: (target) => browser.click(target) as never,
      typeText: (target, text) => browser.typeText(target, text) as never,
      submit: (target) => browser.submit(target) as never,
      currentUrl: () => browser.currentUrl(),
      submitMethod: (target) => browser.submitMethod(target),
      pageTakesPayment: () => browser.pageTakesPayment(),
      allowedDomains: () => null,
      screenEpoch: () => epoch,
    }),
    () => browserSwitch.takeNotice(),
  );

  // What each call returned (or threw), as the model was told.
  const results: Array<{ tool: string; output: string; isError: boolean }> = [];
  type Tool = (typeof tools)[number];
  const recorded = (tool: Tool): Tool => ({
    ...tool,
    async execute(input, ctx) {
      try {
        const result = await tool.execute(input, ctx);
        results.push({ tool: tool.spec.name, output: result.output, isError: Boolean(result.isError) });
        return result;
      } catch (error) {
        results.push({ tool: tool.spec.name, output: error instanceof Error ? error.message : String(error), isError: true });
        throw error;
      }
    },
  });

  const approvals: WorkApprovalRequest[] = [];
  const events: WorkEmittedEvent[] = [];
  const session = new runtime.WorkAgentSession({
    runId: opts.runId,
    goal: "Use your computer: the shell, the files and the browser.",
    provider: runtime.createScriptedWorkProvider(opts.script),
    model: "scripted-work-model",
    cwd: "/tmp",
    tools: [recorded(browserTool as Tool), ...tools.map(recorded)],
    plan: new runtime.WorkPlan([{ id: "step_1", title: "Work" }]),
    budget: runtime.NO_BUDGET,
    approvalMode: "permissive",
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals.push(request);
        const row = { action: request.action, decision: "pending" };
        rows.push(row);
        await opts.beforeAnswer?.(request);
        row.decision = "allowed";
        return "allowed";
      },
      askQuestion: async () => "ok",
    },
  });
  try {
    await session.run();
  } finally {
    await browserSwitch.close();
    await lazy.dispose();
  }
  return {
    approvals,
    events,
    said: events.flatMap((e) => (e.kind === "assistant_message" ? [e.text] : [])),
    failures: results.filter((r) => r.isError).map(({ tool, output }) => ({ tool, output })),
    results,
    temporaryLog,
  };
}

/**
 * The real broker with only its two fixed paths pointed at this run's files (the
 * policy, and the egress map helper's map), as tests/test_computer_boundary.py runs it.
 * No single quote inside: it is passed to `python3 -c '...'` by the PATH shim.
 */
const BROKER_SHIM = [
  "import importlib.util, sys",
  "spec = importlib.util.spec_from_file_location(\"broker\", sys.argv[1])",
  "broker = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(broker)",
  "broker.CONFIG = sys.argv[2]",
  "broker.EGRESS_MAP_HELPER = [sys.executable, \"-I\", sys.argv[3]]",
  "broker.EGRESS_MAP_ENV = {\"PATH\": \"/usr/bin:/bin\", \"HOME\": \"/root\", \"JUNO_EGRESS_MAP\": sys.argv[4]}",
  "sys.argv = [\"juno-computer-docker-broker\"] + sys.argv[5:]",
  "sys.exit(broker.run_cli())",
].join("\n");

// ── Probes that run inside the computer ───────────────────────────────────────────

/** As the agent (through the launcher): every way into a new namespace, as errno names. */
const NAMESPACE_PROBE = String.raw`
import ctypes, errno, json, subprocess
libc = ctypes.CDLL(None, use_errno=True)
def call(*args):
    result = libc.syscall(*args)
    return "ok" if result >= 0 else errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
def run(*argv):
    done = subprocess.run(list(argv), capture_output=True, text=True)
    return "ok" if done.returncode == 0 else ("EPERM" if "Operation not permitted" in done.stderr else "failed:" + done.stderr[-120:])
SIGCHLD = 17
print(json.dumps({
    "unshare -Ur": run("unshare", "-Ur", "true"),
    "unshare -n": run("unshare", "-n", "true"),
    "clone(CLONE_NEWUSER)": call(56, 0x10000000 | SIGCHLD, 0, 0, 0, 0),
    "clone(CLONE_NEWNET)": call(56, 0x40000000 | SIGCHLD, 0, 0, 0, 0),
    "unshare(CLONE_NEWUSER)": call(272, 0x10000000),
    "setns": call(308, 0, 0x10000000),
    "clone3": call(435, 0, 0),
}))
`;

/** As the browser uid: this exec's user namespace (the gate's), then every renderer's. */
const RENDERER_NAMESPACES = String.raw`
import os, subprocess
def ns(p):
    try:
        return os.readlink("/proc/%s/ns/user" % p)
    except OSError:
        return None
rend = subprocess.run(["pgrep", "-u", "1001", "-f", "chrome.*--type=renderer"], capture_output=True, text=True).stdout.split()
seen = {ns(p) for p in rend if p != str(os.getpid())} - {None}
print(ns("self"), " ".join(sorted(seen)))
`;

/** As the browser uid: every uid-1000 process as "pid<TAB>state<TAB>args" (see agentProcesses). */
const AGENT_PROCESSES_PROBE = String.raw`
import os
STOP = 1 << 18
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        with open("/proc/%s/status" % pid) as file:
            status = dict(line.split(":", 1) for line in file if ":" in line)
        if int(status["Uid"].split()[0]) != 1000:
            continue
        state = status["State"].split()[0]
        pending = int(status.get("SigPnd", "0").strip(), 16) | int(status.get("ShdPnd", "0").strip(), 16)
        with open("/proc/%s/cmdline" % pid, "rb") as file:
            args = file.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except (OSError, KeyError, ValueError):
        continue
    print("%s\t%s\t%s" % (pid, "Tp" if state == "D" and pending & STOP else state, args))
`;

/** As the browser uid with python3-xlib: which keys and buttons the X server holds down. */
const HELD_INPUT_PROBE = String.raw`
import json
from Xlib import display, X, XK
d = display.Display(":0")
keymap = d.query_keymap()
def down(name):
    code = d.keysym_to_keycode(XK.string_to_keysym(name))
    return bool(code) and bool(keymap[code // 8] & (1 << (code % 8)))
pointer = d.screen().root.query_pointer()
print(json.dumps({"Control_L": down("Control_L"), "a": down("a"), "button1": bool(pointer.mask & X.Button1Mask)}))
`;
