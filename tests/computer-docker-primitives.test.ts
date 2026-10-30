import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

/*
 * The take-over and image primitives of the Docker provider (pipe-v4,
 * docs/design/agents-v2/COMPUTERS_2026-10.md S2.3-S2.4), driven through the
 * production path: NODE_ENV=production, so every call goes to `sudo -n
 * <broker> <argv>`, and a stand-in `sudo` records each argv and answers from a
 * small rule table. tests/computer-broker-argv.test.ts holds the same argv to
 * the broker's validate(); tests/test_computer_boundary.py proves the effects
 * on a real container.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");

interface Rule {
  /** Every token must appear in the argv for the rule to answer. */
  match: string[];
  exit?: number;
  stdout?: string;
  stderr?: string;
}

const env = process.env as Record<string, string | undefined>;
const saved = { PATH: env.PATH, NODE_ENV: env.NODE_ENV, RULES: env.JUNO_FAKE_BROKER_RULES };
let dir = "";
let log = "";
let rules = "";

function answer(table: Rule[]): void {
  writeFileSync(rules, JSON.stringify(table));
  writeFileSync(log, "");
}

function sent(): string[][] {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "juno-docker-primitives-"));
  log = path.join(dir, "argv.jsonl");
  rules = path.join(dir, "rules.json");
  const sudo = path.join(dir, "sudo");
  writeFileSync(
    sudo,
    `#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[3:]
with open(${JSON.stringify(log)}, "a") as f:
    f.write(json.dumps(argv) + "\\n")
if "-i" in argv[:2]:
    sys.stdin.read()
for rule in json.load(open(os.environ["JUNO_FAKE_BROKER_RULES"])):
    if all(token in argv for token in rule["match"]):
        sys.stdout.write(rule.get("stdout", ""))
        sys.stderr.write(rule.get("stderr", ""))
        sys.exit(rule.get("exit", 0))
`
  );
  chmodSync(sudo, 0o755);
  env.PATH = `${dir}:${env.PATH ?? "/usr/bin:/bin"}`;
  env.JUNO_FAKE_BROKER_RULES = rules;
});

beforeEach(() => {
  env.NODE_ENV = "production";
  answer([]);
});

after(() => {
  env.PATH = saved.PATH;
  env.NODE_ENV = saved.NODE_ENV;
  env.JUNO_FAKE_BROKER_RULES = saved.RULES;
  rmSync(dir, { recursive: true, force: true });
});

const handle = { name: "juno-agent-prim", volume: "juno-agent-prim" };

test("freezeAgent writes the marker, stops the agent, cuts its X clients and releases every held key and button, in that order", async () => {
  await new docker.DockerProvider().freezeAgent(handle);
  assert.deepEqual(sent(), [
    ["exec", "--user", "1001", "juno-agent-prim", "touch", "/run/juno-state/frozen"],
    ["exec", "--user", "1000", "juno-agent-prim", "/opt/juno/agent-exec", "freeze"],
    ["exec", "--user", "1001", "-e", "DISPLAY=:0", "juno-agent-prim", "python3", "-I", "/opt/juno/x-clients.py", "close-uid", "1000"],
    ["exec", "--user", "1001", "-e", "DISPLAY=:0", "juno-agent-prim", "python3", "-I", "/opt/juno/x-clients.py", "release-all"],
  ]);
});

test("a freeze that leaves a task running still runs every step, then throws", async () => {
  answer([{ match: ["freeze"], exit: 3, stderr: "agent-exec: 1 task(s) still running after the freeze" }]);
  await assert.rejects(new docker.DockerProvider().freezeAgent(handle), (error: unknown) => {
    assert.ok(error instanceof errors.ComputerError);
    assert.doesNotMatch(error.message, /juno-agent|task/, "the public sentence names nothing");
    return true;
  });
  assert.equal(sent().length, 4, "the X clients are cut and the keys released even so");
});

