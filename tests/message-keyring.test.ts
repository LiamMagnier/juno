import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

/*
 * The keyring, key rotation, and the production guard.
 *
 * What v1 got wrong: the payload named no key, so there was exactly one key the
 * whole database could be read with. Rotating meant re-encrypting every row in
 * a single pass that could not be resumed and could not be rolled back, which
 * in practice meant never rotating. And with no explicit key configured the
 * message key was derived from AUTH_SECRET — so rotating AUTH_SECRET, a routine
 * response to a leak, permanently orphaned every stored message.
 *
 * The module caches its keyring, so each test sets the environment and resets
 * that cache before importing behaviour.
 */

// The development fallback derives from AUTH_SECRET, so it has to exist for
// the non-production cases to reach the code under test at all.
process.env.AUTH_SECRET ??= "test-message-keyring-secret";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

type Crypto = typeof import("@/lib/message-crypto");

async function withEnv(
  vars: Record<string, string | undefined>,
  run: (crypto: Crypto) => void | Promise<void>
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "DATA_ENCRYPTION_KEYRING",
    "DATA_ENCRYPTION_ACTIVE_KEY_ID",
    "DATA_ENCRYPTION_KEY",
    "NODE_ENV",
  ];
  for (const key of keys) saved[key] = process.env[key];
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) process.env[key] = value;
    }
    const crypto = (await import("@/lib/message-crypto")) as Crypto;
    crypto.resetKeyringCacheForTests();
    await run(crypto);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const crypto = (await import("@/lib/message-crypto")) as Crypto;
    crypto.resetKeyringCacheForTests();
  }
}

test("new payloads name the key that encrypted them", async () => {
  await withEnv({ DATA_ENCRYPTION_KEYRING: `k1:${KEY_A}` }, (c) => {
    const stored = c.encryptMessageText("hello");
    assert.ok(stored.startsWith("enc:v2:k1:"));
    assert.equal(c.messageKeyId(stored), "k1");
    assert.equal(c.decryptMessageText(stored), "hello");
  });
});

test("a previous key still decrypts while the active key encrypts", async () => {
  let underOldKey = "";
  await withEnv({ DATA_ENCRYPTION_KEYRING: `old:${KEY_A}` }, (c) => {
    underOldKey = c.encryptMessageText("written before the rotation");
  });

  await withEnv(
    {
      DATA_ENCRYPTION_KEYRING: `old:${KEY_A},new:${KEY_B}`,
      DATA_ENCRYPTION_ACTIVE_KEY_ID: "new",
    },
    (c) => {
      // The whole point: the old row is readable without having been rewritten.
      assert.equal(c.decryptMessageText(underOldKey), "written before the rotation");
      assert.ok(c.encryptMessageText("after").startsWith("enc:v2:new:"));
    }
  );
});

test("dropping a key that rows still reference fails loudly, not silently", async () => {
  let underOldKey = "";
  await withEnv({ DATA_ENCRYPTION_KEYRING: `old:${KEY_A}` }, (c) => {
    underOldKey = c.encryptMessageText("orphan me");
  });

  await withEnv({ DATA_ENCRYPTION_KEYRING: `new:${KEY_B}` }, (c) => {
    assert.throws(
      () => c.decryptMessageText(underOldKey),
      /key 'old' is not in the configured keyring/
    );
    // Read paths degrade to a placeholder rather than 500-ing a conversation.
    assert.equal(c.decryptMessageTextSafe(underOldKey), "[message could not be decrypted]");
    assert.ok((c.messageCryptoMetrics().unknown_key_id ?? 0) >= 1);
  });
});

test("rotation is idempotent: a row already under the active key is not rewritten", async () => {
  await withEnv(
    { DATA_ENCRYPTION_KEYRING: `a:${KEY_A},b:${KEY_B}`, DATA_ENCRYPTION_ACTIVE_KEY_ID: "b" },
    (c) => {
      const stored = c.encryptMessageText("already current");
      assert.equal(c.isEncryptedUnderActiveKey(stored), true);
      assert.equal(
        c.rotateMessageText(stored),
        null,
        "a no-op must be signalled, so a resumed pass does no writes"
      );
    }
  );
});

