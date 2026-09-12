import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

/*
 * Unit tests for src/lib/field-crypto.ts — the encryption-at-rest helpers for
 * the columns beside the message body (`Message.activity`,
 * `MemorySummary.content`, `ScheduledTask.prompt`).
 *
 * The keyring is supplied here rather than derived from AUTH_SECRET so the
 * suite runs identically on a laptop, in CI, and on a machine whose .env
 * happens to point at production — and so the "a key left the ring" case can
 * be exercised at all, which needs a second, deliberately absent key.
 *
 * The modules are imported in `before` rather than at the top of the file
 * because the keyring is read (and cached) on first use: a static import is
 * hoisted above these assignments and would snapshot an empty environment.
 */
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

let fc!: typeof import("@/lib/field-crypto");
let mc!: typeof import("@/lib/message-crypto");

/** Point the process at a single-key ring and drop the cached keyring. */
function useKeyring(id: string, material: string): void {
  process.env.DATA_ENCRYPTION_KEYRING = `${id}:${material}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = id;
  mc.resetKeyringCacheForTests();
}

before(async () => {
  process.env.DATA_ENCRYPTION_KEYRING = `a:${KEY_A}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "a";
  fc = await import("@/lib/field-crypto");
  mc = await import("@/lib/message-crypto");
});

// ---------------------------------------------------------------------------
// Text columns
// ---------------------------------------------------------------------------

test("a text column round-trips through encryptField/decryptField", () => {
  for (const plain of [
    "Remind me to email Dana about the Q3 renewal",
    "", // an empty prompt is still a value, not an absence
    "unicode: \u00e9\u00e0\u00fc \u4e2d\u6587 \ud83d\udd10",
    "x".repeat(50_000),
    "enc:v2 but not really — a body that merely mentions the prefix",
  ]) {
    const sealed = fc.encryptField(plain);
    assert.notEqual(sealed, plain, "the stored value must not be the plaintext");
    assert.match(sealed, /^enc:v2:a:/, "new writes carry the active key id");
    assert.equal(fc.decryptField(sealed), plain);
  }
});

test("the same plaintext seals to different ciphertext each time", () => {
  // A deterministic ciphertext would let anyone holding a dump tell which rows
  // hold the same value without ever decrypting one.
  assert.notEqual(fc.encryptField("same"), fc.encryptField("same"));
});

test("READ-BOTH: plaintext without the prefix passes through untouched", () => {
  // This is the property the whole staged rollout rests on: the code ships
  // before scripts/encrypt-columns.ts has run, and every unbackfilled row must
  // still read correctly.
  for (const legacy of ["a row written before the backfill", "", '{"kind":"tool"}']) {
    assert.equal(fc.decryptField(legacy), legacy);
  }
});

test("null and undefined pass through both directions", () => {
  assert.equal(fc.encryptField(null), null);
  assert.equal(fc.encryptField(undefined), undefined);
  assert.equal(fc.decryptField(null), null);
  assert.equal(fc.decryptField(undefined), undefined);
});

test("encryptField is a no-op on a value that is already sealed", () => {
  // The backfill depends on this: re-encrypting would nest two payloads and
  // leave a row that one decrypt pass cannot recover.
  const once = fc.encryptField("already done");
  assert.equal(fc.encryptField(once), once);
});

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

const ACTIVITY = [
  { id: "a1", kind: "tool", title: "Searched Gmail", createdAt: "2026-09-12T10:00:00.000Z" },
  { id: "a2", kind: "done", title: "Finished response", createdAt: "2026-09-12T10:00:04.000Z" },
];

test("a Json column round-trips as a { enc } envelope", () => {
  const sealed = fc.encryptJsonField(ACTIVITY);
  assert.ok(sealed);
  assert.ok(fc.isEncryptedJsonField(sealed));
  // The envelope keeps the Prisma column type at `Json`, which is why no
  // migration was needed — assert the shape, not just the round-trip.
  assert.deepEqual(Object.keys(sealed), ["enc"]);
  assert.match(sealed.enc, /^enc:v2:a:/);
  assert.equal(JSON.stringify(sealed).includes("Gmail"), false, "no cleartext survives in the column");
  assert.deepEqual(fc.decryptJsonField(sealed), ACTIVITY);
});

test("READ-BOTH: an unsealed Json value passes through untouched", () => {
  assert.deepEqual(fc.decryptJsonField(ACTIVITY), ACTIVITY);
  assert.equal(fc.decryptJsonField(null), null);
  assert.deepEqual(fc.decryptJsonField({ enc: "not an enc payload" }), { enc: "not an enc payload" });
});

test("a NULL Json column stays null rather than becoming an envelope", () => {
  // "this turn logged nothing" is not a secret and must stay distinguishable
  // from an empty log.
  assert.equal(fc.encryptJsonField(null), null);
  assert.equal(fc.encryptJsonField(undefined), null);
});

test("encryptJsonField is a no-op on a value that is already sealed", () => {
  const once = fc.encryptJsonField(ACTIVITY);
  assert.equal(fc.encryptJsonField(once), once);
});

test("isEncryptedJsonField rejects everything that is not a real envelope", () => {
  for (const notAnEnvelope of [null, undefined, 42, "enc:v2:a:x", ACTIVITY, { enc: 1 }, { enc: "plain" }, {}]) {
    assert.equal(fc.isEncryptedJsonField(notAnEnvelope), false);
  }
});

// ---------------------------------------------------------------------------
// Failure is never fatal
// ---------------------------------------------------------------------------

test("a payload whose key is not on the ring degrades instead of throwing", () => {
  // Seal under key b, then read on a ring that only has key a — the shape of a
  // key retired one rotation too early.
  useKeyring("b", KEY_B);
  const sealedUnderB = mc.encryptMessageText("a secret written under a key that later left the ring");
  useKeyring("a", KEY_A);

  assert.equal(fc.decryptField(sealedUnderB), fc.FIELD_DECRYPT_PLACEHOLDER);
  // The JSON reader returns null rather than a placeholder string: there is no
  // partial structure to hand back, and null is what every caller already
  // renders as "this message has no activity log".
  assert.equal(fc.decryptJsonField({ enc: sealedUnderB }), null);
});

test("a tampered payload degrades instead of throwing", () => {
  const sealed = fc.encryptField("do not modify me");
  const parts = sealed.split(":");
  // Flip a byte of the ciphertext; GCM's tag makes this a clean failure.
  const ciphertext = Buffer.from(parts[parts.length - 1], "base64");
  ciphertext[0] ^= 0xff;
  parts[parts.length - 1] = ciphertext.toString("base64");
  assert.equal(fc.decryptField(parts.join(":")), fc.FIELD_DECRYPT_PLACEHOLDER);
});

test("the placeholder is never mistaken for real content", () => {
  // scheduled-tasks.ts compares against this constant to refuse a run rather
  // than bill a provider for an answer to a placeholder.
  assert.equal(fc.decryptField(fc.FIELD_DECRYPT_PLACEHOLDER), fc.FIELD_DECRYPT_PLACEHOLDER);
  assert.notEqual(fc.FIELD_DECRYPT_PLACEHOLDER, "");
});
