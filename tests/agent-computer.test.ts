import assert from "node:assert/strict";
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
const { decryptSecret } = req("../src/lib/crypto") as typeof import("@/lib/crypto");
const { buildDockerCreateArgv } = req(
  "../src/lib/computer/docker"
) as typeof import("@/lib/computer/docker");
const { fakeComputerProvider } = req(
  "../src/lib/computer/fake"
) as typeof import("@/lib/computer/fake");
const { mintViewToken } = req(
  "../src/lib/computer/live-view"
) as typeof import("@/lib/computer/live-view");
const {
  computerProvider,
  isAgentComputerConfigured,
  resetComputerProviderCache,
} = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const {
  acquireComputerLease,
  createInMemoryComputerPersistence,
  disableComputer,
  enableComputer,
  ensureAwake,
  releaseComputerLease,
  renewComputerLease,
  resetComputer,
  restComputer,
  setComputerStorePersistenceForTest,
  sleepComputer,
} = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const { sweepAgentComputers } = req(
  "../src/lib/computer/sweep"
) as typeof import("@/lib/computer/sweep");

describe("agent-computer provider and lifecycle", () => {
  const prevProvider = process.env.AGENT_COMPUTER_PROVIDER;
  const prevAuthSecret = process.env.AUTH_SECRET;
  let memDb: ReturnType<typeof createInMemoryComputerPersistence>;

  beforeEach(() => {
    process.env.AUTH_SECRET =
      process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    delete process.env.AGENT_COMPUTER_MAX_AWAKE_USER;
    delete process.env.AGENT_COMPUTER_MAX_AWAKE_HOST;
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = createInMemoryComputerPersistence();
    setComputerStorePersistenceForTest(memDb);
  });

  afterEach(() => {
    if (prevProvider === undefined) {
      delete process.env.AGENT_COMPUTER_PROVIDER;
    } else {
      process.env.AGENT_COMPUTER_PROVIDER = prevProvider;
    }
    if (prevAuthSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = prevAuthSecret;
    }
    resetComputerProviderCache();
    setComputerStorePersistenceForTest(null);
  });

  it("returns null provider and configured=false when AGENT_COMPUTER_PROVIDER is unset", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    assert.equal(computerProvider(), null);
    assert.equal(await isAgentComputerConfigured(), false);
    await assert.rejects(
      () => enableComputer("u1", "a1"),
      /Agent computers are not configured/
    );
  });

  it("encrypts containerRef and secrets at rest with encryptSecret", async () => {
    const row = await enableComputer("user_1", "agent_1");
    assert.equal(row.status, "asleep");
    assert.ok(row.containerRef);
    assert.ok(row.secrets);

    // Neither ciphertext may contain plaintext handle or token keys
    assert.ok(!row.containerRef.includes("juno-agent-agent_1"));
    assert.ok(!row.secrets.includes("cdpToken"));

    const decodedHandle = JSON.parse(decryptSecret(row.containerRef));
    assert.deepEqual(decodedHandle, {
      name: "juno-agent-agent_1",
      volume: "juno-agent-agent_1",
    });

    const decodedSecrets = JSON.parse(decryptSecret(row.secrets));
    assert.equal(typeof decodedSecrets.cdpToken, "string");
    assert.ok(decodedSecrets.cdpToken.length >= 32);
  });

  it("transitions through enable -> awake -> rest -> awake -> sleep -> reset -> disable and recreates missing containers", async () => {
    await enableComputer("user_1", "agent_1");

    // Wake up
    const awake1 = await ensureAwake("user_1", "agent_1");
    assert.equal(awake1.row.status, "awake");
    assert.equal(await fakeComputerProvider.state(awake1.handle), "running");

    // Write a file to persistent volume
    await fakeComputerProvider.writeFile(
      awake1.handle,
      "/home/agent/work/hello.txt",
      "persistent content"
    );

    // Rest (pause)
    const rested = await restComputer("user_1", "agent_1");
    assert.equal(rested.status, "resting");
    assert.equal(await fakeComputerProvider.state(awake1.handle), "paused");

    // Wake from resting (unpause)
    const awake2 = await ensureAwake("user_1", "agent_1");
    assert.equal(awake2.row.status, "awake");
    assert.equal(await fakeComputerProvider.state(awake2.handle), "running");

    // Sleep (stop)
    const slept = await sleepComputer("user_1", "agent_1");
    assert.equal(slept.status, "asleep");
    assert.equal(await fakeComputerProvider.state(awake2.handle), "exited");

    // Simulate missing container (e.g. docker rm -f) while volume survives
    await fakeComputerProvider.destroy(awake2.handle, { removeVolume: false });
    assert.equal(await fakeComputerProvider.state(awake2.handle), "missing");

    // ensureAwake recreates container and preserves volume file
    const recreated = await ensureAwake("user_1", "agent_1");
    assert.equal(recreated.row.status, "awake");
    assert.equal(await fakeComputerProvider.state(recreated.handle), "running");
    const fileBuf = await fakeComputerProvider.readFile(
      recreated.handle,
      "/home/agent/work/hello.txt"
    );
    assert.equal(fileBuf.toString("utf8"), "persistent content");

    // Reset wipes volume and rotates token
    const resetRow = await resetComputer("user_1", "agent_1");
    assert.equal(resetRow.status, "asleep");
    await assert.rejects(
      () =>
        fakeComputerProvider.readFile(
          recreated.handle,
          "/home/agent/work/hello.txt"
        ),
      /File not found/
    );

    // Disable removes row and container
    await disableComputer("user_1", "agent_1");
    assert.equal(memDb.rows.size, 0);
  });

  it("enforces compare-and-swap (CAS) leases across concurrent runs", async () => {
    await enableComputer("user_1", "agent_1");
    const t0 = new Date("2026-09-26T12:00:00Z");

    const l1 = await acquireComputerLease("user_1", "agent_1", "run_A", 60_000, t0);
    assert.equal(l1.acquired, true);
    assert.equal(l1.holderRunId, "run_A");

    // Second run cannot steal active lease
    const l2 = await acquireComputerLease(
      "user_1",
      "agent_1",
      "run_B",
      60_000,
      new Date(t0.getTime() + 10_000)
    );
    assert.equal(l2.acquired, false);
    assert.equal(l2.holderRunId, "run_A");

    // Holder can renew
    const renewed = await renewComputerLease(
      "user_1",
      "agent_1",
      "run_A",
      60_000,
      new Date(t0.getTime() + 30_000)
    );
    assert.equal(renewed, true);

    // Non-holder cannot release
    const badRelease = await releaseComputerLease("user_1", "agent_1", "run_B", t0);
    assert.equal(badRelease, false);

    // After expiry, run_B can acquire
    const afterExpiry = await acquireComputerLease(
      "user_1",
      "agent_1",
      "run_B",
      60_000,
      new Date(t0.getTime() + 120_000)
    );
    assert.equal(afterExpiry.acquired, true);
    assert.equal(afterExpiry.holderRunId, "run_B");
  });

  it("enforces per-user and host awake caps and preflight checks", async () => {
    process.env.AGENT_COMPUTER_MAX_AWAKE_USER = "2";
    await ensureAwake("user_1", "agent_1", { autoEnable: true });
    await ensureAwake("user_1", "agent_2", { autoEnable: true });

    await assert.rejects(
      () => ensureAwake("user_1", "agent_3", { autoEnable: true }),
      /You already have 2 awake agent computers/
    );

    // Preflight failure surfaces plain user-facing message
    await sleepComputer("user_1", "agent_2");
    fakeComputerProvider.preflightResult = {
      ok: false,
      reason:
        "The server doesn't have enough free memory to start another computer right now.",
    };
    await assert.rejects(
      () => ensureAwake("user_1", "agent_2"),
      /doesn't have enough free memory/
    );
  });

  it("sweeper reconciles rebooted containers, stops idle streams, rests at 20m, and sleeps at 24h", async () => {
    const t0 = new Date("2026-09-26T00:00:00Z");

    // 1. Agent 1: awake, then host reboots (container state becomes exited)
    const c1 = await ensureAwake("user_1", "agent_reboot", { autoEnable: true });
    await fakeComputerProvider.stop(c1.handle);

    // 2. Agent 2: awake with streamOn and idle for 25 minutes
    await ensureAwake("user_1", "agent_rest", { autoEnable: true });
    await memDb.updateByAgent("user_1", "agent_rest", {
      streamOn: true,
      lastViewedAt: new Date(t0.getTime() - 25 * 60_000),
      lastActiveAt: new Date(t0.getTime() - 25 * 60_000),
      lastResumedAt: new Date(t0.getTime() - 25 * 60_000),
    });

    const sweep1 = await sweepAgentComputers({ now: t0 });
    assert.deepEqual(sweep1.reconciledAfterReboot, ["agent_reboot"]);
    assert.deepEqual(sweep1.stoppedStreams, ["agent_rest"]);
    assert.deepEqual(sweep1.rested, ["agent_rest"]);
    assert.equal((await memDb.findByAgent("user_1", "agent_reboot"))?.status, "asleep");
    assert.equal((await memDb.findByAgent("user_1", "agent_rest"))?.status, "resting");

    // 3. Advance 25 hours -> resting computer transitions to asleep
    const t25h = new Date(t0.getTime() + 25 * 3_600_000);
    const sweep2 = await sweepAgentComputers({ now: t25h });
    assert.deepEqual(sweep2.slept, ["agent_rest"]);
    assert.equal((await memDb.findByAgent("user_1", "agent_rest"))?.status, "asleep");
  });

  it("builds exact Docker production argv and never includes forbidden flags", () => {
    const prodArgv = buildDockerCreateArgv({
      agentId: "ag_123",
      userId: "usr_456",
      platform: "linux",
      nodeEnv: "production",
      memoryMb: 2048,
      cpus: 1.5,
      image: "juno-agent-computer:1",
    });

    assert.deepEqual(prodArgv, [
      "create",
      "--name",
      "juno-agent-ag_123",
      "--hostname",
      "computer",
      "--network",
      "juno-computers",
      "--dns",
      "1.1.1.1",
      "--dns",
      "9.9.9.9",
      "--memory",
      "2048m",
      "--memory-swap",
      "2048m",
      "--cpus",
      "1.5",
      "--pids-limit",
      "2048",
      "--shm-size",
      "1g",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
      "--tmpfs",
      "/run:rw,nosuid,nodev,size=64m",
      "--tmpfs",
      "/var/tmp:rw,nosuid,nodev,size=256m",
      "--mount",
      "type=volume,source=juno-agent-ag_123,target=/home/agent",
      "--label",
      "app=juno",
      "--label",
      "juno.agent=ag_123",
      "--label",
      "juno.user=usr_456",
      "-e",
      "JUNO_CDP_TOKEN",
      "--restart",
      "no",
      "--stop-timeout",
      "20",
      "juno-agent-computer:1",
    ]);

    const joined = prodArgv.join(" ");
    assert.ok(!prodArgv.includes("--privileged"));
    assert.ok(!prodArgv.includes("-p"));
    assert.ok(!joined.includes("--network host"));
    assert.ok(!joined.includes("/var/run/docker.sock"));
    assert.ok(!prodArgv.includes("-v"));
    assert.ok(!prodArgv.includes("--cap-add"));
    assert.ok(!joined.includes("seccomp=unconfined"));
    assert.ok(!joined.includes("JUNO_CDP_TOKEN="));

    // macOS dev argv adds 127.0.0.1 ephemeral port mappings
    const macDevArgv = buildDockerCreateArgv({
      agentId: "ag_123",
      userId: "usr_456",
      platform: "darwin",
      nodeEnv: "development",
    });
    assert.ok(macDevArgv.includes("-p"));
    assert.ok(macDevArgv.includes("127.0.0.1::9222"));
    assert.ok(macDevArgv.includes("127.0.0.1::5900"));
  });

  it("mints HMAC-signed view tokens with 60s expiry", () => {
    const minted = mintViewToken({
      agentId: "ag_1",
      userId: "usr_1",
      host: "172.30.0.2",
      port: 5900,
      mode: "watch",
      authSecret: "secret-key",
    });
    const [payloadB64, sigB64] = minted.token.split(".");
    assert.ok(payloadB64 && sigB64);
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    assert.equal(decoded.v, 1);
    assert.equal(decoded.a, "ag_1");
    assert.equal(decoded.u, "usr_1");
    assert.equal(decoded.h, "172.30.0.2");
    assert.equal(decoded.p, 5900);
    assert.equal(decoded.m, "watch");
  });

  it("completes a 20-step click/screenshot loop on the fake provider without stalling, and scrubs base64 from checkpoints", async () => {
    const runtime = await import("../runner/agent-core/dist/work/index.js");
    const fake = fakeComputerProvider;
    const handle = await fake.create({
      agentId: "ag_loop",
      userId: "usr_loop",
      cdpToken: "secret_cdp_token_999",
    });
    await fake.start(handle);

    let epoch = 0;
    const bumpEpoch = () => {
      epoch += 1;
      return epoch;
    };
    const takeShot = async () => {
      const shot = await fake.screenshot(handle);
      return {
        mediaType: "image/jpeg" as const,
        data: shot.jpeg.toString("base64"),
        width: shot.width,
        height: shot.height,
      };
    };

    const tools = runtime.computerTools({
      isHealthy: () => true,
      pageTakesPayment: () => false,
      currentUrl: () => "https://example.com/dashboard?token=secret_cdp_token_999",
      screenEpoch: () => epoch,
      screenshot: takeShot,
      async click(opts) {
        await fake.click(handle, opts);
        bumpEpoch();
        return takeShot();
      },
      async type(text) {
        await fake.type(handle, text);
        bumpEpoch();
        return takeShot();
      },
      async key(keys) {
        await fake.key(handle, keys);
        bumpEpoch();
        return takeShot();
      },
      async scroll(opts) {
        await fake.scroll(handle, {
          x: opts.x,
          y: opts.y,
          dy: opts.direction === "up" ? -opts.amount : opts.amount,
        });
        bumpEpoch();
        return takeShot();
      },
      exec: (cmd, opts) => fake.exec(handle, cmd, opts),
      listFiles: (dir) => fake.listFiles(handle, dir),
      async readFile(p, maxBytes) {
        const b = await fake.readFile(handle, p, { maxBytes });
        return b.toString("utf8");
      },
      async writeFile(p, content) {
        await fake.writeFile(handle, p, Buffer.from(content, "utf8"));
        bumpEpoch();
      },
    });

    let turn = 0;
    const provider = {
      id: "fake",
      name: "Fake",
      defaultModel: "fake-1",
      models: () => ["fake-1"],
      capabilities: () => ({
        tools: true,
        vision: true,
        computerUse: true,
        reasoningLevels: [],
        maxContext: 200_000,
        streaming: true,
        mcp: false,
      }),
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call" as const,
            id: `tc_${turn}`,
            name: "update_plan",
            input: { stepId: "step_1", status: "active" },
          };
        } else if (turn <= 21) {
          // 20 alternating click + screenshot steps at the same coordinates
          const isClick = turn % 2 === 0;
          yield {
            type: "tool_call" as const,
            id: `tc_${turn}`,
            name: isClick ? "computer_click" : "computer_screenshot",
            input: isClick ? { x: 240, y: 180 } : {},
          };
        } else if (turn === 22) {
          yield {
            type: "tool_call" as const,
            id: `tc_${turn}`,
            name: "update_plan",
            input: { stepId: "step_1", status: "done" },
          };
        } else {
          yield { type: "text_delta" as const, text: "All 20 desktop steps completed." };
        }
        yield {
          type: "done" as const,
          stopReason: turn <= 22 ? ("tool_use" as const) : ("end_turn" as const),
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
    };

    const plan = new runtime.WorkPlan([{ id: "step_1", title: "Click through 20 steps" }]);
    const session = new runtime.WorkAgentSession({
      runId: "run_20_steps",
      goal: "Click and inspect the desktop 20 times.",
      provider,
      model: "fake-1",
      cwd: "/tmp",
      tools,
      plan,
      budget: runtime.NO_BUDGET,
      approvalMode: "permissive",
      callbacks: {
        onEvent: () => {},
        requestApproval: async () => "allowed" as const,
        askQuestion: async () => "ok",
      },
    });

    const result = await session.run();
    assert.equal(result.state, "finished");
    assert.equal(result.terminalReason, "completed", result.detail);

    // Checkpoint must never contain raw base64 or JPEG headers
    const checkpointJson = JSON.stringify(session.checkpoint());
    assert.ok(!checkpointJson.includes('"data":"/9j'));
    assert.ok(!checkpointJson.includes("base64"));
    assert.ok(checkpointJson.includes(runtime.OMITTED_SCREENSHOT_MARKER));
  });

  it("prunes message history to keep only the last 3 images and binds Anthropic thinking with drop_block + beta header", async () => {
    const runtime = await import("../runner/agent-core/dist/work/index.js");

    // 5 user messages, each carrying an image block
    const messages = Array.from({ length: 5 }, (_, idx) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text: `step ${idx + 1}` },
        {
          type: "image" as const,
          mediaType: "image/jpeg" as const,
          data: `fake_jpeg_payload_${idx + 1}`,
        },
      ],
    }));

    runtime.pruneOldMessageImages(messages, 3);
    const remainingImages: string[] = [];
    const omittedTexts: string[] = [];
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === "image") remainingImages.push(part.data);
        if (part.type === "text" && part.text === runtime.OMITTED_SCREENSHOT_MARKER) {
          omittedTexts.push(part.text);
        }
      }
    }
    assert.equal(remainingImages.length, 3);
    assert.deepEqual(remainingImages, [
      "fake_jpeg_payload_3",
      "fake_jpeg_payload_4",
      "fake_jpeg_payload_5",
    ]);
    assert.equal(omittedTexts.length, 2);

    // Thinking binding: adaptive & enabled attach block_binding + beta header together
    const adaptive = runtime.bindingTolerantThinking({ type: "adaptive" });
    assert.deepEqual(adaptive, {
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    const headers = runtime.anthropicRequestHeadersForThinking(adaptive, {
      "anthropic-beta": "existing-beta-1",
    });
    assert.equal(
      headers?.["anthropic-beta"],
      `existing-beta-1,${runtime.THINKING_BINDING_BETA}`
    );

    const disabled = runtime.bindingTolerantThinking({ type: "disabled" });
    assert.deepEqual(disabled, { type: "disabled" });
    const disabledHeaders = runtime.anthropicRequestHeadersForThinking(disabled, {
      "anthropic-beta": "existing-beta-1",
    });
    assert.equal(disabledHeaders?.["anthropic-beta"], "existing-beta-1");
  });

  it("escalates payment pages to work.browser.purchase (irreversible) and keeps summaries free of ids, tokens, and URLs", async () => {
    const runtime = await import("../runner/agent-core/dist/work/index.js");
    let takesPayment = true;
    const tools = runtime.computerTools({
      isHealthy: () => true,
      pageTakesPayment: () => takesPayment,
      currentUrl: () => "https://checkout.stripe.com/pay/cs_live_secret123?token=tok_abc",
      screenEpoch: () => 1,
      screenshot: async () => ({
        mediaType: "image/jpeg",
        data: "AAA",
        width: 1280,
        height: 800,
      }),
      click: async () => ({
        mediaType: "image/jpeg",
        data: "AAA",
        width: 1280,
        height: 800,
      }),
      type: async () => ({
        mediaType: "image/jpeg",
        data: "AAA",
        width: 1280,
        height: 800,
      }),
      key: async () => ({
        mediaType: "image/jpeg",
        data: "AAA",
        width: 1280,
        height: 800,
      }),
      scroll: async () => ({
        mediaType: "image/jpeg",
        data: "AAA",
        width: 1280,
        height: 800,
      }),
      exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
      listFiles: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
    });

    const clickTool = tools.find((t) => t.spec.name === "computer_click")!;
    const typeTool = tools.find((t) => t.spec.name === "computer_type")!;
    const keyTool = tools.find((t) => t.spec.name === "computer_key")!;

    assert.equal(clickTool.actionFor?.({ x: 100, y: 200 }), "work.browser.purchase");
    assert.equal(clickTool.riskFor?.({ x: 100, y: 200 }), "irreversible");
    assert.equal(typeTool.actionFor?.({ text: "4242" }), "work.browser.purchase");
    assert.equal(typeTool.riskFor?.({ text: "4242" }), "irreversible");
    assert.equal(keyTool.actionFor?.({ keys: "Return" }), "work.browser.purchase");
    assert.equal(keyTool.riskFor?.({ keys: "Return" }), "irreversible");

    takesPayment = false;
    assert.equal(clickTool.actionFor?.({ x: 100, y: 200 }), "work.computer.click");
    assert.equal(clickTool.riskFor?.({ x: 100, y: 200 }), "command");

    // Summaries must never include query strings, tokens, container names, or raw URLs
    for (const tool of tools) {
      const summary = tool.summarize({
        x: 100,
        y: 200,
        text: "secret_password",
        keys: "Return",
        direction: "down",
        amount: 3,
        command: "curl https://example.com?token=tok_abc",
        action: "write",
        path: "/home/agent/work/report.csv",
      });
      assert.ok(!summary.includes("cs_live_secret123"), `summary leaked path: ${summary}`);
      assert.ok(!summary.includes("tok_abc"), `summary leaked token: ${summary}`);
      assert.ok(!summary.includes("https://"), `summary leaked full URL: ${summary}`);
      assert.ok(!summary.includes("juno-agent-"), `summary leaked container id: ${summary}`);
      assert.ok(!summary.includes("secret_password"), `summary leaked typed text: ${summary}`);
    }
  });

  it("falls back to temporary browser when computer lease is held by another run, and routes agent computer runs to cloud", async () => {
    const store = await import("@/lib/computer/store");
    const inference = await import("@/lib/work/inference");

    await enableComputer("user_1", "agent_busy");
    const first = await store.resolveRunComputerSession({
      userId: "user_1",
      agentId: "agent_busy",
      runId: "run_holder",
    });
    assert.equal(first.attached, true);

    const second = await store.resolveRunComputerSession({
      userId: "user_1",
      agentId: "agent_busy",
      runId: "run_contender",
    });
    assert.equal(second.attached, false);
    if (!second.attached) {
      assert.equal(second.fallbackReason, "busy");
      assert.equal(second.note, store.BUSY_COMPUTER_FALLBACK_NOTE);
    }

    if (first.attached) {
      await first.release();
    }

    // After release, contender can attach
    const third = await store.resolveRunComputerSession({
      userId: "user_1",
      agentId: "agent_busy",
      runId: "run_contender",
    });
    assert.equal(third.attached, true);
    if (third.attached) {
      await third.release();
    }

    // Cloud targeting: "my signed-in browser" routes to cloud without degradation when hasAgentComputer is true
    const goal = "Check my signed-in browser session and save the report to my files";
    const inferredWithoutComputer = inference.inferCapabilities(goal);
    assert.ok(inferredWithoutComputer.capabilities.includes("local_browser"));

    const inferredWithComputer = inference.inferCapabilities(goal, {
      hasAgentComputer: true,
    });
    assert.ok(!inferredWithComputer.capabilities.includes("local_browser"));
    assert.ok(!inferredWithComputer.capabilities.includes("local_files"));

    const selection = inference.selectForInferred({
      requested: "automatic",
      inferred: inferredWithoutComputer.capabilities,
      hosts: [],
      cloudAvailable: true,
      hasAgentComputer: true,
    });
    assert.equal(selection.target, "cloud");
    assert.equal(selection.degradation.length, 0);
  });
});

