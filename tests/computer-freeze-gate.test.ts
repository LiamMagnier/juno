import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/*
 * A take over's freeze holds this process's own agent launches until it settles
 * (src/lib/computer/docker.ts, `freezing`). The freeze stops every agent-uid task
 * and rescans until none runs; a launch landing during the scan is one more task,
 * and a steady stream of them (tests/computer-real-e2e.test.ts, 12) kept the scan
 * from coming up empty, so the take over told the person the agent could not be
 * paused. Held, a launch runs once the freeze has returned, and the launcher
 * refuses it on the frozen marker.
 *
 * Drives the real DockerProvider against a stand-in `docker` that records when
 * each call starts and ends, with a slow `agent-exec freeze`, and the real
 * RemoteProvider against a stand-in computer host with a slow freeze.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const remote = req("../src/lib/computer/remote") as typeof import("@/lib/computer/remote");

const env = process.env as Record<string, string | undefined>;
const saved = { PATH: env.PATH, NODE_ENV: env.NODE_ENV };
let dir = "";
let log = "";

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "juno-freeze-gate-"));
  log = path.join(dir, "calls.jsonl");
  const fake = path.join(dir, "docker");
  writeFileSync(
    fake,
    `#!/usr/bin/env python3
import json, sys, time
argv = sys.argv[1:]
started = time.time()
if "freeze" in argv:
    time.sleep(0.6)
with open(${JSON.stringify(log)}, "a") as f:
    f.write(json.dumps({"argv": argv, "start": started, "end": time.time()}) + "\\n")
`,
  );
  chmodSync(fake, 0o755);
  env.PATH = `${dir}:${env.PATH ?? "/usr/bin:/bin"}`;
  env.NODE_ENV = "test";
});

after(() => {
  env.PATH = saved.PATH;
  env.NODE_ENV = saved.NODE_ENV;
  rmSync(dir, { recursive: true, force: true });
});

type Call = { argv: string[]; start: number; end: number };
const calls = (): Call[] =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);

test("only an agent-uid launch through the launcher is held, and never the freeze's own", () => {
  const launch = docker.agentExecArgv("juno-agent-a", "run", ["true"]);
  assert.equal(docker.agentLaunchContainer(launch), "juno-agent-a");
  assert.equal(docker.agentLaunchContainer(docker.agentExecArgv("juno-agent-a", "helper", ["du", "-sm", "/home/agent"])), "juno-agent-a");
  assert.equal(docker.agentLaunchContainer(docker.agentExecArgv("juno-agent-a", "run", ["true"], { interactive: true, workdir: "/home/agent/work" })), "juno-agent-a");
  assert.equal(docker.agentLaunchContainer(["exec", "--user", "1000", "juno-agent-a", docker.AGENT_LAUNCHER, "freeze"]), null);
  assert.equal(docker.agentLaunchContainer(["exec", "--user", "1000", "juno-agent-a", docker.AGENT_LAUNCHER, "thaw"]), null);
  assert.equal(docker.agentLaunchContainer(["exec", "--user", "1001", "juno-agent-a", "touch", "/run/juno-state/frozen"]), null);
  assert.equal(docker.agentLaunchContainer(["inspect", "juno-agent-a"]), null);
});

test("a launch asked for during a freeze runs only after the freeze returns; another computer's does not wait", async () => {
  const provider = new docker.DockerProvider();
  const held = { name: "juno-agent-held", volume: "v1" };
  const other = { name: "juno-agent-other", volume: "v2" };
  const freezing = provider.freezeAgent(held);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [frozenAt, heldLaunch, otherLaunch] = await Promise.all([
    freezing.then(() => Date.now() / 1000),
    provider.exec(held, "true").then(() => calls().find((call) => call.argv.includes(held.name) && call.argv.includes("run"))!),
    provider.exec(other, "true").then(() => calls().find((call) => call.argv.includes(other.name))!),
  ]);
  const freezeStep = calls().find((call) => call.argv.includes("freeze"))!;
  assert.ok(freezeStep, "the freeze ran its stop step");
  assert.ok(heldLaunch.start >= freezeStep.end, "the held launch started after the stop step ended");
  assert.ok(heldLaunch.start <= frozenAt + 1, "and soon after the freeze returned");
  assert.ok(otherLaunch.start < freezeStep.end, "another computer's launch was not held");
});

test("a host call is held only when it acts on that computer, and never the freeze or thaw", () => {
  assert.equal(remote.heldComputer("/v1/computers/juno-agent-a/exec"), "juno-agent-a");
  assert.equal(remote.heldComputer("/v1/computers/juno-agent-a/files-content"), "juno-agent-a");
  assert.equal(remote.heldComputer("/v1/computers/juno-agent-a"), "juno-agent-a");
  assert.equal(remote.heldComputer("/v1/computers/juno-agent-a/freeze"), null);
  assert.equal(remote.heldComputer("/v1/computers/juno-agent-a/thaw"), null);
  assert.equal(remote.heldComputer("/v1/available"), null);
});

test("on a computer host, an exec asked for during a freeze is sent only after the freeze answers", async () => {
  const sent: Array<{ action: string; at: number }> = [];
  let freezeAnsweredAt = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const action = url.pathname.split("/").pop() ?? "";
    sent.push({ action, at: Date.now() });
    if (action === "freeze") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      freezeAnsweredAt = Date.now();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ stdout: "", stderr: "frozen\n", exitCode: 75, timedOut: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const provider = new remote.RemoteComputerProvider({ origin: "http://127.0.0.1:1", token: "t", fetchImpl });
  const handle = { name: "juno-agent-held", volume: "v" };
  const freezing = provider.freezeAgent(handle);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all([freezing, provider.exec(handle, "true")]);
  const exec = sent.find((call) => call.action === "exec")!;
  assert.ok(exec, "the exec was sent");
  assert.ok(exec.at >= freezeAnsweredAt, "the exec went out after the freeze answered");
});
