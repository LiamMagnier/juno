/**
 * Computer Use hardening from the 2026-10-04 audit (docs/rework/program/
 * SECURITY_PERMISSIONS.md §3), locally provable parts:
 *
 *   1. Only the client that holds a takeover can hand it back.
 *   2. A takeover that overlapped a call — even one that began and ended
 *      inside it — discards the call's result (the epoch fence), for the
 *      computer tools and for the browser on the same Chromium.
 *   3. Secret inputs never reach the model through a page snapshot.
 *   4. Return / Enter / Space are not "navigation": they press buttons.
 *   5. The browser refuses to type into a password field; a saved credential
 *      fill asks every time and never returns the value (tested with the
 *      trusted fill boundary in tests/secrets-browser-fill.test.ts).
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
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const takeover = req("../src/lib/computer/takeover") as typeof import("@/lib/computer/takeover");
const page = req("../src/lib/work/browser-page") as typeof import("@/lib/work/browser-page");
const domain = req("../src/lib/work/domain") as typeof import("@/lib/work/domain");
const remote = req("../src/lib/computer/remote-browser") as typeof import("@/lib/computer/remote-browser");

type Runtime = typeof import("../runner/agent-core/src/work/index.js");
const loadRuntime = async (): Promise<Runtime> =>
  (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

const CTX = { cwd: "/tmp" };

describe("takeover: holder-only hand-back and the epoch fence", () => {
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

  it("another tab or device on the same account cannot hand back someone's control", async () => {
    await store.ensureAwake("user_1", "agent_t", { autoEnable: true });
    await store.openComputerViewSession("user_1", "agent_t", "control", { deviceSessionId: "phone-A" });
    assert.equal((await memDb.findByAgent("user_1", "agent_t"))?.takeoverBy, "native:phone-A");

    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL, "the web cannot release it");
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true, deviceSessionId: "phone-B" });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), takeover.TAKEOVER_REFUSAL, "nor another device");

    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true, deviceSessionId: "phone-A" });
    assert.equal(await store.computerBlockedReason("user_1", "agent_t"), null, "the holder can");
  });

  it("the epoch moves once per takeover, never on a heartbeat, and never goes back", async () => {
    await store.ensureAwake("user_1", "agent_t", { autoEnable: true });
    const e0 = (await store.computerTakeoverFence("user_1", "agent_t")).epoch;
    await store.openComputerViewSession("user_1", "agent_t", "control");
    const e1 = (await store.computerTakeoverFence("user_1", "agent_t")).epoch;
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control" });
    assert.equal((await store.computerTakeoverFence("user_1", "agent_t")).epoch, e1, "extending is the same takeover");
    await store.heartbeatComputerViewSession("user_1", "agent_t", { mode: "control", ended: true });
    const after = await store.computerTakeoverFence("user_1", "agent_t");
    assert.equal(e1, e0 + 1);
    assert.equal(after.epoch, e1, "hand back keeps the count");
    assert.equal(after.reason, null);
  });

  it("a takeover that started and ended inside a browser call discards that call's result", async () => {
    let fence: { reason: string | null; epoch: number } = { reason: null, epoch: 3 };
    const browser = {
      open: async () => ({ ok: true }),
      read: async () => {
        // The person takes over and hands back while this read is in flight.
        fence = { reason: null, epoch: 4 };
        return { ok: true, page: "what the screen showed during the takeover" };
      },
      click: async (_target: { ref?: number }) => ({ ok: true }),
      typeText: async (_target: { ref?: number }, _text: string) => ({ ok: true }),
      submit: async (_target: { ref?: number }) => ({ ok: true }),
      fillSecret: async (_target: { ref?: number }, _value: string, _opts: { requirePasswordField: boolean }) => ({ ok: true }),
    };
    const guarded = takeover.guardBrowserForTakeover(browser, async () => fence);
    const result = await guarded.read();
    assert.deepEqual(result, { ok: false, message: takeover.TAKEOVER_OVERLAP_REFUSAL });
    // A string-only fence (older callers) keeps the old behaviour.
    const legacy = takeover.guardBrowserForTakeover(browser, async () => null);
    assert.equal((await legacy.click({ ref: 1 })).ok, true);
    // A credential fill is guarded like every other action.
    fence = { reason: takeover.TAKEOVER_REFUSAL, epoch: 5 };
    assert.deepEqual(await guarded.fillSecret!({ ref: 1 }, "x", { requirePasswordField: true }), {
      ok: false,
      message: takeover.TAKEOVER_REFUSAL,
    });
  });

  it("computer tools discard a result when the epoch moved during the call", async () => {
    const runtime = await loadRuntime();
    let epoch = 7;
    const shot = { mediaType: "image/jpeg" as const, data: "AAA", width: 10, height: 10 };
    const tools = runtime.computerTools({
      isHealthy: () => true,
      blockedReason: () => null,
      takeoverEpoch: () => epoch,
      pageTakesPayment: () => false,
      currentUrl: () => "",
      screenEpoch: () => 1,
      screenshot: async () => {
        epoch += 1; // a whole takeover happened while the screenshot was taken
        return shot;
      },
      click: async () => shot,
      type: async () => shot,
      key: async () => shot,
      scroll: async () => shot,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      listFiles: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
    });
    const screenshot = tools.find((tool) => tool.spec.name === "computer_screenshot")!;
    const result = await screenshot.execute({ reason: "look" }, CTX);
    assert.equal(result.isError, true);
    assert.equal(result.output, runtime.TAKEOVER_OVERLAP_TEXT);
    assert.equal(result.images, undefined, "no image from the overlapped call");
    assert.equal(runtime.TAKEOVER_OVERLAP_TEXT, takeover.TAKEOVER_OVERLAP_REFUSAL, "runner and web agree on the sentence");
  });

  it("the pure fence rule", () => {
    assert.equal(takeover.takeoverFenceVerdict({ reason: null, epoch: 1 }, { reason: null, epoch: 1 }), null);
    assert.equal(takeover.takeoverFenceVerdict({ reason: null, epoch: 1 }, { reason: null, epoch: 2 }), takeover.TAKEOVER_OVERLAP_REFUSAL);
    assert.equal(takeover.takeoverFenceVerdict(null, "blocked"), "blocked");
    assert.equal(takeover.takeoverReleasableBy({ takeoverUntil: new Date(Date.now() + 10_000), takeoverBy: "web" }, "native:x", new Date()), false);
    assert.equal(takeover.takeoverReleasableBy({ takeoverUntil: new Date(Date.now() - 1), takeoverBy: "web" }, "native:x", new Date()), true);
  });
});

describe("secret inputs never reach the model through a snapshot", () => {
  it("strips values from password, hidden, one-time-code and card inputs only", () => {
    const html = [
      '<input type="password" name="pw" value="hunter2">',
      "<input type='hidden' value='csrf-token-abc'>",
      '<input autocomplete="one-time-code" value=123456>',
      '<input autocomplete="cc-number" value="4242424242424242">',
      '<INPUT TYPE=PASSWORD VALUE="Caps1">',
      '<input type="text" name="q" value="ordinary search">',
    ].join("\n");
    const out = page.redactSecretInputs(html);
    for (const secret of ["hunter2", "csrf-token-abc", "123456", "4242424242424242", "Caps1"]) {
      assert.ok(!out.includes(secret), secret);
    }
    assert.match(out, /value="ordinary search"/, "ordinary fields keep their value");
  });

  it("the browser refuses to type into a secret field, and says how to fill one safely", () => {
    assert.match(page.SECRET_FIELD_REFUSAL, /fill_credential/);
    assert.match(page.SECRET_FIELD_REFUSAL, /take over/);
  });
});

describe("pixel keys and credential fills on the approval ladder", () => {
  it("Return, Enter and Space ask every time; navigation keys stay a command", async () => {
    const runtime = await loadRuntime();
    for (const key of ["Return", "enter", "KP_Enter", "space"]) assert.equal(runtime.isNavigationKeypress(key), false, key);
    for (const key of ["Tab", "Escape", "Page_Down", "Up"]) assert.equal(runtime.isNavigationKeypress(key), true, key);
  });

  it("fill_credential is sensitive: asks under every mode, and no standing allowance covers it", async () => {
    const runtime = await loadRuntime();
    const tool = runtime.browserTool({
      available: () => true,
      open: async () => ({ ok: false, message: "" }),
      read: async () => ({ ok: false, message: "" }),
      click: async () => ({ ok: false, message: "" }),
      typeText: async () => ({ ok: false, message: "" }),
      submit: async () => ({ ok: false, message: "" }),
      currentUrl: () => "https://github.com/login",
    });
    const input = { action: "fill_credential", ref: 3, credential: "asec_x.y", field: "password" };
    assert.equal(tool.riskFor!(input), "sensitive");
    assert.equal(tool.actionFor!(input), "work.browser.fill_credential");
    for (const policy of domain.WORK_PERMISSION_POLICIES) {
      assert.equal(runtime.approvalAsksUnder("work.browser.fill_credential", "sensitive", policy), true, policy);
      assert.equal(domain.approvalRuling({ action: "work.browser.fill_credential", risk: "sensitive", policy, standingAllowance: "command" }).ask, true);
    }
    assert.equal(domain.mayBeCoveredByStandingAllowance("work.browser.fill_credential", "sensitive"), false);
    assert.equal(tool.riskFor!({ action: "credentials" }), "safe", "listing references reveals nothing");
    const listed = await tool.execute({ action: "credentials" }, CTX);
    assert.match(listed.output, /No saved credentials were granted/);
    const refused = await tool.execute(input, CTX);
    assert.equal(refused.isError, true, "no fill without a trusted fill dependency");
  });
});

describe("site policy on the agent computer's browser", () => {
  it("refuses a top-level navigation the agent caused, and never filters the person", () => {
    const policy = (url: string) => (new URL(url).hostname.endsWith("allowed.example") ? null : "Not for this skill.");
    const base = { isNavigation: true, isMainFrame: true, policy };
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: true, url: "https://evil.example/x" }), "Not for this skill.");
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: true, url: "https://docs.allowed.example/" }), null);
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: false, url: "https://evil.example/x" }), null, "the person during a takeover");
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: true, isMainFrame: false, url: "https://evil.example/ad" }), null, "subframes are the page's business");
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: true, isNavigation: false, url: "https://evil.example/pixel.gif" }), null);
    assert.equal(remote.agentNavigationVerdict({ ...base, agentActing: true, policy: undefined, url: "https://evil.example/" }), null);
  });
});
