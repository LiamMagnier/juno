import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(primary?: string, keys?: string) {
  const script = `
    const crypto = require('./src/lib/crypto.ts');
    crypto.assertConnectorEncryptionConfigured();
    const payload = crypto.encryptSecret('private connector token');
    if (crypto.decryptSecret(payload) !== 'private connector token') throw new Error('roundtrip failed');
    const { createCipheriv, createHash } = require('node:crypto');
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('juno:connector:' + process.env.AUTH_SECRET).digest(), Buffer.alloc(12));
    const encrypted = Buffer.concat([cipher.update('legacy token'), cipher.final()]);
    const legacy = [Buffer.alloc(12), cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.');
    if (crypto.decryptSecret(legacy) !== 'legacy token') throw new Error('legacy rotation path failed');
    console.log(payload.split('.')[1]);
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", AUTH_SECRET: "test-only-connector-auth-secret", TOKEN_ENCRYPTION_PRIMARY: primary, TOKEN_ENCRYPTION_KEYS: keys };
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "-e", script], { env, encoding: "utf8" });
}

test("production connector encryption refuses unset or auth-derived primary keys", () => {
  for (const primary of [undefined, "auth", " auth "]) {
    const result = run(primary);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production requires TOKEN_ENCRYPTION_PRIMARY/);
  }
});

test("independent production keys roundtrip while retaining legacy decrypt for rotation", () => {
  const result = run("connector-v2", `connector-v2:${"a1".repeat(32)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "connector-v2");
});

test("a missing or malformed independent key also fails closed", () => {
  for (const keys of [undefined, "connector-v2:bad", `other:${"b2".repeat(32)}`]) {
    assert.notEqual(run("connector-v2", keys).status, 0);
  }
});
