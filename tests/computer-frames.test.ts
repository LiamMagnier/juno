/**
 * Every cloud computer step visible and replayable (cu-agent-loop).
 *
 *   (a) The provider: one `docker exec` per screenshot, key sequences split
 *       into separate xdotool arguments, and both argv shapes accepted by the
 *       production broker.
 *   (b) The runner's loop on the fake provider: each step's frame is written
 *       to local storage (./.uploads, no S3) and named on `tool_finished`; a
 *       click's start carries its point; nothing is stored while the person
 *       holds control, or when they take it mid-step.
 *   (c) The frames route: the owner gets the JPEG with no-store and
 *       no-referrer; anyone else gets a 404.
 *   (d) The filmstrip: events become timeline frames with the ring on the
 *       click point; the timeline crossfades on the motion tokens with no
 *       per-instance stylesheet.
 *   (e) Approvals: a typing approval says Type, shows the text and a marked
 *       frame; the page's own words reach the sentence only through the
 *       describer, and never a field's value.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";

(globalThis as { React?: typeof React }).React = React;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), "juno-frames-"));
// Storage's local-disk fallback writes under process.cwd()/.uploads, fixed at
// load: move into a scratch directory first, and make sure no bucket is set.
const startingDir = process.cwd();
process.chdir(STORAGE_ROOT);
for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"]) delete process.env[key];
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";

// ---- module stand-ins -------------------------------------------------------

type DockerResult = { stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean };
let dockerStub: ((argv: string[]) => Promise<DockerResult>) | null = null;
const dockerCalls: string[][] = [];

interface FakeRun {
  id: string;
  userId: string;
  deleted?: boolean;
}
const runs: FakeRun[] = [];
const runQueries: unknown[] = [];
const fakePrisma = {
  workRun: {
    findFirst: async (args: { where: { id: string; userId: string; session?: { userId?: string; deletedAt?: null } } }) => {
      runQueries.push(args.where);
      const run = runs.find(
        (candidate) =>
          candidate.id === args.where.id &&
          candidate.userId === args.where.userId &&
          !(candidate.deleted && args.where.session?.deletedAt === null),
      );
      return run ? { id: run.id, userId: run.userId } : null;
    },
  },
};
let viewer: { id: string } | null = null;

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/docker-cli") {
    const actual = origLoad.call(this, request, parent, isMain) as typeof import("@/lib/docker-cli");
    return {
      ...actual,
      runDockerBuffer: async (argv: string[], options?: Parameters<typeof actual.runDockerBuffer>[1]) => {
        dockerCalls.push(argv);
        return dockerStub ? dockerStub(argv) : actual.runDockerBuffer(argv, options);
      },
    };
  }
  if (request === "@/lib/prisma") return { prisma: fakePrisma, prismaUnguarded: fakePrisma };
  if (request === "@/lib/code-remote") {
    return {
      requireUser: async () =>
        viewer
          ? { user: viewer, error: null }
          : { user: null, error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const frames = req("../src/lib/computer/frames") as typeof import("@/lib/computer/frames");
const remoteBrowser = req("../src/lib/computer/remote-browser") as typeof import("@/lib/computer/remote-browser");
const domain = req("../src/lib/work/domain") as typeof import("@/lib/work/domain");
const route = req("../src/app/api/work/runs/[id]/frames/[callId]/route") as typeof import("@/app/api/work/runs/[id]/frames/[callId]/route");
const steps = req("../src/components/work/computer-steps") as typeof import("@/components/work/computer-steps");
const timeline = req("../src/components/code/computer-timeline") as typeof import("@/components/code/computer-timeline");
const verbs = req("../src/components/work/approvals/action-verbs") as typeof import("@/components/work/approvals/action-verbs");
const approvalFrame = req("../src/components/work/approvals/approval-frame") as typeof import("@/components/work/approvals/approval-frame");
const approvalCard = req("../src/components/work/approvals/approval-card") as typeof import("@/components/work/approvals/approval-card");

type Runtime = typeof import("../runner/agent-core/src/work/index.js");
const loadRuntime = async (): Promise<Runtime> =>
  (await import("../runner/agent-core/src/work/index.js")) as unknown as Runtime;

const source = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

after(() => {
  process.chdir(startingDir);
  rmSync(STORAGE_ROOT, { recursive: true, force: true });
});

// ---- (a) the provider ------------------------------------------------------

describe("(a) the Docker provider captures in one exec and splits key sequences", () => {
  it("one docker exec per screenshot, and 'ctrl+l Return' reaches xdotool as two arguments", async () => {
    const png = await sharp({ create: { width: 1280, height: 800, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    dockerStub = async (argv) => ({
      stdout: argv.includes("sh") ? png : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
    });
    try {
      const provider = new docker.DockerProvider();
      const handle = { name: "juno-agent-abc", volume: "juno-agent-abc" };
      dockerCalls.length = 0;
      const shot = await provider.screenshot(handle);
      assert.equal(dockerCalls.length, 1, "exactly one docker exec per screenshot");
      assert.deepEqual(dockerCalls[0], docker.screenshotArgv("juno-agent-abc"));
      assert.deepEqual(dockerCalls[0]!.slice(-3), ["sh", "-c", docker.SCREENSHOT_SCRIPT]);
      assert.equal(shot.jpeg[0], 0xff, "converted to JPEG");
      assert.match(shot.sha256, /^[0-9a-f]{64}$/);

      dockerCalls.length = 0;
      await provider.key(handle, "ctrl+l Return");
      assert.equal(dockerCalls.length, 1);
      assert.deepEqual(dockerCalls[0]!.slice(-4), ["key", "--", "ctrl+l", "Return"]);
      assert.deepEqual(docker.keySequence("  Tab   Tab Return "), ["Tab", "Tab", "Return"]);

      // Both shapes are ones the production broker lets through.
      const policy = { image: "juno-computer:1", network: "juno-computers", maxMemoryMb: 2048, maxCpus: 2 };
      const check = spawnSync(
        "python3",
        [
          "-c",
          `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)
refused = []
for argv in json.loads(sys.argv[3]):
    try:
        broker.validate(argv, json.loads(sys.argv[2]))
    except Exception as error:
        refused.append({"argv": argv, "error": str(error)})
print(json.dumps(refused))`,
          path.join(ROOT, "deploy/agent-computers/docker-broker.py"),
          JSON.stringify(policy),
          JSON.stringify([docker.screenshotArgv("juno-agent-abc"), dockerCalls[0]]),
        ],
        { encoding: "utf8" },
      );
      assert.equal(check.status, 0, check.stderr);
      assert.deepEqual(JSON.parse(check.stdout), []);
    } finally {
      dockerStub = null;
    }
  });

  it("the duplicate provisionCdpToken declaration is gone", () => {
    const types = source("src/lib/computer/types.ts");
    assert.equal(types.match(/provisionCdpToken\(/g)?.length, 1);
  });
});

// ---- (b) the runner's loop on the fake provider -----------------------------

/**
 * The runner's remote-computer deps (scripts/work-runner.ts, `buildTools`),
 * built the same way against the fake provider and the in-memory store.
 */
