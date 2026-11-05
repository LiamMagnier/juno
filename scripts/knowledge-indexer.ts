/**
 * Fills project knowledge vectors off the upload path (PRJ-1). Runs inside
 * `scripts/sweepers.ts`, like the other lease-based loops, and standalone
 * with `tsx scripts/knowledge-indexer.ts`.
 */
import { prismaUnguarded } from "../src/lib/db";
import { env } from "../src/lib/env";
import { embedTexts } from "../src/lib/knowledge/embed";
import { EMBED_SWEEP_INTERVAL_MS, runEmbedSweep } from "../src/lib/knowledge/embed-sweep";
import { prismaEmbedSweepStore } from "../src/lib/knowledge/embed-sweep-store";
import { loadBackgroundProviderPolicy } from "../src/lib/memory";

let running = false;
const budget = new Map<string, { hour: number; used: number }>();

async function tick() {
  if (running) return;
  running = true;
  try {
    const results = await runEmbedSweep({
      store: prismaEmbedSweepStore,
      loadPolicy: loadBackgroundProviderPolicy,
      embed: (options) => embedTexts(options),
      budget,
    });
    if (results.length > 0) {
      const summary = results.map((r) => `${r.documentId}:${r.state}${r.reason ? `(${r.reason})` : ""}`).join(" ");
      console.log(`[knowledge-indexer] ${summary}`);
    }
  } catch (error) {
    console.error("[knowledge-indexer] sweep failed", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

async function main() {
  // Off unless the owner turns it on (KNOWLEDGE_INDEXER_ENABLED=1): it sweeps
  // every account's documents and spends on embeddings, and has not yet run
  // against a production-shaped database.
  if (!env.knowledgeIndexer.enabled) {
    console.log("[knowledge-indexer] not started (KNOWLEDGE_INDEXER_ENABLED is not 1)");
    return;
  }
  await tick();
  if (process.argv.includes("--once")) {
    await prismaUnguarded.$disconnect();
    return;
  }
  const timer = setInterval(tick, EMBED_SWEEP_INTERVAL_MS);
  async function shutdown() {
    clearInterval(timer);
    await prismaUnguarded.$disconnect();
    process.exit(0);
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(async (error) => {
  console.error("[knowledge-indexer] failed to start", error instanceof Error ? error.message : String(error));
  await prismaUnguarded.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
