/**
 * Take over, hand back and lapse, wired to the provider's freeze and thaw
 * (src/lib/computer/store.ts; docs/design/agents-v2/COMPUTERS_2026-10.md §S1.6,
 * D3), and what every wake checks (D13, D16). The fake provider records the
 * order of its calls; the real primitives are stage S2's, proven on a real
 * container there.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const takeover = req("../src/lib/computer/takeover") as typeof import("@/lib/computer/takeover");
const copy = req("../src/lib/computer/access-copy") as typeof import("@/lib/computer/access-copy");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");

const ORDERED = new Set(["freezeAgent", "thawAgent", "startVnc", "stopVnc", "stop", "destroy", "create", "start"]);
const order = () => fakeComputerProvider.calls.map((c) => c.method).filter((m) => ORDERED.has(m));
const since = (mark: number) => order().slice(mark);

describe("take over, hand back and lapse", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AUTH_SECRET", "AGENT_COMPUTER_MAX_IMAGE_AGE_DAYS"];

  beforeEach(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    delete process.env.AGENT_COMPUTER_MAX_IMAGE_AGE_DAYS;
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    await store.ensureAwake("user_1", "agent_t", { autoEnable: true });
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  const handle = { name: "juno-agent-agent_t", volume: "juno-agent-agent_t" };
  const audits = (kind: string) => memDb.audits.filter((a) => a.kind === kind);

  it("a new takeover freezes once", async () => {
    const session = await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.equal(session.kind, "direct");
    if (session.kind === "direct") assert.equal(session.freeze, "ok");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    assert.equal(order().filter((m) => m === "freezeAgent").length, 1);
    assert.equal(audits("takeover_started").length, 1);
    // Watching never freezes.
    const watch = await store.openComputerViewSession("user_1", "agent_t", "watch");
    if (watch.kind === "direct") assert.equal(watch.freeze, undefined);
    assert.equal(order().filter((m) => m === "freezeAgent").length, 1);
  });

  it("extending a takeover does not freeze again", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control" });
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control" });
    const again = await store.openComputerViewSession("user_1", "agent_t", "control");
    if (again.kind === "direct") assert.equal(again.freeze, undefined, "the same take over, extended");
    assert.equal(order().filter((m) => m === "freezeAgent").length, 1);
    assert.equal(audits("takeover_started").length, 1);
  });

  it("hand back closes, rotates, then thaws, and audits the holder", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    const mark = order().length;
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    assert.deepEqual(since(mark), ["startVnc", "thawAgent"], "rotate (which drops the person's session), then thaw");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null, "the window is closed");
    assert.equal(fakeComputerProvider.isFrozen(handle), false);
    const handedBack = audits("takeover_handed_back");
    assert.equal(handedBack.length, 1);
    assert.equal(handedBack[0]!.detail.via, "web");
    assert.equal(typeof handedBack[0]!.detail.heldSeconds, "number");
    assert.equal(handedBack[0]!.actor, "web");
  });

  it("a lapse closes through the CAS, rotates, then thaws, and audits takeover_lapsed once", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "phone" });
    const later = new Date(Date.now() + takeover.TAKEOVER_WINDOW_MS + 5_000);
    const mark = order().length;
    assert.equal(await store.settleLapsedTakeovers(later), 1);
    assert.deepEqual(since(mark), ["startVnc", "thawAgent"]);
    assert.equal(await store.settleLapsedTakeovers(later), 0, "settled once");
    assert.equal(audits("takeover_lapsed").length, 1);
    const row = await memDb.findByAgent("user_1", "agent_t");
    assert.equal(row?.takeoverBy, null);
    assert.equal(row?.takeoverUntil, null);
    // A heartbeat that arrives after the lapse was settled does not reopen it.
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", deviceSessionId: "phone" });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null);
  });

  it("the fence settles a lapsed take over before the agent acts again", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    const later = new Date(Date.now() + takeover.TAKEOVER_WINDOW_MS + 5_000);
    const fence = await store.computerTakeoverFence("user_1", "agent_t", later);
    assert.equal(fence.reason, null);
    assert.equal(fakeComputerProvider.isFrozen(handle), false, "thawed by the time the agent reads the fence");
    assert.equal(audits("takeover_lapsed").length, 1);
  });

  it("a failed rotation stops the stream before the thaw, and a failed stop sleeps the computer instead of thawing", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    fakeComputerProvider.startVncError = new Error("x11vnc would not restart");
    let mark = order().length;
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    assert.deepEqual(since(mark), ["startVnc", "stopVnc", "thawAgent"]);
    assert.equal(audits("rotate_failed").length, 1);

    // Again, and now stopping the stream fails too: sleeping ends every process.
    fakeComputerProvider.startVncError = undefined;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    fakeComputerProvider.startVncError = new Error("no");
    fakeComputerProvider.stopVncError = new Error("no");
    mark = order().length;
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    const after = since(mark);
    assert.ok(after.includes("stop"), "the computer was put to sleep");
    assert.equal(after.includes("thawAgent"), false, "never thawed while the person's session might live");
    assert.equal((await memDb.findByAgent("user_1", "agent_t"))?.status, "asleep");
    assert.ok(audits("slept").some((a) => a.detail.reason === "rotate_failed"));
  });

  it("a freeze failure still grants control and says so", async () => {
    fakeComputerProvider.freezeError = new Error("a task still runs");
    const session = await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.equal(session.kind, "direct");
    if (session.kind === "direct") {
      assert.equal(session.freeze, "failed");
      assert.equal(session.password.length, 8, "the person gets control");
    }
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL);
    assert.equal(audits("freeze_failed").length, 1);
    assert.equal(copy.freezeFailedLine("Mira"), "Couldn’t pause what Mira was running. It may still finish while you have control.");
  });

  it("a provider that cannot freeze is audited, and the overlay is not told it paused", async () => {
    fakeComputerProvider.withoutMethods("freezeAgent", "thawAgent");
    const session = await store.openComputerViewSession("user_1", "agent_t", "control");
    if (session.kind === "direct") assert.equal(session.freeze, "unavailable");
    assert.equal(audits("freeze_unavailable").length, 1);
  });

  it("an outdated image recreates the container on its volumes", async () => {
    await fakeComputerProvider.writeFile(handle, "/home/agent/work/keep.txt", "kept");
    await store.sleepComputer("user_1", "agent_t");
    fakeComputerProvider.outdated = true;
    const mark = order().length;
    const awake = await store.ensureAwake("user_1", "agent_t");
    assert.deepEqual(since(mark).slice(0, 3), ["destroy", "create", "start"]);
    const destroyCall = fakeComputerProvider.calls.filter((c) => c.method === "destroy").at(-1)!;
    assert.deepEqual(destroyCall.args[1], { removeVolume: false }, "its volumes stay");
    assert.equal((await fakeComputerProvider.readFile(awake.handle, "/home/agent/work/keep.txt")).toString(), "kept");
    assert.equal(audits("rebuilt").length, 1);
  });

  it("a stale image is audited and still wakes", async () => {
    await store.sleepComputer("user_1", "agent_t");
    fakeComputerProvider.image = { ...fakeComputerProvider.image, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    const awake = await store.ensureAwake("user_1", "agent_t");
    assert.equal(awake.row.status, "awake");
    const stale = audits("image_stale");
    assert.equal(stale.length, 1);
    assert.ok((stale[0]!.detail.days ?? 0) >= 29);
    // A fresh image says nothing.
    await store.sleepComputer("user_1", "agent_t");
    fakeComputerProvider.image = { ...fakeComputerProvider.image, createdAt: new Date().toISOString() };
    await store.ensureAwake("user_1", "agent_t");
    assert.equal(audits("image_stale").length, 1);
  });

  it("a failing namespace check refuses the wake and sleeps the computer", async () => {
    await store.sleepComputer("user_1", "agent_t");
    fakeComputerProvider.sandboxError = new Error("the agent created a user namespace");
    await assert.rejects(() => store.ensureAwake("user_1", "agent_t"), (err: unknown) => err instanceof Error && err.message === copy.WAKE_REFUSED_SANDBOX);
    const row = await memDb.findByAgent("user_1", "agent_t");
    assert.equal(row?.status, "asleep");
    assert.equal(row?.lastError, copy.WAKE_REFUSED_SANDBOX);
    assert.equal(audits("sandbox_check_failed").length, 1);
    // A passing check is recorded with its state.
    fakeComputerProvider.sandboxError = undefined;
    fakeComputerProvider.sandboxAnswer = "on";
    await store.ensureAwake("user_1", "agent_t");
    assert.ok(audits("browser_sandbox").some((a) => a.detail.state === "on"));
  });

  it("every wake thaws when nobody holds control (the safety net)", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    // While the person holds control, a wake leaves the agent frozen.
    await store.ensureAwake("user_1", "agent_t");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    // Closed behind the release path's back: the next wake thaws.
    await memDb.updateByAgent("user_1", "agent_t", { takeoverUntil: null, takeoverBy: null, takeoverStartedAt: null });
    await store.ensureAwake("user_1", "agent_t");
    assert.equal(fakeComputerProvider.isFrozen(handle), false);
  });

  it("a wake during a lapse nobody settled ends the person's session before it thaws", async () => {
    const first = await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "phone" });
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    // The window ran out a moment ago; no tick and no fence has settled it.
    await memDb.updateByAgent("user_1", "agent_t", { takeoverUntil: new Date(Date.now() - 1_000) });
    const mark = order().length;
    // Any wake: here a files listing.
    await store.listOrDownloadComputerFiles("user_1", "agent_t", "/home/agent/work");
    assert.deepEqual(
      since(mark).filter((m) => m === "startVnc" || m === "thawAgent"),
      ["startVnc", "thawAgent"],
      "the passwords rotate (dropping the person's session) before the agent is thawed",
    );
    assert.equal(fakeComputerProvider.isFrozen(handle), false);
    const row = await memDb.findByAgent("user_1", "agent_t");
    assert.equal(row?.takeoverBy, null);
    assert.equal(row?.takeoverUntil, null);
    assert.equal(audits("takeover_lapsed").length, 1);
    // The person's late heartbeat no longer renews it, and taking control
    // again is a new take over: new password, frozen again.
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", deviceSessionId: "phone" });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null);
    const again = await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "phone" });
    assert.ok(first.kind === "direct" && again.kind === "direct");
    if (first.kind === "direct" && again.kind === "direct") {
      assert.notEqual(again.password, first.password, "the old control password no longer works");
      assert.equal(again.freeze, "ok");
    }
  });

  it("a wake during an unsettled lapse whose session cannot be ended sleeps the computer and never thaws", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control");
    await memDb.updateByAgent("user_1", "agent_t", { takeoverUntil: new Date(Date.now() - 1_000) });
    fakeComputerProvider.startVncError = new Error("x11vnc would not restart");
    fakeComputerProvider.stopVncError = new Error("nor stop");
    const mark = order().length;
    await assert.rejects(() => store.ensureAwake("user_1", "agent_t"), (err: unknown) => err instanceof Error && err.message === errors.COMPUTER_NOT_RESPONDING);
    assert.equal(since(mark).includes("thawAgent"), false);
    assert.equal((await memDb.findByAgent("user_1", "agent_t"))?.status, "asleep");
    assert.ok(audits("slept").some((a) => a.detail.reason === "rotate_failed"));
  });

  it("a wake that read the row before a take over opened never thaws the agent under it", async () => {
    // The checker's case: a run's lazy start (or a files listing, or a watch
    // from another device) is in slow provider work when the person takes control.
    const slow = fakeComputerProvider.holdNext("provisionCdpToken");
    const wake = store.ensureAwake("user_1", "agent_t", { by: "run" });
    await slow.started;
    const session = await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.ok(session.kind === "direct" && session.freeze === "ok");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    const mark = order().length;
    slow.release();
    await wake;
    assert.equal(since(mark).includes("thawAgent"), false, "the stale wake thawed nothing");
    assert.equal(fakeComputerProvider.isFrozen(handle), true, "the agent stays paused while the person has control");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL);
  });

  it("a take over that opens while a thaw is in flight freezes the agent again", async () => {
    const thaw = fakeComputerProvider.holdNext("thawAgent");
    const wake = store.ensureAwake("user_1", "agent_t");
    await thaw.started;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    const mark = order().length;
    thaw.release();
    await wake;
    assert.deepEqual(since(mark), ["thawAgent", "freezeAgent"], "the late thaw landed, and was undone");
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    assert.equal(audits("refrozen").length, 1);
  });

  it("a freeze that fails after a late thaw is audited", async () => {
    const thaw = fakeComputerProvider.holdNext("thawAgent");
    const wake = store.ensureAwake("user_1", "agent_t");
    await thaw.started;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    fakeComputerProvider.freezeError = new Error("docker exec failed");
    thaw.release();
    await wake;
    assert.equal(audits("refrozen").length, 0);
    assert.ok(audits("freeze_failed").length >= 1);
  });

  it("a hand back whose rotation is slow never thaws under a take over another device opened meanwhile", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "laptop" });
    const rotate = fakeComputerProvider.holdNext("startVnc");
    const handBack = store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true, deviceSessionId: "laptop" });
    await rotate.started;
    // The window is closed and the passwords are rotating: the phone takes control.
    const phone = await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "phone" });
    assert.ok(phone.kind === "direct" && phone.freeze === "ok");
    const mark = order().length;
    rotate.release();
    await handBack;
    assert.equal(since(mark).includes("thawAgent"), false, "the hand back's thaw was skipped");
    assert.equal(fakeComputerProvider.isFrozen(handle), true, "the phone's take over keeps the agent paused");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL);
  });

  it("a take over handed back while the agent was being frozen again ends thawed once the session is over", async () => {
    const thaw = fakeComputerProvider.holdNext("thawAgent");
    const wake = store.ensureAwake("user_1", "agent_t");
    await thaw.started;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    const refreeze = fakeComputerProvider.holdNext("freezeAgent");
    thaw.release();
    await refreeze.started;
    // The person hands back before the new freeze lands: close, rotate, thaw.
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    assert.equal(fakeComputerProvider.isFrozen(handle), false);
    refreeze.release();
    await wake;
    assert.equal(audits("refrozen").length, 1);
    assert.equal(fakeComputerProvider.isFrozen(handle), false, "the session had ended (new passwords), so the agent runs again");
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null);
  });

  it("a take over being handed back while the agent is frozen again stays paused until the person's session ends", async () => {
    const thaw = fakeComputerProvider.holdNext("thawAgent");
    const wake = store.ensureAwake("user_1", "agent_t");
    await thaw.started;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    const refreeze = fakeComputerProvider.holdNext("freezeAgent");
    thaw.release();
    await refreeze.started;
    // Hand back closes the window, then its rotation is slow.
    const rotate = fakeComputerProvider.holdNext("startVnc");
    const handBack = store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    await rotate.started;
    refreeze.release();
    await wake;
    assert.equal(fakeComputerProvider.isFrozen(handle), true, "the person can still type: the agent stays paused");
    rotate.release();
    await handBack;
    assert.equal(fakeComputerProvider.isFrozen(handle), false, "the hand back thawed it after ending the session");
  });

  it("audit rows carry identifiers and verdicts only", async () => {
    await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "device-secret-id" });
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true, deviceSessionId: "device-secret-id" });
    const text = JSON.stringify(memDb.audits);
    assert.doesNotMatch(text, /device-secret-id|juno-agent-|password|token/);
    for (const row of memDb.audits) {
      for (const key of Object.keys(row.detail)) {
        assert.ok(["by", "reason", "via", "heldSeconds", "runId", "bytes", "state", "minutes", "days", "policyFrom", "policyTo"].includes(key), key);
      }
    }
  });
});
