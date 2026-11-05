/**
 * A Work run and its agent's computer policy, end to end on the fake provider
 * (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.5): the store's
 * `prepareRunComputer`, the runner's holder and browser switch
 * (src/lib/computer/run-tools.ts) and the runtime's start gate
 * (runner/agent-core, built `dist/`), driven by the scripted Work model. No
 * AI model is called anywhere in this file.
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
const runTools = req("../src/lib/computer/run-tools") as typeof import("@/lib/computer/run-tools");
const copy = req("../src/lib/computer/access-copy") as typeof import("@/lib/computer/access-copy");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const domain = req("../src/lib/work/domain") as typeof import("@/lib/work/domain");

type Runtime = typeof import("../runner/agent-core/src/work/index.js");
type WorkToolDefinition = import("../runner/agent-core/src/work/types.js").WorkToolDefinition;
type WorkApprovalRequest = import("../runner/agent-core/src/work/types.js").WorkApprovalRequest;
type WorkEmittedEvent = import("../runner/agent-core/src/work/types.js").WorkEmittedEvent;
type ScriptedWorkScript = import("../runner/agent-core/src/work/scripted-model.js").ScriptedWorkScript;
const loadRuntime = async (): Promise<Runtime> => (await import("../runner/agent-core/dist/work/index.js")) as unknown as Runtime;

const USER = "user_run";
const AGENT = "agent_mira";
const HANDLE = { name: `juno-agent-${AGENT}`, volume: `juno-agent-${AGENT}` };

/** A browser that records which one served each call. */
function recordingBrowser(label: string, log: string[]) {
  const page = (url: string) => ({ ok: true as const, page: { url, title: label, html: `<p>${label}</p>`, elements: [] } });
  let url = "about:blank";
  return {
    available: () => true,
    open: async (next: string) => {
      log.push(`${label}:open`);
      url = next;
      return page(next);
    },
    read: async () => (log.push(`${label}:read`), page(url)),
    click: async (_target: unknown) => (log.push(`${label}:click`), page(url)),
    typeText: async (_target: unknown, _text: string) => (log.push(`${label}:type`), page(url)),
    submit: async (_target: unknown) => (log.push(`${label}:submit`), page(url)),
    currentUrl: () => url,
    submitMethod: () => null,
    pageTakesPayment: () => false,
    close: async () => void log.push(`${label}:close`),
  };
}

interface Run {
  approvals: WorkApprovalRequest[];
  events: WorkEmittedEvent[];
  browserLog: string[];
  rows: Array<{ action: string; decision: string }>;
  lazy: import("@/lib/computer/run-tools").LazyRunComputer<ReturnType<typeof recordingBrowser>> | null;
  tools: WorkToolDefinition[];
  session: InstanceType<Runtime["WorkAgentSession"]>;
  promptSection: string | null;
}

/**
 * The runner's computer wiring, in miniature: the same store calls, the same
 * holder, the same gate and the same browser switch scripts/work-runner.ts uses.
 */