function runnerDeps(
  attachment: { agentId: string; handle: { name: string; volume: string }; provider: typeof fakeComputerProvider },
  recorder: ReturnType<typeof frames.createRunFrameRecorder>,
  ids: { userId: string; runId: string },
) {
  let epoch = 0;
  const takeShot = async () => {
    const shot = await attachment.provider.screenshot(attachment.handle);
    return { mediaType: "image/jpeg" as const, data: shot.jpeg.toString("base64"), width: shot.width, height: shot.height, hash: shot.sha256 };
  };
  return {
    isHealthy: () => true,
    blockedReason: () => store.computerBlockedReason(ids.userId, attachment.agentId, new Date(), ids.runId),
    takeoverEpoch: async () => (await store.computerTakeoverFence(ids.userId, attachment.agentId)).epoch,
    pageTakesPayment: () => false,
    currentUrl: () => "https://example.com/",
    screenEpoch: () => epoch,
    screenshot: takeShot,
    async click(opts: { x: number; y: number; button?: "left" | "right" | "double" }) {
      await attachment.provider.click(attachment.handle, opts);
      epoch += 1;
      return takeShot();
    },
    async type(text: string) {
      await attachment.provider.type(attachment.handle, text);
      epoch += 1;
      return takeShot();
    },
    async key(keys: string) {
      await attachment.provider.key(attachment.handle, keys);
      epoch += 1;
      return takeShot();
    },
    async scroll(opts: { x: number; y: number; direction: "up" | "down"; amount: number }) {
      await attachment.provider.scroll(attachment.handle, { x: opts.x, y: opts.y, dy: opts.direction === "up" ? -opts.amount : opts.amount });
      epoch += 1;
      return takeShot();
    },
    exec: (command: string, opts: { timeoutSeconds: number }) => attachment.provider.exec(attachment.handle, command, opts),
    listFiles: (dir: string) => attachment.provider.listFiles(attachment.handle, dir),
    readFile: async (p: string, maxBytes: number) => (await attachment.provider.readFile(attachment.handle, p, { maxBytes })).toString("utf8"),
    writeFile: (p: string, content: string) => attachment.provider.writeFile(attachment.handle, p, content),
    storeFrame: (ref: string, shot: { data: string; width: number; height: number }) =>
      recorder.store(ref, { jpeg: Buffer.from(shot.data, "base64"), width: shot.width, height: shot.height }),
    // Settling on its production defaults (500 ms cap, 100 ms between looks).
  };
}