test("thawAgent removes the marker first, then resumes the agent", async () => {
  await new docker.DockerProvider().thawAgent(handle);
  assert.deepEqual(sent(), [
    ["exec", "--user", "1001", "juno-agent-prim", "rm", "-f", "/run/juno-state/frozen"],
    ["exec", "--user", "1000", "juno-agent-prim", "/opt/juno/agent-exec", "thaw"],
  ]);
});

test("browserSandbox is on only when the gate says on and the agent's own namespace probe fails", async () => {
  const provider = new docker.DockerProvider();
  const refused = { match: ["unshare"], exit: 1, stderr: "unshare: unshare failed: Operation not permitted\n" };
  answer([{ match: ["cat"], stdout: "on\n" }, refused]);
  assert.equal(await provider.browserSandbox(handle), "on");
  assert.deepEqual(sent(), [
    ["exec", "--user", "1001", "juno-agent-prim", "cat", "/run/juno-state/browser-sandbox"],
    ["exec", "--user", "1000", "juno-agent-prim", "/opt/juno/agent-exec", "helper", "--", "unshare", "-Ur", "true"],
  ]);
  answer([{ match: ["cat"], stdout: "off:kernel\n" }, refused]);
  assert.equal(await provider.browserSandbox(handle), "off");
  answer([{ match: ["cat"], exit: 1, stderr: "cat: /run/juno-state/browser-sandbox: No such file or directory" }, refused]);
  assert.equal(await provider.browserSandbox(handle), "unknown");
  // The probe failed for another reason: the ban is not confirmed, so not "on".
  answer([{ match: ["cat"], stdout: "on\n" }, { match: ["unshare"], exit: 126, stderr: "something else" }]);
  assert.equal(await provider.browserSandbox(handle), "off");
});

test("browserSandbox throws when the agent CAN create a user namespace", async () => {
  answer([{ match: ["cat"], stdout: "on\n" }, { match: ["unshare"], exit: 0 }]);
  await assert.rejects(new docker.DockerProvider().browserSandbox(handle), (error: unknown) => {
    assert.ok(error instanceof errors.ComputerError);
    assert.equal(error.message, docker.COMPUTER_SAFETY_CHECK_FAILED);
    return true;
  });
});

test("isOutdated compares the container's image id with the current tag's, and imageInfo reads the label and build time", async () => {
  const provider = new docker.DockerProvider();
  answer([
    { match: ["inspect", "{{.Image}}"], stdout: "sha256:aaa\n" },
    { match: ["image", "{{.Id}}"], stdout: "sha256:bbb\n" },
  ]);
  assert.equal(await provider.isOutdated(handle), true);
  answer([
    { match: ["inspect", "{{.Image}}"], stdout: "sha256:bbb\n" },
    { match: ["image", "{{.Id}}"], stdout: "sha256:bbb\n" },
  ]);
  assert.equal(await provider.isOutdated(handle), false);
  assert.deepEqual(sent(), [
    ["inspect", "-f", "{{.Image}}", "juno-agent-prim"],
    ["image", "inspect", "--format", "{{.Id}}", "juno-computer:1"],
  ]);
  answer([{ match: ["image", docker.IMAGE_INFO_FORMAT], stdout: "sha256:bbb\tpipe-v4\t2026-10-28T00:00:00Z\n" }]);
  assert.deepEqual(await provider.imageInfo(), { id: "sha256:bbb", label: "pipe-v4", createdAt: "2026-10-28T00:00:00Z" });
});