async function buildRun(opts: {
  runtime: Runtime;
  script: ScriptedWorkScript;
  attended?: boolean;
  vision?: boolean;
  runId?: string;
  rows?: Array<{ action: string; decision: string }>;
  answer?: (request: WorkApprovalRequest) => "allowed" | "denied" | "expired";
}): Promise<Run> {
  const { runtime } = opts;
  const runId = opts.runId ?? "run_1";
  const rows = opts.rows ?? [];
  const plan = await store.prepareRunComputer({
    userId: USER,
    agentId: AGENT,
    runId,
    attended: opts.attended ?? true,
    vision: opts.vision ?? true,
  });
  const browserLog: string[] = [];
  let lazy: Run["lazy"] = null;
  let tools: WorkToolDefinition[] = [];
  if (plan.kind === "lazy") {
    lazy = runTools.createLazyRunComputer({
      plan,
      userId: USER,
      runId,
      connectBrowser: () => recordingBrowser("computer", browserLog),
      readStartApproval: async () => {
        const latest = [...rows].reverse().find((row) => row.action === "work.computer.start");
        return runTools.startApprovalStateOf(latest?.decision ?? null);
      },
    });
    await lazy.refresh();
    const holder = lazy;
    const attached = () => holder.attachment()!;
    const shot = async () => {
      const s = await attached().provider.screenshot(attached().handle);
      return { mediaType: "image/jpeg" as const, data: s.jpeg.toString("base64"), width: s.width, height: s.height, hash: s.sha256 };
    };
    tools = runtime
      .computerTools({
        isHealthy: () => true,
        blockedReason: () => store.computerBlockedReason(USER, AGENT, new Date(), runId),
        takeoverEpoch: async () => (await store.computerTakeoverFence(USER, AGENT)).epoch,
        pageTakesPayment: () => false,
        currentUrl: () => "https://example.com",
        screenEpoch: () => 1,
        screenshot: shot,
        click: async (o) => (await attached().provider.click(attached().handle, o), shot()),
        type: async (t) => (await attached().provider.type(attached().handle, t), shot()),
        key: async (k) => (await attached().provider.key(attached().handle, k), shot()),
        scroll: async (o) => (await attached().provider.scroll(attached().handle, { x: o.x, y: o.y, dy: o.amount }), shot()),
        exec: (command, o) => runTools.runComputerShell(attached().provider, attached().handle, command, o),
        listFiles: (dir) => attached().provider.listFiles(attached().handle, dir),
        readFile: async (p, max) => (await attached().provider.readFile(attached().handle, p, { maxBytes: max })).toString("utf8"),
        writeFile: (p, bytes) => attached().provider.writeFile(attached().handle, p, Buffer.from(bytes)),
        settle: false,
      })
      .filter((tool) => runTools.computerToolNamesFor({ vision: opts.vision ?? true }).includes(tool.spec.name))
      .map((tool) => runtime.withComputerStart(tool, holder.gate));
  }
  const browserSwitch = lazy
    ? runTools.createRunBrowserSwitch({ lazy, temporary: () => recordingBrowser("temporary", browserLog) as never })
    : null;
  const browser = browserSwitch?.browser ?? recordingBrowser("temporary", browserLog);
  const baseBrowserTool = runtime.browserTool({
    available: () => browser.available(),
    open: (url) => browser.open(url) as never,
    read: () => browser.read() as never,
    click: (target) => browser.click(target) as never,
    typeText: (target, text) => browser.typeText(target, text) as never,
    submit: (target) => browser.submit(target) as never,
    currentUrl: () => browser.currentUrl(),
    submitMethod: () => null,
    pageTakesPayment: () => false,
    allowedDomains: () => null,
    screenEpoch: () => 1,
  });
  const browserTool = browserSwitch ? runTools.withBrowserNotice(baseBrowserTool, () => browserSwitch.takeNotice()) : baseBrowserTool;

  const approvals: WorkApprovalRequest[] = [];
  const events: WorkEmittedEvent[] = [];
  const session = new runtime.WorkAgentSession({
    runId,
    goal: "Use the computer.",
    provider: runtime.createScriptedWorkProvider(opts.script),
    model: "scripted-work-model",
    cwd: "/tmp",
    tools: [browserTool, ...tools],
    plan: new runtime.WorkPlan([{ id: "step_1", title: "Work" }]),
    budget: runtime.NO_BUDGET,
    approvalMode: "permissive",
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals.push(request);
        const row = { action: request.action, decision: "pending" };
        rows.push(row);
        const answer = opts.answer?.(request) ?? "allowed";
        row.decision = answer;
        return answer;
      },
      askQuestion: async () => "ok",
    },
  });
  return { approvals, events, browserLog, rows, lazy, tools, session, promptSection: plan.kind === "lazy" ? plan.promptSection : null };
}

const toolResults = (events: WorkEmittedEvent[]) => events.flatMap((e) => (e.kind === "tool_finished" ? [e] : []));
const said = (events: WorkEmittedEvent[]) => events.flatMap((e) => (e.kind === "assistant_message" ? [e.text] : []));
const execCalls = () => fakeComputerProvider.calls.filter((c) => c.method === "exec");

