import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The production Docker broker must accept every command the provider sends.
 *
 * In production every Docker call goes through `sudo -n juno-computer-docker-
 * broker` (src/lib/docker-cli.ts), a root-owned validator. The broker was
 * tested with hand-written argv only, and it refused three shapes the provider
 * really sends: labelled `volume create` (so no computer could be created),
 * `exec --workdir` (so the shell tool always failed) and the `ps` / `volume ls`
 * listings (so nothing reconciled orphans). Whoever enabled the feature would
 * have found it broken, and the quick workaround — the docker group or a wider
 * sudo rule — makes the Node app root-equivalent again.
 *
 * So this drives the REAL DockerProvider with NODE_ENV=production against a
 * stand-in `sudo` that records each argv the broker would receive, then feeds
 * every one of them to the broker's own validate() with a production-shaped
 * policy. They cannot drift apart again without this failing.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const docker = req("../src/lib/computer/docker") as typeof import("@/lib/computer/docker");

const env = process.env as Record<string, string | undefined>;
let dir = "";
let log = "";
const saved = { PATH: env.PATH, NODE_ENV: env.NODE_ENV, MIN_DISK: env.AGENT_COMPUTER_MIN_FREE_DISK_MB, MIN_MEM: env.COMPUTER_MIN_FREE_MEMORY_MB };

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "juno-broker-argv-"));
  log = path.join(dir, "argv.jsonl");
  // `sudo -n /usr/local/sbin/juno-computer-docker-broker <argv...>`: record the
  // argv, drain stdin, and answer the few reads the provider parses.
  const sudo = path.join(dir, "sudo");
  writeFileSync(
    sudo,
    `#!/usr/bin/env python3
import json, sys
argv = sys.argv[3:]
with open(${JSON.stringify(log)}, "a") as f:
    f.write(json.dumps(argv) + "\\n")
if "-i" in argv[:2]:
    sys.stdin.read()
if argv[:2] == ["image", "inspect"] and argv[3] == "{{.Id}}":
    print("sha256:current")
elif argv[:2] == ["image", "inspect"] and argv[3].startswith("{{.Id}}"):
    print("sha256:current\t${docker.COMPUTER_IMAGE_SECURITY_LABEL}\t2026-10-28T00:00:00Z")
elif argv[:2] == ["image", "inspect"]:
    print("${docker.COMPUTER_IMAGE_SECURITY_LABEL}")
elif argv[:1] == ["inspect"] and "{{.Image}}" in argv:
    print("sha256:older")
elif "cat" in argv and "/run/juno-state/browser-sandbox" in argv:
    print("on")
elif "unshare" in argv:
    print("unshare: unshare failed: Operation not permitted", file=sys.stderr)
    sys.exit(1)
elif "realpath" in argv:
    print(argv[-1])
elif argv[:1] == ["inspect"] and "{{.State.Status}}" in argv:
    print("running")
elif argv[:1] == ["inspect"]:
    print("172.30.0.9")
elif "test" in argv and "-e" in argv:
    sys.exit(1)
elif "du" in argv:
    print("12\\t/home/agent")
elif "stat" in argv:
    print("3:regular file")
`
  );
  chmodSync(sudo, 0o755);
  env.PATH = `${dir}:${env.PATH ?? "/usr/bin:/bin"}`;
  env.AGENT_COMPUTER_MIN_FREE_DISK_MB = "0";
  env.COMPUTER_MIN_FREE_MEMORY_MB = "0";
});

after(() => {
  env.PATH = saved.PATH;
  env.NODE_ENV = saved.NODE_ENV;
  env.AGENT_COMPUTER_MIN_FREE_DISK_MB = saved.MIN_DISK;
  env.COMPUTER_MIN_FREE_MEMORY_MB = saved.MIN_MEM;
  rmSync(dir, { recursive: true, force: true });
});