test("state() returns missing only for a missing container and throws for a daemon error", async () => {
  const provider = new docker.DockerProvider();
  answer([{ match: ["inspect"], exit: 3, stderr: "computer broker refused request: missing (No such container)\n" }]);
  assert.equal(await provider.state(handle), "missing");
  answer([{ match: ["inspect"], exit: 1, stderr: "Error: No such object: juno-agent-prim\n" }]);
  assert.equal(await provider.state(handle), "missing", "the daemon's own words, as in development");
  answer([{ match: ["inspect"], exit: 1, stderr: "computer broker refused request: Container could not be inspected\n" }]);
  await assert.rejects(provider.state(handle), (error: unknown) => {
    assert.ok(error instanceof errors.ComputerError);
    assert.equal(error.message, errors.COMPUTER_UNREACHABLE);
    return true;
  });
  answer([{ match: ["inspect"], exit: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n" }]);
  await assert.rejects(provider.state(handle), /could not reach/);
  answer([{ match: ["inspect"], stdout: "paused\n" }]);
  assert.equal(await provider.state(handle), "paused");
});

test("destroy treats a missing container as done and anything else as a failure", async () => {
  const provider = new docker.DockerProvider();
  answer([{ match: ["rm"], exit: 3, stderr: "computer broker refused request: missing (No such container)\n" }]);
  await provider.destroy(handle, { removeVolume: true });
  answer([{ match: ["rm"], exit: 1, stderr: "computer broker refused request: Container could not be inspected\n" }]);
  await assert.rejects(provider.destroy(handle));
});

test("the shell runs through the launcher with no login or rc file, and a frozen refusal comes back as exit 75", async () => {
  const provider = new docker.DockerProvider();
  answer([
    { match: ["realpath"], stdout: "/home/agent/work/project\n" },
    { match: ["bash"], exit: 75, stderr: "frozen\n" },
  ]);
  const result = await provider.exec(handle, "echo $(id)", { cwd: "project", timeoutSeconds: 9 });
  assert.equal(result.exitCode, docker.AGENT_FROZEN_EXIT);
  const shell = sent().find((argv) => argv.includes("bash"));
  assert.deepEqual(shell, [
    "exec", "--user", "1000", "--workdir", "/home/agent/work/project", "juno-agent-prim",
    "/opt/juno/agent-exec", "run", "--",
    "timeout", "--signal=TERM", "--kill-after=5", "9", "bash", "--noprofile", "--norc", "-c", "echo $(id)",
  ]);
  const realpath = sent().find((argv) => argv.includes("realpath"));
  assert.deepEqual(realpath?.slice(4, 7), ["/opt/juno/agent-exec", "helper", "--"], "path checks are helpers");
});

test("the person's upload is a helper, the agent's own write is model-driven work", async () => {
  const provider = new docker.DockerProvider();
  answer([{ match: ["realpath"], stdout: "/home/agent/work/inbox/a.bin\n" }]);
  await provider.writeFile(handle, "inbox/a.bin", Buffer.from([0, 255]), { by: "person" });
  await provider.writeFile(handle, "inbox/a.bin", "text");
  const writes = sent().filter((argv) => argv.includes("mkdir") || argv.includes("-i"));
  assert.deepEqual(
    writes.map((argv) => argv[argv.indexOf("/opt/juno/agent-exec") + 1]),
    ["helper", "helper", "run", "run"]
  );
});

test("the seccomp profile comes from the broker's policy in production and from the test variable elsewhere", () => {
  const before = env.JUNO_COMPUTER_SECCOMP_PROFILE;
  try {
    env.JUNO_COMPUTER_SECCOMP_PROFILE = "/repo/deploy/agent-computers/seccomp-chromium.json";
    assert.equal(docker.computerSeccompProfile("development"), "/repo/deploy/agent-computers/seccomp-chromium.json");
    assert.equal(docker.computerSeccompProfile("production", () => "{}"), null, "production never reads the test variable");
    env.JUNO_COMPUTER_SECCOMP_PROFILE = "relative.json";
    assert.equal(docker.computerSeccompProfile("development"), null);
    delete env.JUNO_COMPUTER_SECCOMP_PROFILE;
    assert.equal(docker.computerSeccompProfile("development"), null, "unset: Docker's default, as pipe-v3");
  } finally {
    if (before === undefined) delete env.JUNO_COMPUTER_SECCOMP_PROFILE;
    else env.JUNO_COMPUTER_SECCOMP_PROFILE = before;
  }
});
