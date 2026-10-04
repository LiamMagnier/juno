/**
 * The agent reflector: proactive agents thinking between visits.
 *
 * Wakes every AGENT_SWEEP_INTERVAL_MS and lets a few agents whose last
 * reflection is over six hours old look over their goals and recent tasks and
 * raise ideas — only for people who have been here in the last two weeks, only
 * within each account's usage windows. The rules are in
 * src/lib/agents/reflect-sweep.ts and one reflection is src/lib/agents/reflect.ts;
 * this file is the loop. The same tick advances driven durable goals
 * (src/lib/agents/goal-runner.ts), one bounded step each. Its own PM2 app (juno-agent-reflector) rather than a
 * tick of the work scheduler, because a model call must never hold up a cron.
 *
 * The shape is the memory dreamer's (scripts/memory-dreamer.ts): one tick at a
 * time with a re-entrancy guard, a clean stop on SIGTERM, and a log line only
 * when a tick did something. The log carries counts and ids — never an idea,
 * a goal or a note, because this output outlives everything it describes.
 *
 * `--once` runs a single tick and exits, for a cron-style host or a manual
 * catch-up after a long outage.
 */

import { prismaUnguarded } from "@/lib/db";
import {
  AGENT_SWEEP_FIRST_TICK_MS,
  AGENT_SWEEP_INTERVAL_MS,
  AGENT_SWEEP_PER_TICK,
  sweepAgentReflections,
} from "@/lib/agents/reflect-sweep";
import { sweepGoals } from "@/lib/agents/goal-runner";

/** How long a stop waits for the reflection in hand to write what it paid for. */
const SHUTDOWN_GRACE_MS = 20_000;

let stopping = false;
let inFlight: Promise<boolean> | null = null;

/** Resolves false when the tick itself failed (not when one agent did). */
async function sweep(): Promise<boolean> {
  try {
    const outcome = await sweepAgentReflections({ limit: AGENT_SWEEP_PER_TICK, shouldStop: () => stopping });
    // Quiet when nothing ran: an account out of its window is deferred on
    // every tick until it resets, and saying so each time is noise.
    if (outcome.reflected + outcome.skipped + outcome.failed > 0) {
      console.log(
        `[agent-reflector] considered=${outcome.considered} reflected=${outcome.reflected} ` +
          `ideas=${outcome.ideas} deferred=${outcome.deferred} skipped=${outcome.skipped} failed=${outcome.failed}`
      );
    }
    // Durable goals ride the same tick: each driven goal takes at most one
    // bounded step (src/lib/agents/goal-runner.ts). Their tasks run on the
    // Work runner like any other; this only decides and starts them.
    if (!stopping) {
      const goals = await sweepGoals();
      if (goals.advanced > 0) console.log(`[agent-reflector] goals advanced=${goals.advanced}`);
    }
    return true;
  } catch (error) {
    console.error("[agent-reflector] tick failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** One tick at a time: a tick still thinking when the next is due is simply the one that runs. */
function tick(): Promise<boolean> {
  if (stopping) return Promise.resolve(true);
  inFlight ??= sweep().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function main() {
  if (process.argv.includes("--once")) {
    // A cron-style host reads the exit code, so a tick that could not even
    // find its agents must not report success.
    const ok = await tick();
    await prismaUnguarded.$disconnect();
    if (!ok) process.exitCode = 1;
    return;
  }

  const first = setTimeout(() => void tick(), AGENT_SWEEP_FIRST_TICK_MS);
  const timer = setInterval(() => void tick(), AGENT_SWEEP_INTERVAL_MS);

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearTimeout(first);
    clearInterval(timer);
    // The sweep starts no new reflection once `stopping` is set; the one in
    // hand has already claimed its agent, so let it finish writing its ideas
    // rather than lose them until the next interval.
    if (inFlight) await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
    await prismaUnguarded.$disconnect();
    process.exit(0);
  }

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main().catch(async (error) => {
  console.error("[agent-reflector] worker failed to start", error instanceof Error ? error.message : String(error));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
