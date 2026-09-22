/**
 * The memory dreamer — Juno's answer to ChatGPT's Dreaming.
 *
 * Wakes every DREAM_INTERVAL_MS, picks a few accounts with conversations not
 * yet distilled into memory, and reads a bounded slice of each — only between
 * sessions, only within the account's usage windows, only while memory and
 * background learning are both on. The rules are in src/lib/memory-dreaming.ts
 * and one account's pass is src/lib/memory-dreamer.ts; this file is the loop.
 *
 * The shape is the import-recovery sweeper's (scripts/sweep-import-runs.ts):
 * one tick at a time with a re-entrancy guard, a clean disconnect on SIGTERM,
 * and a log line only when a tick did something. The log carries counts and
 * account ids — never a fact, a digest or a chat title, because this output
 * outlives every conversation it describes.
 *
 * `--once` runs a single tick and exits, for a cron-style host or a manual
 * catch-up after a long outage.
 */

import { prismaUnguarded } from "@/lib/db";
import { DREAM_ACCOUNTS_PER_TICK, DREAM_INTERVAL_MS } from "@/lib/memory-dreaming";
import { dreamForAccount, findAccountsToDream } from "@/lib/memory-dreamer";

let running = false;

/** Resolves false when the tick itself failed (not when one account did). */
async function tick(): Promise<boolean> {
  if (running) return true;
  running = true;
  try {
    const accounts = await findAccountsToDream(DREAM_ACCOUNTS_PER_TICK);
    for (const userId of accounts) {
      try {
        const outcome = await dreamForAccount(userId);
        if (outcome.skipped) continue;
        if (outcome.processedConversations > 0 || outcome.expired > 0 || outcome.rereadQueued > 0 || outcome.rejudged > 0) {
          console.log(
            `[memory-dreamer] account=${userId} read=${outcome.processedConversations} ` +
              `learned=${outcome.created} expired=${outcome.expired} remaining=${outcome.remaining} ` +
              `reread_queued=${outcome.rereadQueued} rejudged=${outcome.rejudged}`
          );
        }
      } catch (error) {
        // One account's failure is that account's; the tick moves on.
        console.error(
          `[memory-dreamer] account=${userId} failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  } catch (error) {
    console.error("[memory-dreamer] tick failed", error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    running = false;
  }
  return true;
}

async function main() {
  if (process.argv.includes("--once")) {
    // A cron-style host reads the exit code, so a tick that could not even
    // find its accounts must not report success.
    const ok = await tick();
    await prismaUnguarded.$disconnect();
    if (!ok) process.exitCode = 1;
    return;
  }

  await tick();
  const timer = setInterval(() => void tick(), DREAM_INTERVAL_MS);

  async function shutdown() {
    clearInterval(timer);
    await prismaUnguarded.$disconnect();
    process.exit(0);
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(async (error) => {
  console.error("[memory-dreamer] worker failed to start", error instanceof Error ? error.message : String(error));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
