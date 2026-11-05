import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * A separate computer host (deploy/computer-host/juno-computer-host.py) builds
 * its own docker argv, in Python. It must send exactly what the single-box
 * provider (src/lib/computer/docker.ts) sends for the same inputs, plus its
 * namespace label and filters, or a computer would behave differently, or be
 * less fenced in, depending on where it runs. And every argv it sends must pass
 * the broker's own validate() in host mode (the policy is imported by the
 * host's broker, never copied).
 *
 * This asks the host for its argv (`--print-argv <op> <json>`), builds the same
 * with docker.ts's exported `computerArgv`, and compares them; then feeds each
 * to deploy/agent-computers/docker-broker.py's validate(argv, policy, namespace).
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
const { computerArgv } = docker;

const HOST = path.join(ROOT, "deploy/computer-host/juno-computer-host.py");
const BROKER = path.join(ROOT, "deploy/agent-computers/docker-broker.py");
const NS = "prod";
const NAME = "juno-agent-cmagent1";
const USER_REF = "u_0123456789abcdef0123456789abcdef";
const POLICY = { image: "juno-computer:1", network: "juno-computers", maxMemoryMb: 2048, maxCpus: 2 };

const printed = new Map<string, string[][]>();

function hostArgv(op: string, input: Record<string, unknown>): string[][] {
  const key = `${op} ${JSON.stringify(input)}`;
  const known = printed.get(key);
  if (known) return known;
  const res = spawnSync("python3", [HOST, "--print-argv", op, JSON.stringify(input)], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const argv = JSON.parse(res.stdout) as string[][];
  printed.set(key, argv);
  return argv;
}

/** The broker's validate() on each argv; returns the refusals. */
function brokerRefusals(argvs: string[][], policy: Record<string, unknown>, namespace: string | null): Array<{ argv: string[]; error: string }> {
  const res = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("broker", sys.argv[1])
broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)
namespace = json.loads(sys.argv[4])
refused = []
for argv in json.loads(sys.argv[3]):
    try:
        broker.validate(argv, json.loads(sys.argv[2]), namespace)
    except Exception as error:
        refused.append({"argv": argv, "error": str(error)})
print(json.dumps(refused))`,
      BROKER,
      JSON.stringify(policy),
      JSON.stringify(argvs),
      JSON.stringify(namespace),
    ],
    { encoding: "utf8" }
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout) as Array<{ argv: string[]; error: string }>;
}

/** Every operation, with the inputs both sides get, and docker.ts's argv for it. */
const CASES: Array<{ op: string; input: Record<string, unknown>; ts: () => string[][] }> = [
  { op: "volumeCreate", input: { agentId: "cmagent1", volume: NAME, namespace: NS }, ts: () => [computerArgv.volumeCreate("cmagent1", NAME, NS)] },
  { op: "volumeCreate", input: { agentId: "cmagent1", volume: `${NAME}-browser`, namespace: NS }, ts: () => [computerArgv.volumeCreate("cmagent1", `${NAME}-browser`, NS)] },
  ...[null, "/etc/juno/computer-seccomp.json"].flatMap((seccompProfile) =>
    [{ memoryMb: 2048, cpus: 2 }, { memoryMb: 1024, cpus: 1.5 }].map((limits) => ({
      op: "create",
      input: { agentId: "cmagent1", userRef: USER_REF, namespace: NS, image: POLICY.image, network: POLICY.network, ...limits, seccompProfile },
      ts: () => [
        computerArgv.create({
          agentId: "cmagent1",
          userId: USER_REF,
          namespace: NS,
          platform: "linux",
          nodeEnv: "production",
          image: POLICY.image,
          network: POLICY.network,
          ...limits,
          seccompProfile,
        }),
      ],
    }))
  ),
  ...(["start", "stop", "pause", "unpause"] as const).map((operation) => ({
    op: "lifecycle",
    input: { operation, name: NAME },
    ts: () => [computerArgv.lifecycle(operation, NAME)],
  })),
  { op: "remove", input: { name: NAME }, ts: () => [computerArgv.remove(NAME)] },
  { op: "volumeRemove", input: { volume: `${NAME}-browser` }, ts: () => [computerArgv.volumeRemove(`${NAME}-browser`)] },
  { op: "state", input: { name: NAME }, ts: () => [computerArgv.state(NAME)] },
  { op: "address", input: { name: NAME, network: POLICY.network }, ts: () => [computerArgv.address(NAME, POLICY.network)] },
  { op: "containerImage", input: { name: NAME }, ts: () => [computerArgv.containerImage(NAME)] },
  { op: "imageLabel", input: { image: POLICY.image }, ts: () => [computerArgv.imageLabel(POLICY.image)] },
  { op: "imageId", input: { image: POLICY.image }, ts: () => [computerArgv.imageId(POLICY.image)] },
  { op: "imageInfo", input: { image: POLICY.image }, ts: () => [computerArgv.imageInfo(POLICY.image)] },
  { op: "provisionToken", input: { name: NAME }, ts: () => [computerArgv.provisionToken(NAME)] },
  { op: "tokenPending", input: { name: NAME }, ts: () => [computerArgv.tokenPending(NAME)] },
  { op: "screenshot", input: { name: NAME }, ts: () => [computerArgv.screenshot(NAME)] },
  ...[undefined, "left", "right", "double"].map((button) => ({
    op: "click",
    input: { name: NAME, x: 10.5, y: 20.4, ...(button ? { button } : {}) },
    ts: () => [computerArgv.click(NAME, { x: 10.5, y: 20.4, ...(button ? { button: button as "left" | "right" | "double" } : {}) })],
  })),
  { op: "type", input: { name: NAME, text: "hello -- $(world) 'é'" }, ts: () => [computerArgv.type(NAME, "hello -- $(world) 'é'")] },
  { op: "key", input: { name: NAME, keys: "  ctrl+l   Return -minus " }, ts: () => [computerArgv.key(NAME, "  ctrl+l   Return -minus ")] },
  ...[{ x: 5, y: 6, dy: -3 }, { x: 5.5, y: 6.5, dx: 2 }, { x: 1, y: 2, dy: 30 }, { x: 1, y: 2 }].map((opts) => ({
    op: "scroll",
    input: { name: NAME, ...opts },
    ts: () => [computerArgv.scroll(NAME, opts)],
  })),
  { op: "drag", input: { name: NAME, x1: 1.5, y1: 2, x2: 300.49, y2: 400.5 }, ts: () => [computerArgv.drag(NAME, { x1: 1.5, y1: 2, x2: 300.49, y2: 400.5 })] },
  {
    op: "exec",
    input: { name: NAME, command: "ls -la && echo $HOME", seconds: 45, workdir: "/home/agent/work/project" },
    ts: () => [computerArgv.exec(NAME, "ls -la && echo $HOME", 45, "/home/agent/work/project")],
  },
  { op: "realpath", input: { name: NAME, path: "/home/agent/work/a b" }, ts: () => [computerArgv.realpath(NAME, "/home/agent/work/a b")] },
  { op: "list", input: { name: NAME, path: "/home/agent/work" }, ts: () => [computerArgv.list(NAME, "/home/agent/work")] },
  { op: "read", input: { name: NAME, path: "/home/agent/work/a", maxBytes: 1234 }, ts: () => [computerArgv.read(NAME, "/home/agent/work/a", 1234)] },
  ...(["run", "helper"] as const).flatMap((mode) => [
    { op: "mkdir", input: { name: NAME, path: "/home/agent/work/inbox", mode }, ts: () => [computerArgv.mkdir(NAME, "/home/agent/work/inbox", mode)] },
    { op: "write", input: { name: NAME, path: "/home/agent/work/inbox/a.bin", mode }, ts: () => [computerArgv.write(NAME, "/home/agent/work/inbox/a.bin", mode)] },
  ]),
  { op: "du", input: { name: NAME }, ts: () => [computerArgv.du(NAME)] },
  { op: "stat", input: { name: NAME, path: "/home/agent/work/a" }, ts: () => [computerArgv.stat(NAME, "/home/agent/work/a")] },
  { op: "vncKill", input: { name: NAME }, ts: () => [computerArgv.vncKill(NAME)] },
  { op: "vncKillHard", input: { name: NAME }, ts: () => [computerArgv.vncKillHard(NAME)] },
  { op: "vncPassword", input: { name: NAME }, ts: () => [computerArgv.vncPassword(NAME)] },
  { op: "vncStart", input: { name: NAME, gateway: docker.COMPUTER_NETWORK_GATEWAY }, ts: () => [computerArgv.vncStart(NAME, docker.COMPUTER_NETWORK_GATEWAY)] },
  { op: "vncRunning", input: { name: NAME }, ts: () => [computerArgv.vncRunning(NAME)] },
  { op: "listContainers", input: { namespace: NS }, ts: () => [computerArgv.listContainers(NS)] },
  { op: "listVolumes", input: { namespace: NS }, ts: () => [computerArgv.listVolumes(NS)] },
  { op: "freeze", input: { name: NAME }, ts: () => computerArgv.freeze(NAME) },
  { op: "thaw", input: { name: NAME }, ts: () => computerArgv.thaw(NAME) },
  { op: "sandboxState", input: { name: NAME }, ts: () => [computerArgv.sandboxState(NAME)] },
  { op: "sandboxProbe", input: { name: NAME }, ts: () => [computerArgv.sandboxProbe(NAME)] },
];

test("the host sends exactly docker.ts's argv for every operation", () => {
  for (const { op, input, ts } of CASES) {
    assert.deepEqual(hostArgv(op, input), ts(), `${op} ${JSON.stringify(input)}`);
  }
});

test("every argv the host sends passes the broker's validate() in host mode", () => {
  const sandboxPolicy = { ...POLICY, browserSandbox: true, seccompProfile: "/etc/juno/computer-seccomp.json" };
  const plain = CASES.filter((c) => !(c.op === "create" && c.input.seccompProfile)).flatMap((c) => hostArgv(c.op, c.input));
  assert.deepEqual(brokerRefusals(plain, POLICY, NS), []);
  const sandboxed = CASES.filter((c) => c.op === "create" && c.input.seccompProfile).flatMap((c) => hostArgv(c.op, c.input));
  assert.deepEqual(brokerRefusals(sandboxed, sandboxPolicy, NS), []);
});

test("the two modes do not accept each other's shapes", () => {
  const hostCreate = hostArgv("create", { agentId: "cmagent1", userRef: USER_REF, namespace: NS, image: POLICY.image, network: POLICY.network, memoryMb: 2048, cpus: 2 })[0];
  const singleCreate = computerArgv.create({ agentId: "cmagent1", userId: "cmuser456", platform: "linux", nodeEnv: "production", image: POLICY.image, network: POLICY.network, memoryMb: 2048, cpus: 2, seccompProfile: null });
  // The single-box sudo broker never takes a namespaced create or listing.
  assert.equal(brokerRefusals([hostCreate, computerArgv.listContainers(NS), computerArgv.listVolumes(NS), computerArgv.volumeCreate("cmagent1", NAME, NS)], POLICY, null).length, 4);
  // A host never takes a create without the namespace, with a raw user id, or the unfiltered listings.
  const withUserId = hostCreate.map((value) => (value === `juno.user=${USER_REF}` ? "juno.user=cmuser456" : value));
  const otherNamespace = hostCreate.map((value) => (value === `juno.ns=${NS}` ? "juno.ns=staging" : value));
  const refused = brokerRefusals(
    [singleCreate, withUserId, otherNamespace, computerArgv.listContainers(), computerArgv.listVolumes(), computerArgv.volumeCreate("cmagent1", NAME)],
    POLICY,
    NS
  );
  assert.equal(refused.length, 6, JSON.stringify(refused));
  // And an invalid namespace is refused before anything else.
  assert.equal(brokerRefusals([computerArgv.state(NAME)], POLICY, "Bad NS").length, 1);
});

test("the Docker provider's own calls are the exported builders", () => {
  // The single-box provider is tested against the broker in computer-broker-argv.test.ts;
  // here: its builders without a namespace are today's argv, so nothing changed for it.
  assert.deepEqual(computerArgv.volumeCreate("a", "juno-agent-a"), ["volume", "create", "--label", "app=juno", "--label", "juno.agent=a", "juno-agent-a"]);
  assert.deepEqual(computerArgv.listContainers(), [
    "ps", "-a", "--filter", "label=app=juno", "--format", '{{.Names}}\t{{.Label "juno.agent"}}\t{{.Label "juno.user"}}\t{{.State}}',
  ]);
  assert.deepEqual(computerArgv.listVolumes(), ["volume", "ls", "--filter", "name=juno-agent-", "--format", "{{.Name}}"]);
  const create = computerArgv.create({ agentId: "a", userId: "u", platform: "linux", nodeEnv: "production", seccompProfile: null });
  assert.equal(create.filter((value) => value === "--label").length, 3);
  assert.ok(!create.some((value) => value.startsWith("juno.ns=")));
});
