/**
 * Boot-time configuration checks.
 *
 * Next.js calls `register()` once per server process, before the first request
 * is served. That is the only place a fatal misconfiguration can be turned into
 * a failed deploy rather than a stream of 500s: a process that starts happily
 * and then throws on every chat is discovered by users, while one that refuses
 * to start is discovered by whoever ran the deploy.
 */
export async function register(): Promise<void> {
  // Edge and browser bundles have neither `crypto` nor the env this checks.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertMessageCryptoConfigured } = await import("@/lib/message-crypto");

  try {
    assertMessageCryptoConfigured();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[boot] ${message}`);
    // Only fatal in production. A developer running `next dev` gets the warning
    // and the derived key, which is what makes a fresh checkout runnable.
    if (process.env.NODE_ENV === "production") throw error;
  }
}
