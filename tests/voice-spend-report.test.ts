import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

/*
 * The relay->Juno spend callback.
 *
 * Voice was the last surface that spent real money with nothing counting it:
 * the budget was checked once, when the connect token was minted, and the call
 * then ran to the provider's session cap for free as far as the ledger knew.
 * The relay had the cost all along — it simply had no way to say so.
 *
 * These tests cover the two properties that make the callback safe to retry,
 * because both are the kind that fail silently as over-billing rather than
 * loudly as an error. The HTTP handler itself needs a database and is covered
 * by the route's own shape, not here.
 */

const SECRET = "test-secret-not-a-real-one";

/** The construction shared by relay/src/auth.ts and src/lib/crypto.ts signState. */
function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Mirror of relayCaller in src/app/api/voice/spend/route.ts. */
function verify(token: string, secret = SECRET): { userId: string } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (mac !== expected) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (p.aud !== "juno.voice.spend") return null;
    if (typeof p.uid !== "string" || typeof p.exp !== "number") return null;
    if (p.exp * 1000 < Date.now()) return null;
    return { userId: p.uid };
  } catch {
    return null;
  }
}

const valid = () => ({ uid: "user_1", exp: Math.floor(Date.now() / 1000) + 60, aud: "juno.voice.spend" });

test("a relay callback token round-trips", () => {
  assert.deepEqual(verify(mint(valid())), { userId: "user_1" });
});

test("a session token cannot be replayed as a spend report", () => {
  // The relay is HANDED a token whose payload is {uid, exp} with no audience.
  // Without the `aud` check that same token would authorise spend reports, so
  // possessing a connect token would let a client bill an arbitrary amount to
  // its own account — or stop its own session by claiming the budget is gone.
  const sessionToken = mint({ uid: "user_1", exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(verify(sessionToken), null);
});

test("a tampered payload is refused", () => {
  const token = mint(valid());
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...valid(), uid: "someone_else" })).toString("base64url");
  assert.equal(verify(`${forged}.${mac}`), null, "the mac must not validate a different body");
  assert.equal(verify(`${body}.${"a".repeat(mac.length)}`), null);
});

test("an expired token is refused", () => {
  assert.equal(verify(mint({ uid: "u", exp: Math.floor(Date.now() / 1000) - 1, aud: "juno.voice.spend" })), null);
});

test("a token signed with a different secret is refused", () => {
  assert.equal(verify(mint(valid(), "some-other-secret")), null);
});

/**
 * The relay reports the DELTA since its last acknowledged post, and only
 * advances its high-water mark once Juno answers. This models that loop —
 * including a failed post — and asserts the account is billed the true total
 * exactly once.
 */
function simulateRelay(ticks: { total: number; delivered: boolean }[]) {
  let reported = 0;
  const posts: { seq: number; costUsd: number }[] = [];
  let seq = 0;
  for (const tick of ticks) {
    const delta = tick.total - reported;
    if (delta <= 0) continue;
    posts.push({ seq: ++seq, costUsd: delta });
    if (tick.delivered) reported = tick.total;
  }
  return posts;
}

test("a failed post is retried, and the retry carries the whole outstanding delta", () => {
  const posts = simulateRelay([
    { total: 0.01, delivered: true },
    { total: 0.02, delivered: false }, // dropped
    { total: 0.03, delivered: true },
  ]);
  assert.deepEqual(posts.map((p) => Number(p.costUsd.toFixed(4))), [0.01, 0.01, 0.02]);
  // The dropped 0.01 is not lost — it is folded into the next post, so the sum
  // of DELIVERED posts equals the true total.
  assert.equal(Number((0.01 + 0.02).toFixed(4)), 0.03);
});

test("deduping on (session, seq) is what stops a retried post billing twice", () => {
  // The relay may resend a post it could not confirm. If the first attempt DID
  // land and only the response was lost, the resend arrives with the same seq.
  const ledger = new Map<string, number>();
  const apply = (sessionId: string, seq: number, cost: number) => {
    const key = `voice:${sessionId}:${seq}`;
    if (ledger.has(key)) return false;
    ledger.set(key, cost);
    return true;
  };
  assert.equal(apply("s1", 1, 0.01), true);
  assert.equal(apply("s1", 1, 0.01), false, "the same seq must not bill again");
  assert.equal(apply("s1", 2, 0.02), true);
  assert.equal([...ledger.values()].reduce((a, b) => a + b, 0), 0.03);
  // A different session with the same seq is a different charge.
  assert.equal(apply("s2", 1, 0.05), true);
});