test("every docker argv the production provider sends is one the broker accepts", async () => {
  env.NODE_ENV = "production";
  const provider = new docker.DockerProvider();
  const handle = await provider.create({ agentId: "cmagent123", userId: "cmuser456", cdpToken: "t" });
  await provider.start(handle);
  await provider.provisionCdpToken(handle, "token-value");
  await provider.state(handle);
  await provider.endpoints(handle);
  await provider.click(handle, { x: 1, y: 2 });
  await provider.click(handle, { x: 1, y: 2, button: "double" });
  await provider.type(handle, "hello");
  await provider.key(handle, "ctrl+l");
  await provider.scroll(handle, { x: 1, y: 2, dy: -3 });
  await provider.drag(handle, { x1: 1, y1: 2, x2: 3, y2: 4 });
  await provider.exec(handle, "pwd");
  await provider.exec(handle, "ls", { cwd: "/home/agent/work/project" });
  await provider.listFiles(handle);
  await provider.writeFile(handle, "/home/agent/work/notes.txt", "hi");
  await provider.writeFile(handle, "/home/agent/work/inbox/upload.bin", Buffer.from([0, 1, 2]), { by: "person" });
  await provider.fileInfo(handle, "/home/agent/work/notes.txt");
  await provider.diskUsageMb(handle);
  await provider.startVnc(handle, { controlPassword: "abcdefgh", viewPassword: "ijklmnop" });
  await provider.isVncRunning(handle);
  await provider.stopVnc(handle);
  await provider.freezeAgent(handle);
  await provider.thawAgent(handle);
  assert.equal(await provider.browserSandbox(handle), "on");
  assert.equal(await provider.isOutdated(handle), true);
  assert.equal((await provider.imageInfo()).label, docker.COMPUTER_IMAGE_SECURITY_LABEL);
  await provider.pause(handle);
  await provider.unpause(handle);
  await provider.listOwned();
  await provider.stop(handle);
  await provider.destroy(handle, { removeVolume: true });
  env.NODE_ENV = saved.NODE_ENV;

  const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const kinds = new Set(sent.map((argv) => (argv[0] === "volume" || argv[0] === "image" ? `${argv[0]} ${argv[1]}` : argv[0])));
  for (const kind of ["image inspect", "volume create", "create", "start", "exec", "inspect", "pause", "unpause", "ps", "volume ls", "stop", "rm", "volume rm"]) {
    assert.ok(kinds.has(kind), `the provider never sent ${kind}; the cross-check would be vacuous for it`);
  }
  assert.ok(sent.some((argv) => argv.includes("--workdir")), "exec with a working directory was exercised");
  // pipe-v4: every exec as the agent's uid starts through the launcher, and
  // every launcher mode the provider uses was exercised (so the broker saw it).
  const agentExecs = sent.filter((argv) => argv[0] === "exec" && argv.includes("--user") && argv[argv.indexOf("--user") + 1] === "1000");
  assert.ok(agentExecs.length > 10);
  for (const argv of agentExecs) {
    const at = argv.indexOf(docker.AGENT_LAUNCHER);
    assert.ok(at > 0 && /^juno-agent-/.test(argv[at - 1]), `an agent exec without the launcher: ${JSON.stringify(argv)}`);
  }
  const modes = new Set(agentExecs.map((argv) => argv[argv.indexOf(docker.AGENT_LAUNCHER) + 1]));
  assert.deepEqual([...modes].sort(), ["freeze", "helper", "run", "thaw"]);
  const shell = agentExecs.find((argv) => argv.includes("bash"));
  assert.deepEqual(shell?.slice(shell.indexOf("bash")), ["bash", "--noprofile", "--norc", "-c", "pwd"], "no login or rc file runs");
  const create = sent.find((argv) => argv[0] === "create");
  assert.deepEqual(create?.slice(create.indexOf("--dns"), create.indexOf("--dns") + 2), ["--dns", "192.0.2.53"]);
  assert.equal(create?.filter((value) => value === "--dns").length, 1, "one DNS server, the RFC 5737 sentinel");
  assert.ok(create?.includes(docker.COMPUTER_STATE_TMPFS));
  const vnc = sent.find((argv) => argv.includes("x11vnc") && argv.includes("-rfbport"));
  assert.deepEqual(vnc?.slice(vnc.indexOf("-allow"), vnc.indexOf("-allow") + 2), ["-allow", "172.30.0.1"]);
  assert.ok(sent.some((argv) => argv.includes("pgrep") && argv[argv.indexOf("--user") + 1] === "1001"), "isVncRunning runs as the browser uid");

  const policy = { image: "juno-computer:1", network: "juno-computers", maxMemoryMb: 2048, maxCpus: 2 };
  const check = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)
policy = json.loads(sys.argv[2])
refused = []
for line in open(sys.argv[3]):
    argv = json.loads(line)
    try:
        broker.validate(argv, policy)
    except Exception as error:
        refused.append({"argv": argv, "error": str(error)})
print(json.dumps(refused))`,
      path.join(ROOT, "deploy/agent-computers/docker-broker.py"),
      JSON.stringify(policy),
      log,
    ],
    { encoding: "utf8" }
  );
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), [], "the broker refused commands the provider sends");
});

/** Feeds argv lists to the broker's validate() under a policy; returns the refusals. */
function brokerRefusals(argvs: string[][], policy: Record<string, unknown>): Array<{ argv: string[]; error: string }> {
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
      JSON.stringify(argvs),
    ],
    { encoding: "utf8" }
  );
  assert.equal(check.status, 0, check.stderr);
  return JSON.parse(check.stdout) as Array<{ argv: string[]; error: string }>;
}

const BASE_POLICY = { image: "juno-computer:1", network: "juno-computers", maxMemoryMb: 2048, maxCpus: 2 };

test("a uid-1000 exec without the launcher, or with an unknown mode, is refused", () => {
  const refused = brokerRefusals(
    [
      ["exec", "--user", "1000", "juno-agent-a", "bash", "-c", "id"],
      ["exec", "--user", "1000", "-e", "DISPLAY=:0", "juno-agent-a", "xdotool", "type", "x"],
      ["exec", "-i", "--user", "1000", "juno-agent-a", "sh", "-c", "cat > x"],
      ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "shell", "--", "id"],
      ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "run", "id"],
      ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "run", "--"],
      ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "freeze", "now"],
      ["exec", "--user", "1000", "juno-agent-a", "/tmp/agent-exec", "run", "--", "id"],
    ],
    BASE_POLICY
  );
  assert.equal(refused.length, 8, JSON.stringify(refused));
  assert.deepEqual(
    brokerRefusals(
      [
        docker.agentExecArgv("juno-agent-a", "run", ["id"]),
        docker.agentExecArgv("juno-agent-a", "helper", ["du", "-sm", "/home/agent"]),
        docker.agentExecArgv("juno-agent-a", "run", ["sh", "-c", 'cat > "$1"', "sh", "/home/agent/work/x"], { interactive: true }),
        docker.agentExecArgv("juno-agent-a", "run", ["true"], { workdir: "/home/agent/work" }),
        ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "freeze"],
        ["exec", "--user", "1000", "juno-agent-a", "/opt/juno/agent-exec", "thaw"],
      ],
      BASE_POLICY
    ),
    []
  );
});

test("the seccomp profile is in the create argv exactly when the broker's policy turns the browser sandbox on", () => {
  const profile = "/etc/juno/computer-seccomp.json";
  const withProfile = docker.buildDockerCreateArgv({ agentId: "a", userId: "u", platform: "linux", nodeEnv: "production", seccompProfile: profile });
  const without = docker.buildDockerCreateArgv({ agentId: "a", userId: "u", platform: "linux", nodeEnv: "production", seccompProfile: null });
  assert.deepEqual(withProfile.filter((_, i) => withProfile[i - 1] === "--security-opt"), ["no-new-privileges", `seccomp=${profile}`]);
  assert.deepEqual(without.filter((_, i) => without[i - 1] === "--security-opt"), ["no-new-privileges"]);
  const sandboxPolicy = { ...BASE_POLICY, browserSandbox: true, seccompProfile: profile };
  assert.deepEqual(brokerRefusals([withProfile], sandboxPolicy), []);
  assert.deepEqual(brokerRefusals([without], BASE_POLICY), []);
  // Each argv is refused under the other policy: they cannot disagree silently.
  assert.equal(brokerRefusals([without], sandboxPolicy).length, 1);
  assert.equal(brokerRefusals([withProfile], BASE_POLICY).length, 1);
  assert.equal(brokerRefusals([withProfile], { ...sandboxPolicy, seccompProfile: "relative.json" }).length, 1);
  // The provider reads the same policy file the broker does.
  assert.equal(docker.seccompProfileFromPolicy(sandboxPolicy), profile);
  assert.equal(docker.seccompProfileFromPolicy({ ...sandboxPolicy, browserSandbox: "true" }), null);
  assert.equal(docker.seccompProfileFromPolicy(BASE_POLICY), null);
  assert.equal(docker.computerSeccompProfile("production", () => JSON.stringify(sandboxPolicy)), profile);
  assert.equal(docker.computerSeccompProfile("production", () => { throw new Error("no policy file"); }), null);
});

test("the image and container inspect formats the provider sends are the broker's, and no others", () => {
  assert.deepEqual(
    brokerRefusals(
      [
        ["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', "juno-computer:1"],
        ["image", "inspect", "--format", "{{.Id}}", "juno-computer:1"],
        ["image", "inspect", "--format", docker.IMAGE_INFO_FORMAT, "juno-computer:1"],
        ["inspect", "-f", "{{.Image}}", "juno-agent-a"],
      ],
      BASE_POLICY
    ),
    []
  );
  assert.equal(
    brokerRefusals(
      [
        ["image", "inspect", "--format", "{{json .}}", "juno-computer:1"],
        ["image", "inspect", "--format", "{{.Id}}", "other:1"],
        ["inspect", "-f", "{{.Config.Env}}", "juno-agent-a"],
        ["inspect", "-f", "{{.HostConfig.SecurityOpt}}", "juno-agent-a"],
      ],
      BASE_POLICY
    ).length,
    4
  );
});
