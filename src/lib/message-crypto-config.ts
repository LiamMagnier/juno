/**
 * Whether a data-encryption key is configured — and nothing else.
 *
 * Split out from `message-crypto.ts` because the boot check needs the *answer*
 * and not the cipher. That module imports `crypto`, and importing it from
 * `instrumentation.ts` pulls a Node builtin into the bundle Next.js compiles
 * for the edge runtime, where it cannot resolve — under either spelling,
 * `crypto` or `node:crypto`. The deploy failed on exactly that.
 *
 * So this file imports nothing. It is safe to reach from any runtime, which is
 * what makes the boot guard possible at all.
 */

export class MessageCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageCryptoConfigError";
  }
}

/** True when an explicit key or keyring is present in the environment. */
export function hasExplicitDataEncryptionKey(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(env.DATA_ENCRYPTION_KEYRING?.trim() || env.DATA_ENCRYPTION_KEY?.trim());
}

/**
 * Throws when production would fall back to an AUTH_SECRET-derived key.
 *
 * Deriving it couples two unrelated secrets: rotating AUTH_SECRET — the
 * routine response to a leak — would make every stored message permanently
 * unreadable. Refusing to boot is the only way that trade stays visible.
 */
export function assertDataEncryptionKeyConfigured(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.NODE_ENV !== "production") return;
  if (hasExplicitDataEncryptionKey(env)) return;
  throw new MessageCryptoConfigError(
    "No data encryption key is configured. Set DATA_ENCRYPTION_KEYRING (or " +
      "DATA_ENCRYPTION_KEY) before starting in production. Deriving the message key " +
      "from AUTH_SECRET would mean that rotating AUTH_SECRET permanently orphans " +
      "every stored message."
  );
}
