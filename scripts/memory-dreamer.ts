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
import { pollBatchJobs, prepareBatchDreaming } from "@/lib/batch/dream";
import { accountsWithEndedBatches } from "@/lib/batch/store";
import { batchApiEnabled } from "@/lib/batch/plan";

let running = false;

/** Resolves false when the tick itself failed (not when one account did). */
async function tick(): Promise<boolean> {
  if (running) return true;
  running = true;
  try {
    /*
     * Batch API mode (BATCH_API_ENABLED, default on; src/lib/batch/dream.ts):
     * first collect what finished since the last tick — billed at the batch
     * price as it is downloaded — then visit the accounts with answers waiting
     * as well as those with history to read. A poll failure is logged and the
     * tick goes on; batches are simply polled again next time.
     */
    const batching = batchApiEnabled();
    if (batching) {
      const polled = await pollBatchJobs().catch((error) => {
        console.error("[memory-dreamer] batch poll failed", error instanceof Error ? error.message : String(error));
        return null;
      });
      if (polled && (polled.ended > 0 || polled.failed > 0)) {
        console.log(`[memory-dreamer] batches ended=${polled.ended} failed=${polled.failed} running=${polled.stillRunning}`);
      }
    }
    const waiting = batching ? await accountsWithEndedBatches(DREAM_ACCOUNTS_PER_TICK).catch(() => []) : [];
    const accounts = [...new Set([...waiting, ...(await findAccountsToDream(DREAM_ACCOUNTS_PER_TICK))])];
    for (const userId of accounts) {
      try {
        const outcome = await dreamForAccount(userId, new Date(), batching ? { batching: (id) => prepareBatchDreaming(id) } : {});
        if (outcome.skipped) continue;
        if (
          outcome.processedConversations > 0 ||
          outcome.expired > 0 ||
          outcome.rereadQueued > 0 ||
          outcome.rejudged > 0 ||
          (outcome.batchQueued ?? 0) > 0
        ) {
          console.log(
            `[memory-dreamer] account=${userId} read=${outcome.processedConversations} ` +
              `learned=${outcome.created} expired=${outcome.expired} remaining=${outcome.remaining} ` +
              `reread_queued=${outcome.rereadQueued} rejudged=${outcome.rejudged}` +
              (outcome.batchQueued ? ` batch_queued=${outcome.batchQueued}` : "") +
              (outcome.batchFellBack ? " batch_fell_back=1" : "")
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