describe("a Work run and its agent's computer policy", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  let runtime: Runtime;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AUTH_SECRET"];
  const setPolicy = (policy: "off" | "ask" | "allowed") =>
    memDb.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: policy });

  beforeEach(async () => {
    runtime = await loadRuntime();
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "MAX" });
    setPolicy("ask");
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  it("policy off gives a run no computer tools", async () => {
    setPolicy("off");
    const plan = await store.prepareRunComputer({ userId: USER, agentId: AGENT, runId: "r", attended: true, vision: true });
    assert.deepEqual(plan, { kind: "none", note: null });
    // So does an account without access, and an agent that runs on a Mac.
    setPolicy("allowed");
    memDb.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "LITE" });
    assert.equal((await store.prepareRunComputer({ userId: USER, agentId: AGENT, runId: "r", attended: true, vision: true })).kind, "none");
    memDb.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "MAX" });
    memDb.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "mac", computerPolicy: "allowed" });
    assert.equal((await store.prepareRunComputer({ userId: USER, agentId: AGENT, runId: "r", attended: true, vision: true })).kind, "none");
    // A host that does not answer says so in the prompt.
    memDb.agents.set(AGENT, { userId: USER, name: "Mira", executionTarget: "cloud", computerPolicy: "allowed" });
    fakeComputerProvider.availableResult = { ok: false };
    assert.deepEqual(await store.prepareRunComputer({ userId: USER, agentId: AGENT, runId: "r", attended: true, vision: true }), {
      kind: "none",
      note: copy.COMPUTER_UNAVAILABLE_NOTE,
    });
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create" || c.method === "start"), false, "nothing was woken");
  });

  it("ask: the first computer call asks Start Mira's computer at risk sensitive, starts on approval, does nothing else, and the shell still asks", async () => {
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: true,
        steps: [
          { call: { name: "computer_shell", input: { command: "echo hi", cwd: "/home/agent/work" } } },
          { expect: "^Started your computer\\. Nothing else was done: call computer_shell again", call: { name: "computer_shell", input: { command: "echo hi", cwd: "/home/agent/work" } } },
          { say: "Done.", end: true },
        ],
      },
    });
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create"), false, "nothing starts with the run");
    await run.session.run();
    assert.equal(run.approvals.length, 2);
    const [start, shell] = run.approvals;
    assert.equal(start!.action, "work.computer.start");
    assert.equal(start!.risk, "sensitive");
    assert.equal(start!.summary, "Start Mira’s computer");
    assert.equal(start!.detail.next, "What it wants to do next (asked separately): Run: echo hi (in /home/agent/work)");
    assert.equal(shell!.action, "work.computer.shell", "the command asks for itself once the computer is on");
    assert.equal(shell!.risk, "sensitive");
    assert.equal(execCalls().length, 1, "the start ran no command; the approved repeat ran it once");
    assert.equal(fakeComputerProvider.containers.get(HANDLE.name)?.state, "running");
    assert.equal((await memDb.findByAgent(USER, AGENT))?.leaseRunId, "run_1");
    assert.ok(memDb.audits.some((a) => a.kind === "start_requested"));
    assert.ok(memDb.audits.some((a) => a.kind === "started" && a.detail.by === "run"));
    assert.equal(run.events.some((e) => e.kind === "tool_denied"), false, "the progress detector let the repeat through");
    assert.ok(said(run.events).includes("Done."));
    await run.lazy!.dispose();
    assert.equal((await memDb.findByAgent(USER, AGENT))?.leaseRunId, null, "the lease is released at the end");
  });

  it("allowed: the first call starts lazily without a start card", async () => {
    setPolicy("allowed");
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: false,
        steps: [
          { call: { name: "computer_files", input: { action: "list", path: "/home/agent/work" } } },
          { say: "Listed.", end: true },
        ],
      },
    });
    await run.session.run();
    assert.equal(run.approvals.length, 0, "no card: listing files is safe, and the start needs none under allowed");
    assert.equal(fakeComputerProvider.containers.get(HANDLE.name)?.state, "running");
    assert.equal(toolResults(run.events)[0]?.isError, false);
    await run.lazy!.dispose();
  });

  it("a declined start is not asked again in the run, also after the run resumes in a new process", async () => {
    const script: ScriptedWorkScript = {
      version: 1,
      vision: false,
      steps: [
        { call: { name: "computer_files", input: { action: "list", path: "/home/agent/work" } } },
        { call: { name: "computer_files", input: { action: "list", path: "/home/agent/work" } } },
        { expect: "did not start your computer", say: "Carrying on without it.", end: true },
      ],
    };
    const rows: Array<{ action: string; decision: string }> = [];
    const first = await buildRun({ runtime, script, rows, answer: () => "denied" });
    await first.session.run();
    assert.equal(first.approvals.length, 1);
    assert.ok(said(first.events).includes("Carrying on without it."));
    // A new process for the same run reads the declined card and asks nothing.
    const second = await buildRun({ runtime, script, rows, runId: "run_1" });
    assert.equal(second.lazy!.startState(), "declined");
    await second.session.run();
    assert.equal(second.approvals.length, 0);
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create"), false);
  });

  it("a second call while the start card is pending gets the waiting sentence", async () => {
    const rows = [{ action: "work.computer.start", decision: "pending" }];
    const run = await buildRun({
      runtime,
      rows,
      script: {
        version: 1,
        vision: false,
        steps: [
          { call: { name: "computer_shell", input: { command: "ls" } } },
          { expect: "^Waiting for the person to start your computer", say: "Waiting.", end: true },
        ],
      },
    });
    await run.session.run();
    assert.equal(run.approvals.length, 0, "no second card");
    assert.equal(execCalls().length, 0);
  });

  it("policy turned off mid-run: the computer is not started, and an approved start card that arrives afterwards does nothing", async () => {
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: false,
        steps: [
          { call: { name: "computer_shell", input: { command: "ls" } } },
          { expect: "switched off your computer", call: { name: "computer_shell", input: { command: "ls" } } },
          { expect: "switched off your computer", say: "Without it, then.", end: true },
        ],
      },
      // The person switches it off while the card is up, then presses Allow.
      answer: () => {
        setPolicy("off");
        return "allowed";
      },
    });
    await run.session.run();
    assert.equal(run.approvals.length, 1);
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create" || c.method === "start"), false);
    assert.equal(execCalls().length, 0);
    assert.ok(memDb.audits.some((a) => a.kind === "refused" && a.detail.reason === "policy_off"));
    assert.ok(said(run.events).includes("Without it, then."));
  });

  it("policy lowered from allowed to ask before the first start: nothing starts without a card", async () => {
    setPolicy("allowed");
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: false,
        steps: [
          { call: { name: "computer_files", input: { action: "list", path: "/home/agent/work" } } },
          { expect: "now wants to be asked", call: { name: "computer_files", input: { action: "list", path: "/home/agent/work" } } },
          { expect: "Started your computer", say: "Started after asking.", end: true },
        ],
      },
    });
    // Lowered after the run began, before its first computer call.
    setPolicy("ask");
    await run.session.run();
    assert.equal(run.approvals.length, 1, "the second call is the card");
    assert.equal(run.approvals[0]!.action, "work.computer.start");
    assert.ok(said(run.events).includes("Started after asking."));
    await run.lazy!.dispose();
  });

  it("an unattended browse routine under ask raises no start card", async () => {
    const run = await buildRun({
      runtime,
      attended: false,
      script: {
        version: 1,
        vision: true,
        steps: [
          { call: { name: "browser", input: { action: "open", url: "https://example.com/" } } },
          { call: { name: "browser", input: { action: "read" } } },
          { say: "Read it.", end: true },
        ],
      },
    });
    await run.session.run();
    assert.equal(run.approvals.length, 0);
    assert.deepEqual(run.browserLog, ["temporary:open", "temporary:read"]);
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create"), false, "browsing never starts the computer");
    assert.match(run.promptSection ?? "", /Starting it needs the person's approval and this run waits for it/);
  });

  it("under ask, browser uses the temporary browser until a computer tool started the computer, then the computer's, and says so once", async () => {
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: true,
        steps: [
          { call: { name: "browser", input: { action: "open", url: "https://example.com/" } } },
          { call: { name: "computer_screenshot", input: { reason: "look" } } },
          { call: { name: "browser", input: { action: "read" } } },
          { expect: "Your browser tool now uses your computer's browser, with its saved sign-ins\\.", call: { name: "browser", input: { action: "read" } } },
          // Said once: the next result in the computer's browser does not repeat it.
          { expect: "^(?![\\s\\S]*Your browser tool now uses)", say: "Done.", end: true },
        ],
      },
    });
    await run.session.run();
    assert.deepEqual(run.browserLog, ["temporary:open", "computer:read", "computer:read"]);
    const outputs = toolResults(run.events).length;
    assert.equal(outputs, 4);
    // The notice once, on the first result in the computer's browser.
    const texts = run.events.flatMap((e) => (e.kind === "tool_finished" ? [e] : []));
    assert.equal(texts.length, 4);
    assert.ok(said(run.events).includes("Done."), "the fourth step's expectation saw the notice exactly where it belongs");
    await run.lazy!.dispose();
  });

  it("the start card's explanation is the start sentence, not the command one", () => {
    for (const policy of domain.WORK_PERMISSION_POLICIES) {
      const ruling = domain.approvalRuling({ action: "work.computer.start", risk: "sensitive", policy });
      assert.equal(ruling.ask, true);
      assert.equal(ruling.explanation, copy.COMPUTER_START_EXPLANATION);
    }
    assert.match(domain.approvalRuling({ action: "work.computer.shell", risk: "sensitive", policy: "balanced" }).explanation, /runs a command/);
  });

  it("pixel tools are absent without vision", async () => {
    assert.deepEqual([...runTools.computerToolNamesFor({ vision: false })], ["computer_shell", "computer_files"]);
    assert.equal(runTools.computerToolNamesFor({ vision: true }).length, 10);
    setPolicy("allowed");
    const blind = await buildRun({ runtime, vision: false, script: { version: 1, vision: false, steps: [{ end: true }] } });
    assert.deepEqual(blind.tools.map((t) => t.spec.name), ["computer_shell", "computer_files"]);
    assert.doesNotMatch(blind.promptSection ?? "", /pixel tools/);
    assert.match(blind.promptSection ?? "", /Running a command asks the person every time/);
    const seeing = await buildRun({ runtime, vision: true, script: { version: 1, vision: true, steps: [{ end: true }] } });
    assert.equal(seeing.tools.length, 10);
    assert.match(seeing.promptSection ?? "", /pixel tools/);
  });

  it("cwd reaches the provider as --workdir and never the command string", async () => {
    setPolicy("allowed");
    const nasty = "/home/agent/work/$(touch /tmp/pwned)";
    const run = await buildRun({
      runtime,
      script: {
        version: 1,
        vision: false,
        steps: [
          { call: { name: "computer_shell", input: { command: "pwd", cwd: "/home/agent/work/reports" } } },
          { call: { name: "computer_shell", input: { command: "pwd", cwd: nasty } } },
          { say: "Done.", end: true },
        ],
      },
    });
    await run.session.run();
    const calls = execCalls();
    assert.equal(calls.length, 2);
    for (const [i, call] of calls.entries()) {
      assert.equal(call.args[1], "pwd", "the command string is passed unchanged");
      assert.equal((call.args[2] as { cwd?: string }).cwd, i === 0 ? "/home/agent/work/reports" : nasty, "the directory goes to the provider's option");
      assert.doesNotMatch(String(call.args[1]), /cd |touch/);
    }
    await run.lazy!.dispose();
  });
});
