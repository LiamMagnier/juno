/**
 * Boot-time configuration checks.
 *
 * Next.js calls `register()` once per server process, before the first request
 * is served. That is the only place a fatal misconfiguration can be turned into
 * a failed deploy rather than a stream of 500s: a process that starts happily
 * and then throws on every chat is discovered by users, while one that refuses
 * to start is discovered by whoever ran the deploy.
 *
 * Imports only `message-crypto-config`, never `message-crypto`. This file is
 * compiled for every runtime Next.js targets, and the cipher module imports
 * Node's `crypto` — which the edge bundle cannot resolve under any spelling.
 * Reaching for it here broke the production build.
 */
export async function register(): Promise<void> {
  // Edge and browser bundles have neither the env nor the process this checks.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertDataEncryptionKeyConfigured } = await import("@/lib/message-crypto-config");

  try {
    assertDataEncryptionKeyConfigured();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[boot] ${message}`);
    // Only fatal in production. A developer running `next dev` gets the warning
    // and the derived key, which is what makes a fresh checkout runnable.
    if (process.env.NODE_ENV === "production") throw error;
  }
}
