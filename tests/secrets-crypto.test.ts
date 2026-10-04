import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module, { createRequire } from "node:module";
import test from "node:test";

/*
 * Context-bound sealing for Alevr Secrets (src/lib/crypto.ts): a ciphertext
 * opens only under the owner and credential it was sealed for, the bound and
 * unbound formats never read each other, and key rotation keeps the binding.
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
process.env.AUTH_SECRET ??= "secrets-crypto-test-secret-32-bytes-long!!";

const req = createRequire(import.meta.url);
const crypto = req("../src/lib/crypto") as typeof import("@/lib/crypto");
const { env } = req("../src/lib/env") as typeof import("@/lib/env");

const k1 = randomBytes(32).toString("hex");
const k2 = randomBytes(32).toString("hex");
const mutableEnv = env as unknown as { tokenEncryptionKeys?: string; tokenEncryptionPrimary?: string };

test("a bound secret opens only under its own context", () => {
  mutableEnv.tokenEncryptionKeys = `k1:${k1}`;
  mutableEnv.tokenEncryptionPrimary = "k1";
  const alice = "alevr.secret.v1:alice:cred1";
  const sealed = crypto.encryptSecretBound("hunter2", alice);
  assert.match(sealed, /^v1b\.k1\./);
  assert.equal(crypto.decryptSecretBound(sealed, alice), "hunter2");
  assert.throws(() => crypto.decryptSecretBound(sealed, "alevr.secret.v1:bob:cred1"), "another owner");
  assert.throws(() => crypto.decryptSecretBound(sealed, "alevr.secret.v1:alice:cred2"), "another credential");
  assert.throws(() => crypto.decryptSecret(sealed), "the unbound reader refuses a bound payload");
  assert.throws(() => crypto.decryptSecretBound(crypto.encryptSecret("x"), alice), "and the reverse");
  assert.throws(() => crypto.encryptSecretBound("x", ""), "a context is required");
});

test("rotation re-seals under the new primary and keeps the binding", () => {
  mutableEnv.tokenEncryptionKeys = `k1:${k1}`;
  mutableEnv.tokenEncryptionPrimary = "k1";
  const context = "alevr.secret.v1:alice:cred1";
  const old = crypto.encryptSecretBound("s3cret", context);
  mutableEnv.tokenEncryptionKeys = `k1:${k1},k2:${k2}`;
  mutableEnv.tokenEncryptionPrimary = "k2";
  assert.equal(crypto.isBoundSealedWithPrimary(old), false);
  const rotated = crypto.reencryptSecretBound(old, context);
  assert.equal(crypto.isBoundSealedWithPrimary(rotated), true);
  mutableEnv.tokenEncryptionKeys = `k2:${k2}`;
  assert.equal(crypto.decryptSecretBound(rotated, context), "s3cret");
  assert.throws(() => crypto.decryptSecretBound(old, context), "the retired key is gone");
  assert.throws(() => crypto.decryptSecretBound(rotated, "alevr.secret.v1:bob:cred1"));
});

test("reference MACs are domain-separated and compared in constant time", () => {
  const a = crypto.domainMac("alevr.secret-grant.ref.v1", "grant1");
  assert.notEqual(a, crypto.domainMac("other.domain", "grant1"));
  assert.equal(crypto.macEquals(a, crypto.domainMac("alevr.secret-grant.ref.v1", "grant1")), true);
  assert.equal(crypto.macEquals(a, a.slice(0, -1)), false);
});
