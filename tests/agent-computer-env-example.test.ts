import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * The agent-computer image tag and Docker network have three homes that must
 * agree, and the documented setup only works when they do:
 *
 *   deploy/agent-computers/setup-vm.sh   builds the image and creates the network
 *   src/lib/env.ts                       the defaults the server falls back to
 *   .env.example                         what a self-hoster copies into .env
 *
 * `.env.example` shipped `juno-agent-computer:1` on `juno-agent-net` while the
 * script built `juno-computer:1` on `juno-computers`, so a server set up by
 * the book reported the image missing and agent computers stayed silently
 * `configured:false` (ledger P0-3). This reads all three from disk, so a
 * rename in any one of them fails here instead of in production.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ENV_EXAMPLE = read(".env.example");
const SETUP_VM = read("deploy/agent-computers/setup-vm.sh");

/** KEY="value" / KEY=value lines, as dotenv reads them; comments ignored. */
function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(match[1], value);
  }
  return out;
}

/** The value setup-vm.sh assigns a shell variable, unwrapping `${OVERRIDE:-default}`. */
function shellDefault(script: string, name: string): { value: string; override: string | null } {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(script);
  assert.ok(match, `setup-vm.sh no longer assigns ${name}=`);
  const raw = match[1].trim().replace(/^"(.*)"$/, "$1");
  const fallback = /^\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}$/.exec(raw);
  if (fallback) return { value: fallback[2], override: fallback[1] };
  assert.doesNotMatch(raw, /\$/, `${name} in setup-vm.sh is computed (${raw}); this test can only compare a literal`);
  return { value: raw, override: null };
}

const example = parseDotenv(ENV_EXAMPLE);
const image = shellDefault(SETUP_VM, "IMAGE");
const network = shellDefault(SETUP_VM, "NET");

test("setup-vm.sh builds the image and creates the network from the variables this test reads", () => {
  assert.match(SETUP_VM, /docker build [^\n]*-t "\$IMAGE"/, "the image is built under $IMAGE");
  assert.match(SETUP_VM, /docker network create[\s\S]*?"\$NET"\s*$/m, "the network is created as $NET");
  assert.match(SETUP_VM, /python3 - "\$IMAGE" "\$NET"/, "the broker policy is written from $IMAGE and $NET");
});

test(".env.example ships the image tag setup-vm.sh builds", () => {
  assert.equal(example.get("AGENT_COMPUTER_IMAGE"), image.value);
});

test(".env.example ships the network setup-vm.sh creates", () => {
  assert.equal(example.get("AGENT_COMPUTER_NETWORK"), network.value);
});

test("src/lib/env.ts falls back to the same tag and network when nothing is set", () => {
  const keys = ["COMPUTER_DOCKER_IMAGE", "AGENT_COMPUTER_IMAGE", "AGENT_COMPUTER_NETWORK", "COMPUTER_DOCKER_NETWORK"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const req = createRequire(import.meta.url);
    const { env } = req("../src/lib/env") as typeof import("@/lib/env");
    assert.equal(env.agentComputer.image, image.value);
    assert.equal(env.agentComputer.network, network.value);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the image override setup-vm.sh honours is one the server reads first", () => {
  // setup-vm.sh lets COMPUTER_DOCKER_IMAGE replace the tag; env.ts must read
  // the same name ahead of AGENT_COMPUTER_IMAGE, or an overridden build runs
  // under one tag while the server looks for another.
  assert.equal(image.override, "COMPUTER_DOCKER_IMAGE");
  const req = createRequire(import.meta.url);
  const saved = { a: process.env.COMPUTER_DOCKER_IMAGE, b: process.env.AGENT_COMPUTER_IMAGE };
  process.env.COMPUTER_DOCKER_IMAGE = "override:7";
  process.env.AGENT_COMPUTER_IMAGE = "example:1";
  try {
    const { env } = req("../src/lib/env") as typeof import("@/lib/env");
    assert.equal(env.agentComputer.image, "override:7");
  } finally {
    if (saved.a === undefined) delete process.env.COMPUTER_DOCKER_IMAGE;
    else process.env.COMPUTER_DOCKER_IMAGE = saved.a;
    if (saved.b === undefined) delete process.env.AGENT_COMPUTER_IMAGE;
    else process.env.AGENT_COMPUTER_IMAGE = saved.b;
  }
});
