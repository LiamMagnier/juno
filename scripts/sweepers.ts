/**
 * One process for the VM's background loops.
 *
 * The Work scheduler, the event-trigger poller, research adoption, memory
 * dreaming, agent reflection, import recovery and the Cloud Code task sweeper
 * each ran as their own PM2 app. Every one of
 * them loaded its own copy of the app's module graph and Prisma engine
 * (60–80 MB resident apiece), and on the 1 GB VM the seven together pushed the
 * box into swap until the site stopped answering (2026-10-02). They are
 * independent timers that share one Prisma client here instead.
 *
 * Each script keeps its own loop, logging prefix and SIGTERM handling, and
 * still runs standalone (`tsx scripts/memory-dreamer.ts --once` and so on).
 * On shutdown the first loop to finish exits the process; every loop is a
 * lease- or row-based sweep, so a tick cut short is picked up on the next
 * start. The code-task sweeper reads `--daemon` from argv, which PM2 passes.
 *
 * Importing a loop is not starting it for two of them. The Work scheduler and
 * the event-trigger poller run their `main` only when they are the script node
 * was asked to run (so tests can import their ticks), and here they never are:
 * they are started below, only when SWEEPERS_RUN_WORK_SCHEDULER is 1, because
 * starting them starts routines firing, triggers polling connected apps and
 * the checkpoint retention sweep (src/lib/worker-watchdog-rules.ts,
 * `workDispatchLoopsEnabled`; owner to decide, docs/OPEN_DECISIONS.md §14).
 *
 * The process logs an unhandled rejection and keeps running, and on an
 * uncaught exception lets its loops finish the tick in hand and exits non-zero
 * for PM2 (src/lib/worker-process.ts). Its watchdog writes the process's
 * heartbeat, which juno-work watches, and mails the operator when one of its
 * loops stops finishing ticks or the cloud Work executor goes quiet while runs
 * wait for it (src/lib/worker-watchdog.ts).
 */
import { installWorkerProcessGuard } from "@/lib/worker-process";
import { startSweepersWatchdog } from "@/lib/worker-watchdog";
import { workDispatchLoopsEnabled } from "@/lib/worker-watchdog-rules";
import { startWorkScheduler } from "./work-scheduler";
import { startTriggerPoller } from "./work-trigger-poller";
import "./research-worker";
import "./memory-dreamer";
import "./agent-reflector";
import "./sweep-import-runs";
import "./sweep-stuck-code-tasks";

installWorkerProcessGuard();

if (workDispatchLoopsEnabled()) {
  void startWorkScheduler();
  void startTriggerPoller();
} else {
  console.log(
    "[sweepers] the routine scheduler and the event-trigger poller are not started in this process " +
      "(SWEEPERS_RUN_WORK_SCHEDULER is not 1; docs/OPEN_DECISIONS.md §14)"
  );
}

startSweepersWatchdog();
