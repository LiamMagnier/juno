/**
 * Boot-time configuration checks, the process-lifecycle hooks, and the
 * startup sweep — all of them in `src/lib/boot.ts`.
 *
 * Next.js calls `register()` once per server process, before the first request
 * is served. That is the only place a fatal misconfiguration can be turned into
 * a failed deploy rather than a stream of 500s: a process that starts happily
 * and then throws on every chat is discovered by users, while one that refuses
 * to start is discovered by whoever ran the deploy.
 *
 * This file is compiled for every runtime Next.js targets, and webpack
 * resolves every `import()` it can reach — an early `return` on
 * `NEXT_RUNTIME` does not make what follows dead code. Only an `if` block on
 * the constant is skipped by the edge compile, so the Node-only import lives
 * inside one, exactly as the Next.js docs show. Nothing else may be imported
 * here: the boot module reaches Prisma and `node:crypto`, and one static or
 * unguarded dynamic import of either breaks the edge bundle and with it every
 * route.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNodeRuntime } = await import("@/lib/boot");
    await bootNodeRuntime();
  }
}
