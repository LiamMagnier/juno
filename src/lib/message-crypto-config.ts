/**
 * The instrumentation hook imports this module before Next has decided which
 * server bundle will serve a request. Keep it free of Node builtin imports:
 * pulling the implementation module (which uses node:crypto) into that dual
 * build makes Webpack try to compile a Node-only dependency for the edge path.
 * The implementation still validates and loads the actual keys on first use.
 */

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodedByteLength(value: string): number | null {
  const compact = value.replaceAll(/\s/g, "");
  if (!compact || compact.length % 4 === 1 || !BASE64.test(compact)) return null;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function validateKeyring(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        "DATA_ENCRYPTION_KEYRING entries must be '<keyId>:<base64Key>'."
      );
    }
    const id = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (!KEY_ID.test(id)) {
      throw new Error(`Invalid data encryption key id '${id}'.`);
    }
    if (decodedByteLength(key) !== 32) {
      throw new Error(`Data encryption key '${id}' must decode to exactly 32 bytes.`);
    }
    ids.add(id);
  }
  if (ids.size === 0) throw new Error("DATA_ENCRYPTION_KEYRING is empty.");
  return ids;
}

/**
 * Fail the production process before the first request when message
 * encryption cannot be configured. Development intentionally remains usable
 * without a key; `message-crypto.ts` derives its documented local key there.
 */
export function assertMessageCryptoEnvironmentConfigured(): void {
  if (process.env.NODE_ENV !== "production") return;

  const ring = process.env.DATA_ENCRYPTION_KEYRING?.trim();
  const single = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (!ring && !single) {
    throw new Error(
      "No data encryption key is configured. Set DATA_ENCRYPTION_KEYRING or DATA_ENCRYPTION_KEY before starting in production."
    );
  }

  const ids = ring ? validateKeyring(ring) : new Set(["legacy"]);
  if (single && decodedByteLength(single) !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  // A legacy single key can intentionally coexist with a rotated keyring
  // during migration. The runtime gives the explicit keyring precedence, but
  // still accepts the legacy active-key id while that compatibility key is set.
  if (single) ids.add("legacy");
  const active = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID?.trim();
  if (active && !ids.has(active)) {
    throw new Error(
      `DATA_ENCRYPTION_ACTIVE_KEY_ID '${active}' is not present in the configured keyring.`
    );
  }
}
