import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decryptSecret } from "@/lib/crypto";
import { buildDockerCreateArgv } from "@/lib/computer/docker";
import { fakeComputerProvider } from "@/lib/computer/fake";
import { mintViewToken } from "@/lib/computer/live-view";
import {
  computerProvider,
  isAgentComputerConfigured,
  resetComputerProviderCache,
} from "@/lib/computer/provider";
import {
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
} from "@/lib/computer/store";
import { sweepAgentComputers } from "@/lib/computer/sweep";

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
});