function scripted(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
  let turn = 0;
  return {
    id: "fake",
    name: "Fake",
    defaultModel: "fake-1",
    models: () => ["fake-1"],
    capabilities: () => ({ tools: true, vision: true, computerUse: true, reasoningLevels: [], maxContext: 200_000, streaming: true, mcp: false }),
    async *stream() {
      const call = calls[turn];
      turn += 1;
      if (call) {
        yield { type: "tool_call" as const, ...call };
        yield { type: "done" as const, stopReason: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "text_delta" as const, text: "Done." };
        yield { type: "done" as const, stopReason: "end_turn" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
}

const frameFile = (userId: string, runId: string, ref: string) =>
  path.join(STORAGE_ROOT, ".uploads", "computer-frames", userId, runId, `${ref}.jpg`);

interface Emitted {
  kind: string;
  callId?: string;
  point?: { x: number; y: number };
  frame?: { ref: string; width: number; height: number };
  settleMs?: number;
  captureMs?: number;
  [key: string]: unknown;
}

describe("(b) the runner's step loop on the fake provider", () => {
  const USER = "user_frames";
  const AGENT = "agent_frames";
  const RUN = "run_frames";
  let attachment: Extract<Awaited<ReturnType<typeof store.resolveRunComputerSession>>, { attached: true }>;
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const emitted: Emitted[] = [];

  before(async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    // Open to every plan that includes computers (src/lib/computer/access.ts); an account the in-memory store does not know reads as the owner's.
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    await store.ensureAwake(USER, AGENT, { autoEnable: true });
    const resolved = await store.resolveRunComputerSession({ userId: USER, agentId: AGENT, runId: RUN });
    assert.equal(resolved.attached, true);
    if (!resolved.attached) throw new Error("not attached");
    attachment = resolved;
  });

  after(async () => {
    await attachment?.release().catch(() => {});
    store.setComputerStorePersistenceForTest(null);
  });

  it("each step writes its frame under ./.uploads and names it on tool_finished; the click's start has its point", async () => {
    const runtime = await loadRuntime();
    const recorder = frames.createRunFrameRecorder({ userId: USER, runId: RUN });
    // A screen that changes every third capture: each step's first frame is
    // often stale, and settling has to wait for two that agree.
    let capture = 0;
    fakeComputerProvider.screenshotHandler = async () => {
      capture += 1;
      const tint = (Math.floor(capture / 3) % 200) + 1;
      const jpeg = await sharp({ create: { width: 1280, height: 800, channels: 3, background: { r: tint, g: 0, b: 0 } } }).jpeg().toBuffer();
      return { jpeg, width: 1280, height: 800, sha256: `tint-${tint}` };
    };
    const session = new runtime.WorkAgentSession({
      runId: RUN,
      goal: "Look, click, scroll.",
      provider: scripted([
        { id: "tc_look", name: "computer_screenshot", input: { reason: "look" } },
        { id: "tc_click", name: "computer_click", input: { x: 640, y: 400 } },
        { id: "tc_scroll", name: "computer_scroll", input: { x: 640, y: 400, direction: "down" } },
      ]),
      model: "fake-1",
      cwd: "/tmp",
      tools: runtime.computerTools(runnerDeps(attachment as never, recorder, { userId: USER, runId: RUN }) as never),
      plan: new runtime.WorkPlan([{ id: "step_1", title: "Use the computer" }]),
      budget: runtime.NO_BUDGET,
      approvalMode: "permissive",
      callbacks: {
        onEvent: (event) => emitted.push(event as unknown as Emitted),
        requestApproval: async () => "allowed" as const,
        askQuestion: async () => "ok",
      },
    });
    const started = Date.now();
    const result = await session.run();
    fakeComputerProvider.screenshotHandler = undefined;
    assert.equal(result.state, "finished");

    const finished = emitted.filter((event) => event.kind === "tool_finished");
    assert.equal(finished.length, 3);
    for (const event of finished) {
      assert.ok(event.frame, `${event.callId} named its frame`);
      assert.equal(event.frame.ref, event.callId);
      assert.deepEqual([event.frame.width, event.frame.height], [1280, 800]);
      const file = frameFile(USER, RUN, event.frame.ref);
      assert.ok(existsSync(file), `${file} was written`);
      assert.equal(readFileSync(file)[0], 0xff, "a JPEG");
    }
    const click = emitted.find((event) => event.kind === "tool_started" && event.callId === "tc_click");
    assert.deepEqual(click?.point, { x: 640, y: 400 });
    assert.equal(emitted.find((event) => event.kind === "tool_started" && event.callId === "tc_look")?.point, undefined);
    assert.equal(recorder.count, 3);

    const timed = finished.filter((event) => typeof event.settleMs === "number" && typeof event.captureMs === "number");
    assert.equal(timed.length, 3);
    const perStep = timed.reduce((total, event) => total + event.settleMs! + event.captureMs!, 0) / timed.length / 1000;
    console.log(
      `# fake provider, real clock: ${perStep.toFixed(3)} s settle + capture per step (${timed.length} steps, ${Date.now() - started} ms for the whole run)`,
    );
  });

  it("the frames route serves the owner with no-store and no-referrer, and 404s everyone else", async () => {
    runs.push({ id: RUN, userId: USER });
    viewer = { id: USER };
    const ok = await route.GET(new Request("http://x/"), { params: Promise.resolve({ id: RUN, callId: "tc_click" }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
    assert.equal(new Uint8Array(await ok.arrayBuffer())[0], 0xff);
    assert.deepEqual(runQueries.at(-1), { id: RUN, userId: USER, session: { userId: USER, deletedAt: null } });

    viewer = { id: "someone_else" };
    const other = await route.GET(new Request("http://x/"), { params: Promise.resolve({ id: RUN, callId: "tc_click" }) });
    assert.equal(other.status, 404);
    assert.equal(other.headers.get("cache-control"), "no-store");
    assert.equal(other.headers.get("referrer-policy"), "no-referrer");

    viewer = { id: USER };
    for (const callId of ["../../etc/passwd", "tc_missing", "a b"]) {
      const res = await route.GET(new Request("http://x/"), { params: Promise.resolve({ id: RUN, callId }) });
      assert.equal(res.status, 404, callId);
    }
    viewer = null;
    const anonymous = await route.GET(new Request("http://x/"), { params: Promise.resolve({ id: RUN, callId: "tc_click" }) });
    assert.equal(anonymous.status, 401);
  });

  it("no frame is stored while the person has control, nor when they take it mid-step", async () => {
    const runtime = await loadRuntime();
    const recorder = frames.createRunFrameRecorder({ userId: USER, runId: RUN });
    const tools = runtime.computerTools(runnerDeps(attachment as never, recorder, { userId: USER, runId: RUN }) as never);
    const tool = (name: string) => tools.find((candidate) => candidate.spec.name === name)!;
    const listing = () => readdirSync(path.dirname(frameFile(USER, RUN, "x")));
    const before = listing();

    await store.openComputerViewSession(USER, AGENT, "control");
    for (const [name, input] of [
      ["computer_screenshot", { reason: "look" }],
      ["computer_click", { x: 10, y: 10 }],
      ["computer_wait", { seconds: 0.5 }],
    ] as const) {
      const result = await tool(name).execute(input, { cwd: "/tmp", callId: `held_${name}` });
      assert.equal(result.isError, true, name);
      assert.equal(result.images, undefined);
    }
    assert.deepEqual(listing(), before, "nothing was written while the person held control");
    await store.heartbeatComputerViewSession(USER, AGENT, { mode: "control", ended: true });

    // Take control while a capture is in flight: the epoch moves, so the
    // frame is discarded with the result.
    fakeComputerProvider.screenshotHandler = async (handle) => {
      fakeComputerProvider.screenshotHandler = undefined;
      await store.openComputerViewSession(USER, AGENT, "control");
      return fakeComputerProvider.screenshot(handle);
    };
    const overlapped = await tool("computer_screenshot").execute({ reason: "look" }, { cwd: "/tmp", callId: "overlap_shot" });
    assert.equal(overlapped.isError, true);
    assert.equal(overlapped.images, undefined);
    assert.equal(existsSync(frameFile(USER, RUN, "overlap_shot")), false);
    assert.deepEqual(listing(), before);
    assert.equal(recorder.count, 0);
    await store.heartbeatComputerViewSession(USER, AGENT, { mode: "control", ended: true });
  });

  it("the filmstrip folds the run's events into frames with the ring on the click point", () => {
    const events = emitted.map((payload, index) => ({
      id: `evt_${index}`,
      runId: RUN,
      seq: index + 1,
      kind: payload.kind as never,
      payloadVersion: 1,
      visibility: "user" as const,
      payload: payload as never,
      eventKey: null,
      agentId: null,
      createdAt: new Date(Date.UTC(2026, 9, 16, 12, 0, index)).toISOString(),
    }));
    const { frames: built, size } = steps.deriveComputerSteps(events, RUN);
    assert.deepEqual(size, { width: 1280, height: 800 });
    assert.deepEqual(built.map((frame) => frame.action), ["screenshot", "click", "scroll"]);
    const click = built[1]!;
    assert.deepEqual(click.point, { x: 0.5, y: 0.5 });
    assert.equal(click.src, `/api/work/runs/${RUN}/frames/tc_click`);
    assert.equal(click.live, false);
    assert.equal(click.caption, "Click at (640, 400) on example.com", "no describer on the fake provider: coordinates");
    assert.equal(steps.deriveComputerSteps(events, null).frames[1]?.src, null, "no run, no frame address");

    const html = renderToStaticMarkup(React.createElement(steps.WorkComputerSteps, { runId: RUN, events }));
    assert.match(html, /3 steps/);
    assert.match(html, /left:50\.00%;top:50\.00%/, "the ring sits on the click point");
    assert.match(html, new RegExp(`src="/api/work/runs/${RUN}/frames/tc_scroll"`));
    assert.match(html, /aspect-ratio:1280 \/ 800/);
    assert.equal(renderToStaticMarkup(React.createElement(steps.WorkComputerSteps, { runId: RUN, events: [] })), "");

    // A step still running is live; one that never reported back is stopped.
    const clickStart = events.findIndex(
      (event) => event.kind === "tool_started" && (event.payload as unknown as Emitted).callId === "tc_click",
    );
    assert.ok(clickStart > 0);
    const upToClick = events.slice(0, clickStart + 1);
    const open = steps.deriveComputerSteps(upToClick, RUN).frames;
    assert.equal(open.at(-1)?.live, true);
    const stopped = steps.deriveComputerSteps(
      [...upToClick, { ...events[0]!, id: "evt_end", seq: 99, kind: "run_finished" as never, payload: { kind: "run_finished" } as never }],
      RUN,
    ).frames;
    assert.equal(stopped.at(-1)?.status, "interrupted");
    assert.match(stopped.at(-1)?.caption ?? "", /^Stopped — /);
  });

  it("deleting the run deletes its frames", async () => {
    const dir = path.dirname(frameFile(USER, RUN, "x"));
    assert.ok(readdirSync(dir).length > 0);
    const deleted = await frames.deleteRunFrames(RUN, USER, {
      events: async () => emitted.map((payload) => ({ kind: payload.kind, payload })),
    });
    assert.ok(deleted >= 3);
    assert.equal(existsSync(dir), false);
    const sessionRoute = source("src/app/api/work/sessions/[id]/route.ts");
    assert.match(sessionRoute, /deleteRunFrames\(run\.id, user\.id\)/, "the session's delete removes its runs' frames");
  });
});

describe("frames.ts", () => {
  it("caps a run's frames, keeps only JPEGs under safe refs, and zooms a region", async () => {
    const put: string[] = [];
    const recorder = frames.createRunFrameRecorder({
      userId: "u1",
      runId: "r1",
      max: 2,
      storage: { put: async (key) => void put.push(key), get: async () => null, remove: async () => {} },
    });
    const jpeg = await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    assert.ok(await recorder.store("a", { jpeg, width: 1280, height: 800 }));
    assert.ok(await recorder.store("a", { jpeg, width: 1280, height: 800 }), "the same step again is free");
    assert.ok(await recorder.store("b", { jpeg, width: 1280, height: 800 }));
    assert.equal(await recorder.store("c", { jpeg, width: 1280, height: 800 }), null, "over the cap");
    assert.equal(await recorder.store("../x", { jpeg, width: 1280, height: 800 }), null);
    assert.equal(await recorder.store("d", { jpeg: Buffer.from("<svg/>"), width: 1, height: 1 }), null);
    assert.deepEqual(put, ["computer-frames/u1/r1/a.jpg", "computer-frames/u1/r1/a.jpg", "computer-frames/u1/r1/b.jpg"]);
    assert.equal(frames.MAX_FRAMES_PER_RUN, 300);
    assert.throws(() => frames.frameStorageKey("u/1", "r1", "a"));
    assert.equal(frames.frameRefForCall("toolu_01:ab.c"), "toolu_01_ab_c");
    assert.equal(frames.frameRefForCall("call_9", "pre"), "call_9-pre");

    const zoomed = await frames.zoomFrame(jpeg, { x: 100, y: 50, width: 320, height: 200 }, { width: 1280, height: 800 });
    assert.deepEqual([zoomed.width, zoomed.height], [1280, 800]);
    const meta = await sharp(zoomed.jpeg).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [1280, 800, "jpeg"]);
  });

  it("the runner keeps frames through frames.ts and describes points when Chromium can", () => {
    const runner = source("scripts/work-runner.ts");
    assert.match(runner, /createRunFrameRecorder\(\{ userId: input\.userId, runId: input\.runId \}\)/);
    assert.match(runner, /storeFrame: \(ref, shot\) =>\s*stepFrames!\.store\(/);
    assert.match(runner, /hash: shot\.sha256/);
    // The computer's own browser, once a computer tool has started it (lazy start, run-tools.ts).
    assert.match(runner, /canDescribePoints\(computerBrowser\)/);
    assert.match(runner, /provider\.drag\(remote\.attachment\.handle, opts\)/);
    assert.match(runner, /zoomFrame\(shot\.jpeg, region, shot\)/);
  });

  it("the event contract reads the additive keys and nothing malformed", () => {
    assert.deepEqual(domain.readWorkToolPoint({ point: { x: 3, y: 4 } }), { x: 3, y: 4 });
    assert.equal(domain.readWorkToolPoint({ point: { x: "3", y: 4 } }), null);
    assert.equal(domain.readWorkToolPoint({}), null);
    assert.deepEqual(domain.readWorkToolFrame({ frame: { ref: "tc_1", width: 1280, height: 800 } }), { ref: "tc_1", width: 1280, height: 800 });
    assert.equal(domain.readWorkToolFrame({ frame: { ref: "../x", width: 1280, height: 800 } }), null);
    assert.equal(domain.readWorkToolFrame({ frame: { ref: "tc", width: 0, height: 800 } }), null);
    assert.deepEqual(domain.readWorkToolTiming({ settleMs: 120, captureMs: 40 }), { settleMs: 120, captureMs: 40 });
    assert.equal(domain.defaultVisibilityFor("tool_started"), "user");
    assert.equal(domain.defaultVisibilityFor("tool_finished"), "user");
    assert.equal(domain.workFramePath("run_1", "tc-pre"), "/api/work/runs/run_1/frames/tc-pre");
  });
});

// ---- (d) the timeline ------------------------------------------------------

describe("(d) ComputerTimeline motion and fallbacks", () => {
  it("crossfades on the motion tokens with no per-instance stylesheet, and drops transforms under reduced motion", () => {
    const component = source("src/components/code/computer-timeline.tsx");
    assert.doesNotMatch(component, /<style/);
    assert.doesNotMatch(component, /180ms|120ms/);
    // The frame crossfade is opacity, Tier A (spec §4.7): it keeps its timing
    // under reduced motion. Only the zoom (a transform) is motion-safe.
    assert.match(component, /"transition-opacity duration-base ease-out-soft"/);
    assert.doesNotMatch(component, /transition-opacity duration-base ease-out-soft motion-reduce:transition-none/);
    assert.match(component, /motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-150/);
    assert.match(component, /prefersReducedMotion\(\) \? "auto" : "smooth"/);
    assert.match(component, /unavailableLabel = "Screenshot unavailable"/);
  });

  it("renders given frames, the ring and the scrubber", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, s)).toISOString();
    const html = renderToStaticMarkup(
      React.createElement(timeline.ComputerTimeline, {
        frames: [
          { id: "1", callId: "c1", index: 0, action: "screenshot", caption: "Look at example.com", verb: "Look", src: "/api/work/runs/r/frames/c1", point: null, status: "completed", failed: false, live: false, createdAt: at(1) },
          { id: "2", callId: "c2", index: 1, action: "click", caption: "Click the “Sign in” button on example.com", verb: "Click", src: "/api/work/runs/r/frames/c2", point: { x: 0.25, y: 0.75 }, status: "running", failed: false, live: true, createdAt: at(2) },
        ],
        frameSize: { width: 1280, height: 800 },
        unavailableLabel: "Screenshot is on your Mac",
      }),
    );
    assert.match(html, /Click the “Sign in” button on example\.com/);
    assert.match(html, /left:25\.00%;top:75\.00%/);
    assert.match(html, /agent-coral/);
    assert.match(html, /type="range"/);
    assert.match(html, /\[&amp;::-webkit-slider-thumb\]:bg-foreground/, "the scrubber is styled by utilities");
    assert.match(html, /src="\/api\/work\/runs\/r\/frames\/c2"/);
    assert.match(html, /aria-label="Computer use steps"/);
  });
});

// ---- (e) approvals and semantic targets ---------------------------------------

describe("(e) approvals show the verb, the text and the marked screen", () => {
  it("computer actions have their own verbs", () => {
    assert.equal(verbs.actionVerb("work.computer.type").verb, "Type");
    assert.deepEqual(verbs.actionVerb("work.computer.type").bodyKeys, ["text"]);
    assert.equal(verbs.actionVerb("work.computer.type").bodyAs, "prose");
    assert.equal(verbs.actionVerb("work.computer.shell").verb, "Run");
    assert.equal(verbs.actionVerb("work.computer.shell").bodyAs, "command");
    assert.equal(verbs.actionVerb("work.computer.click").verb, "Click");
    assert.equal(verbs.actionVerb("work.computer.key").verb, "Press");
    // Still refused a standing allowance: these ask every time.
    assert.equal(verbs.mayStopAsking("work.computer.type", "sensitive"), false);
    assert.equal(verbs.mayBatchApprove("work.computer.shell", "sensitive"), false);
  });

  const card = (overrides: Record<string, unknown>) =>
    renderToStaticMarkup(
      React.createElement(approvalCard.ApprovalCard, {
        approval: {
          id: "run_1:tc",
          action: "work.computer.type",
          risk: "sensitive",
          summary: "Type 17 characters into the “Email” field on example.com",
          detail: {},
          actionDigest: "a".repeat(64),
          decision: "pending",
          decidedAt: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
          ...overrides,
        } as never,
        expired: false,
        busy: false,
        onDecide: () => {},
      }),
    );

  it("a typing approval shows Type, the text above the fold and the pre-action frame", () => {
    const html = card({
      detail: {
        text: "hello@example.com",
        intent: "screen.type",
        tier: "visual",
        frame: { ref: "tc-pre", width: 1280, height: 800, epoch: 3, src: "/api/work/runs/run_1/frames/tc-pre" },
      },
    });
    assert.match(html, />Type</, "the button carries the verb");
    assert.doesNotMatch(html, /Go ahead/);
    const text = html.indexOf("hello@example.com");
    assert.ok(text > 0 && text < html.indexOf("Exactly what will be done"), "the text is above the fold");
    assert.match(html, /<img src="\/api\/work\/runs\/run_1\/frames\/tc-pre"/);
    assert.match(html, /referrerPolicy="no-referrer"/);
  });

  it("a click approval crops around the point and marks it; foreign addresses are ignored", () => {
    const html = card({
      action: "work.computer.click",
      risk: "command",
      summary: "Click the “Sign in” button on example.com",
      detail: {
        point: { x: 640, y: 400 },
        frame: { ref: "tc-pre", width: 1280, height: 800, epoch: 3, src: "/api/work/runs/run_1/frames/tc-pre" },
      },
    });
    assert.match(html, />Click</);
    assert.match(html, /with the spot ringed/);
    assert.match(html, /style="width:200\.00%;left:-50\.00%;top:-50\.00%"/);
    assert.match(html, /style="left:50\.00%;top:50\.00%"/);

    const foreign = card({
      detail: { text: "x", frame: { ref: "tc", width: 1280, height: 800, src: "https://evil.example/pixel.gif" } },
    });
    assert.doesNotMatch(foreign, /evil\.example/);
    assert.equal(approvalFrame.readApprovalFrame({ frame: { src: "//evil.example/a", width: 1, height: 1 } }), null);

    // Near an edge the window stays inside the frame and the marker moves.
    const corner = approvalFrame.approvalCrop({ width: 1280, height: 800 }, { x: 10, y: 790 });
    assert.deepEqual(corner.image, { width: "200.00%", left: "0.00%", top: "-100.00%" });
    assert.deepEqual(corner.marker, { left: "1.56%", top: "97.50%" });
    assert.equal(approvalFrame.approvalCrop({ width: 1280, height: 800 }, null).marker, null);
  });

  it("the page describer finds the element under a screen point, only when Chromium is in front", () => {
    interface FakeEl {
      tagName: string;
      attrs: Record<string, string>;
      text?: string;
      parent?: FakeEl;
      labels?: Array<{ textContent: string }>;
      value?: string;
    }
    const element = (el: FakeEl): Record<string, unknown> => {
      const node: Record<string, unknown> = {
        tagName: el.tagName.toUpperCase(),
        getAttribute: (name: string) => el.attrs[name] ?? null,
        innerText: el.text ?? "",
        textContent: el.text ?? "",
        labels: el.labels,
        value: el.value,
        isContentEditable: false,
      };
      node.closest = () => (["a", "button", "input"].includes(el.tagName) ? node : el.parent ? element(el.parent) : null);
      return node;
    };
    const button: FakeEl = { tagName: "button", attrs: {}, text: "  Sign\n in " };
    const span: FakeEl = { tagName: "span", attrs: {}, text: "Sign in", parent: button };
    const password: FakeEl = { tagName: "input", attrs: { type: "password", "aria-label": "Password" }, value: "hunter2" };
    const make = (opts: { focus?: boolean; active?: FakeEl; hit?: FakeEl | "iframe" }) => {
      const seen: Array<[number, number]> = [];
      const doc = {
        hasFocus: () => opts.focus !== false,
        visibilityState: "visible",
        body: {},
        documentElement: {},
        activeElement: opts.active ? element(opts.active) : null,
        getElementById: () => null,
        elementFromPoint: (x: number, y: number) => {
          seen.push([x, y]);
          if (opts.hit === "iframe") return element({ tagName: "iframe", attrs: {} });
          return opts.hit ? element(opts.hit) : null;
        },
      };
      // A 1280x800 desktop with Chromium maximised and an 80px toolbar.
      const win = { devicePixelRatio: 1, screenX: 0, screenY: 0, outerWidth: 1280, innerWidth: 1280, outerHeight: 800, innerHeight: 720 };
      const run = new Function("window", "document", "location", `return ${remoteBrowser.DESCRIBE_TARGET_SCRIPT};`)(
        win,
        doc,
        { hostname: "example.com" },
      ) as (arg: { x: number; y: number } | null) => unknown;
      return { run, seen };
    };

    const front = make({ hit: span });
    assert.deepEqual(remoteBrowser.readPageTarget(front.run({ x: 640, y: 400 })), { role: "button", name: "Sign in", host: "example.com" });
    assert.deepEqual(front.seen, [[640, 320]], "screen point moved below the toolbar");
    assert.equal(make({ hit: span }).run({ x: 640, y: 40 }), null, "a point on the toolbar is not on the page");
    assert.equal(make({ hit: span, focus: false }).run({ x: 640, y: 400 }), null, "Chromium is not in front");
    assert.equal(make({ hit: "iframe" }).run({ x: 640, y: 400 }), null, "a frame is not described");

    const focused = make({ active: password }).run(null);
    assert.deepEqual(remoteBrowser.readPageTarget(focused), { role: "password", name: "Password", host: "example.com" });
    assert.doesNotMatch(JSON.stringify(focused), /hunter2/, "a field's value never becomes a name");

    assert.equal(remoteBrowser.readPageTarget({ role: "button<script>", name: "x", host: "example.com" }), null);
    assert.equal(remoteBrowser.readPageTarget({ role: "button", name: "x", host: "evil example" }), null);
    assert.equal(remoteBrowser.canDescribePoints({ describePoint: async () => null, describeFocus: async () => null }), true);
    assert.equal(remoteBrowser.canDescribePoints({}), false);

    // An editable region's text is what someone typed, never its name.
    const draft = element({ tagName: "div", attrs: { "aria-label": "Message body" }, text: "my account number is 12345678" });
    draft.isContentEditable = true;
    const editor = new Function("window", "document", "location", `return ${remoteBrowser.DESCRIBE_TARGET_SCRIPT};`)(
      { devicePixelRatio: 1, screenX: 0, screenY: 0, outerWidth: 1280, innerWidth: 1280, outerHeight: 800, innerHeight: 720 },
      {
        hasFocus: () => true,
        visibilityState: "visible",
        body: {},
        documentElement: {},
        activeElement: draft,
        getElementById: () => null,
        elementFromPoint: () => null,
      },
      { hostname: "mail.example.com" },
    ) as (arg: null) => unknown;
    const named = remoteBrowser.readPageTarget(editor(null));
    assert.deepEqual(named, { role: "textbox", name: "Message body", host: "mail.example.com" });
    assert.doesNotMatch(JSON.stringify(named), /12345678/, "a draft's contents never become a name");
  });

  it("the site in a semantic sentence is the browser's own record of the tab, never the page's word", async () => {
    // A hostile page can answer anything from its own JavaScript world, the
    // host included (it only has to replace `String`). The tab's address is
    // the browser's, so that is the host the sentence uses.
    const tab = (url: string, answer: unknown, closed = false) => ({
      isClosed: () => closed,
      url: () => url,
      evaluate: async () => answer,
    });
    const lying = tab("https://evil.example/pay", { role: "button", name: "Cancel", host: "accounts.google.com" });
    assert.deepEqual(await remoteBrowser.describeAcrossPages([lying], { x: 1, y: 1 }), {
      role: "button",
      name: "Cancel",
      host: "evil.example",
    });
    // No web address, no description: about:blank, chrome:// and data: pages fall back to coordinates.
    for (const url of ["about:blank", "chrome://settings", "data:text/html,hi"]) {
      assert.equal(await remoteBrowser.describeAcrossPages([tab(url, { role: "button", name: "OK", host: "example.com" })], null), null);
    }
    // A closed or throwing tab is skipped and the next one answers.
    const throwing = { isClosed: () => false, url: () => "https://a.example/", evaluate: async () => { throw new Error("navigating"); } };
    const next = tab("https://b.example/", { role: "link", name: "Docs", host: "b.example" });
    assert.deepEqual(await remoteBrowser.describeAcrossPages([tab("https://c.example/", null, true), throwing, next], null), {
      role: "link",
      name: "Docs",
      host: "b.example",
    });
  });
});
