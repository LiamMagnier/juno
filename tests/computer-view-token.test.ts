import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";

/*
 * The computer view's relay token as the app mints it (src/lib/computer/live-view.ts)
 * and the relay reads it (relay/src/computer-view.ts). Version 2 carries a computer
 * host's single-use VNC ticket sealed with AES-256-GCM, the token's other fields as
 * additional data (COMPUTERS_2026-10.md S3.3, D5); version 1 is unchanged for Docker.
 * The relay's verifier is the real one, imported from the relay package.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const liveView = req("../src/lib/computer/live-view") as typeof import("@/lib/computer/live-view");
const relay = req("../relay/src/computer-view") as typeof import("../relay/src/computer-view");

const SECRET = "computer-view-token-test-secret-0123456789";
const HOST = "https://computers.example.test";
const TICKET = "T".repeat(20) + "_-" + "k".repeat(21);

/** Puts an environment variable back; assigning undefined would set the string "undefined". */
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
}

function encode(payload: Record<string, unknown>, label: string): string {
  const { createHmac } = req("node:crypto") as typeof import("node:crypto");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = createHmac("sha256", SECRET).update(label).digest();
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function mintV2(overrides: Partial<{ agentId: string; userId: string; mode: "watch" | "control"; origin: string; ticket: string }> = {}) {
  return liveView.mintViewToken({
    agentId: overrides.agentId ?? "agent_1",
    userId: overrides.userId ?? "user_1",
    host: "",
    port: 5900,
    mode: overrides.mode ?? "control",
    authSecret: SECRET,
    tunnel: { origin: overrides.origin ?? HOST, ticket: overrides.ticket ?? TICKET },
  }).token;
}

const verifyOpts = { authSecret: SECRET, nodeEnv: "production", computerHosts: [HOST] };

test("a tunnel mints a version 2 token whose ticket only the relay can open", () => {
  const token = mintV2();
  const payload = decode(token);
  assert.equal(payload.v, 2);
  assert.equal(payload.r, HOST);
  assert.equal(payload.m, "control");
  assert.deepEqual(Object.keys(payload).sort(), ["a", "exp", "j", "k", "m", "r", "u", "v"]);
  assert.ok(!token.includes(TICKET) && !JSON.stringify(payload).includes(TICKET), "the ticket is not readable from the token");
  assert.ok(!("h" in payload) && !("p" in payload), "no address for the browser to see");
  const grant = relay.verifyComputerViewToken(token, verifyOpts);
  assert.ok(grant && grant.v === 2);
  assert.equal(grant.ticket, TICKET);
  assert.equal(grant.r, HOST);
  assert.equal(grant.a, "agent_1");
});

test("without a tunnel the token is version 1, exactly as before", () => {
  const { token } = liveView.mintViewToken({ agentId: "a", userId: "u", host: "172.30.0.9", port: 5900, mode: "watch", authSecret: SECRET });
  const payload = decode(token);
  assert.equal(payload.v, 1);
  assert.equal(payload.h, "172.30.0.9");
  const grant = relay.verifyComputerViewToken(token, { authSecret: SECRET, nodeEnv: "production" });
  assert.ok(grant && grant.v === 1 && grant.h === "172.30.0.9");
});

test("a sealed ticket moved into another token is refused, and so is any edit", () => {
  const original = decode(mintV2({ agentId: "agent_victim" }));
  const fresh = decode(mintV2({ agentId: "agent_attacker" }));
  // The attacker re-signs nothing (they hold no secret); even a correctly signed
  // token carrying another token's sealed ticket fails the additional data.
  const moved = encode({ ...fresh, k: original.k }, "juno-computer-view-v2");
  assert.equal(relay.verifyComputerViewToken(moved, verifyOpts), null);
  for (const edit of [{ m: "watch" }, { u: "user_2" }, { exp: (fresh.exp as number) + 30 }, { j: "another-jti-0001" }, { r: "https://evil.example.test" }]) {
    assert.equal(relay.verifyComputerViewToken(encode({ ...fresh, ...edit }, "juno-computer-view-v2"), { ...verifyOpts, computerHosts: [HOST, "https://evil.example.test"] }), null, JSON.stringify(edit));
  }
  // A v2 payload signed under v1's key, or the reverse, is refused.
  assert.equal(relay.verifyComputerViewToken(encode(fresh, "juno-computer-view-v1"), verifyOpts), null);
});

test("the relay opens tunnels only to listed https origins", () => {
  const token = mintV2();
  assert.equal(relay.verifyComputerViewToken(token, { ...verifyOpts, computerHosts: [] }), null);
  assert.equal(relay.verifyComputerViewToken(token, { ...verifyOpts, computerHosts: ["https://other.example.test"] }), null);
  const loopback = mintV2({ origin: "http://127.0.0.1:8750" });
  assert.equal(relay.verifyComputerViewToken(loopback, { ...verifyOpts, computerHosts: ["http://127.0.0.1:8750"] }), null, "never http in production");
  assert.ok(relay.verifyComputerViewToken(loopback, { ...verifyOpts, nodeEnv: "development", computerHosts: ["http://127.0.0.1:8750"] }));
  assert.deepEqual(relay.parseComputerHosts("https://a.test, http://127.0.0.1:8750 ,http://10.0.0.4:8750,https://b.test/path,junk", "development"), [
    "https://a.test",
    "http://127.0.0.1:8750",
  ]);
  assert.deepEqual(relay.parseComputerHosts("https://a.test,http://127.0.0.1:8750", "production"), ["https://a.test"]);
});

test("COMPUTER_VIEW_RELAY_URL wins over the voice relay variables", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { c: env.COMPUTER_VIEW_RELAY_URL, n: env.NEXT_PUBLIC_VOICE_RELAY_URL, v: env.VOICE_RELAY_URL };
  try {
    env.NEXT_PUBLIC_VOICE_RELAY_URL = "https://voice.example.test/voice-relay";
    env.VOICE_RELAY_URL = "https://voice2.example.test";
    delete env.COMPUTER_VIEW_RELAY_URL;
    assert.equal(liveView.resolveComputerRelayUrl(), "wss://voice.example.test/voice-relay/computer");
    env.COMPUTER_VIEW_RELAY_URL = "http://localhost:8787";
    assert.equal(liveView.resolveComputerRelayUrl(), "ws://localhost:8787/voice-relay/computer");
  } finally {
    restore("COMPUTER_VIEW_RELAY_URL", saved.c);
    restore("NEXT_PUBLIC_VOICE_RELAY_URL", saved.n);
    restore("VOICE_RELAY_URL", saved.v);
  }
});
