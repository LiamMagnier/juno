/**
 * One process for the VM's five small background loops.
 *
 * Research adoption, memory dreaming, agent reflection, import recovery and
 * the Cloud Code task sweeper each ran as their own PM2 app. Every one of
 * them loaded its own copy of the app's module graph and Prisma engine
 * (60–80 MB resident apiece), and on the 1 GB VM the five together pushed the
 * box into swap until the site stopped answering (2026-10-02). They are
 * independent timers that share one Prisma client here instead.
 *
 * Each script keeps its own loop, logging prefix and SIGTERM handling, and
 * still runs standalone (`tsx scripts/memory-dreamer.ts --once` and so on).
 * On shutdown the first loop to finish exits the process; every loop is a
 * lease- or row-based sweep, so a tick cut short is picked up on the next
 * start. The code-task sweeper reads `--daemon` from argv, which PM2 passes.
 */
import "./research-worker";
import "./memory-dreamer";
import "./agent-reflector";
import "./sweep-import-runs";
import "./sweep-stuck-code-tasks";