test("rotation re-encrypts an old-key row under the active key, preserving content", async () => {
  let underOldKey = "";
  await withEnv({ DATA_ENCRYPTION_KEYRING: `a:${KEY_A}` }, (c) => {
    underOldKey = c.encryptMessageText("carry me across");
  });

  await withEnv(
    { DATA_ENCRYPTION_KEYRING: `a:${KEY_A},b:${KEY_B}`, DATA_ENCRYPTION_ACTIVE_KEY_ID: "b" },
    (c) => {
      const rotated = c.rotateMessageText(underOldKey);
      assert.ok(rotated, "an old-key row must be rewritten");
      assert.equal(c.messageKeyId(rotated!), "b");
      assert.equal(c.decryptMessageText(rotated!), "carry me across");
      // And running again over the rotated row is a no-op.
      assert.equal(c.rotateMessageText(rotated!), null);
    }
  );
});

test("rotation brings legacy plaintext rows under encryption in the same pass", async () => {
  await withEnv({ DATA_ENCRYPTION_KEYRING: `a:${KEY_A}` }, (c) => {
    const rotated = c.rotateMessageText("a plaintext row from before encryption");
    assert.ok(rotated);
    assert.equal(c.messageKeyId(rotated!), "a");
    assert.equal(c.decryptMessageText(rotated!), "a plaintext row from before encryption");
  });
});

test("a v1 payload is read by whichever ring key wrote it", async () => {
  // Written the way v1 wrote: no key id in the payload.
  await withEnv({ DATA_ENCRYPTION_KEY: KEY_A }, async (c) => {
    const v2 = c.encryptMessageText("v1-era row");
    const parts = v2.split(":"); // enc v2 keyId iv tag data
    const v1 = ["enc", "v1", parts[3], parts[4], parts[5]].join(":");

    await withEnv(
      { DATA_ENCRYPTION_KEYRING: `other:${KEY_B},legacy:${KEY_A}` },
      (ringed) => {
        assert.equal(ringed.messageKeyId(v1), null, "v1 names no key");
        assert.equal(ringed.decryptMessageText(v1), "v1-era row");
      }
    );
  });
});

test("production refuses to boot without an explicit key", async () => {
  await withEnv({ NODE_ENV: "production" }, (c) => {
    assert.throws(() => c.loadKeyring(), /No data encryption key is configured/);
  });
});

test("production boots when a keyring is configured", async () => {
  await withEnv(
    { NODE_ENV: "production", DATA_ENCRYPTION_KEYRING: `k1:${KEY_A}` },
    (c) => {
      assert.doesNotThrow(() => c.assertMessageCryptoConfigured());
      assert.equal(c.loadKeyring().derived, false);
    }
  );
});

test("a malformed keyring is rejected rather than silently ignored", async () => {
  await withEnv({ DATA_ENCRYPTION_KEYRING: "nocolon" }, (c) => {
    assert.throws(() => c.loadKeyring(), /must be '<keyId>:<base64Key>'/);
  });
  await withEnv({ DATA_ENCRYPTION_KEYRING: `k1:${Buffer.from("short").toString("base64")}` }, (c) => {
    assert.throws(() => c.loadKeyring(), /must be exactly 32 bytes/);
  });
  await withEnv({ DATA_ENCRYPTION_KEYRING: `bad id:${KEY_A}` }, (c) => {
    assert.throws(() => c.loadKeyring(), /Invalid key id/);
  });
});

test("an active key id that is not on the ring is a configuration error", async () => {
  await withEnv(
    { DATA_ENCRYPTION_KEYRING: `k1:${KEY_A}`, DATA_ENCRYPTION_ACTIVE_KEY_ID: "k9" },
    (c) => {
      assert.throws(() => c.loadKeyring(), /is not present in the keyring/);
    }
  );
});

test("the single-key variable still works and is named on the ring", async () => {
  await withEnv({ DATA_ENCRYPTION_KEY: KEY_A }, (c) => {
    const stored = c.encryptMessageText("single key deployment");
    assert.equal(c.messageKeyId(stored), "legacy");
    assert.equal(c.decryptMessageText(stored), "single key deployment");
  });
});

test("a failed decrypt never puts the payload in the logs", async () => {
  await withEnv({ DATA_ENCRYPTION_KEYRING: `a:${KEY_A}` }, (c) => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      c.decryptMessageTextSafe("enc:v2:missing:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:secret");
    } finally {
      console.error = original;
    }
    const flat = JSON.stringify(logged);
    assert.ok(!flat.includes("secret"), "ciphertext must never be logged");
  });
});
