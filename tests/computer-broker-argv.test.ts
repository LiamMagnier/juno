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
if argv[:2] == ["image", "inspect"]:
    print("${docker.COMPUTER_IMAGE_SECURITY_LABEL}")
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
  await provider.fileInfo(handle, "/home/agent/work/notes.txt");
  await provider.diskUsageMb(handle);
  await provider.startVnc(handle, { controlPassword: "abcdefgh", viewPassword: "ijklmnop" });
  await provider.isVncRunning(handle);
  await provider.stopVnc(handle);
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
