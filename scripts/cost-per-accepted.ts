/**
 * Print cost per accepted result, per task class and model, from the
 * router's outcome table (src/lib/metering/cost-per-accepted.ts). Read-only.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/cost-per-accepted.ts [days=30]
 */
import { aggregateRoutingEvidence } from "@/lib/router/telemetry-store";
import { costPerAcceptedResult } from "@/lib/metering/cost-per-accepted";
import { prisma } from "@/lib/prisma";

async function main() {
  const days = Math.max(1, Number(process.argv[2] ?? 30) || 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = costPerAcceptedResult((await aggregateRoutingEvidence(since)).values());
  const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(5)}`);
  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  console.log(`Cost per accepted result, last ${days} days (saved chats; accepted = router outcomeSucceeded)`);
  for (const r of rows) {
    const label = r.modelId ? `  ${r.modelId}` : r.taskClass;
    console.log(
      [label.padEnd(36), `${r.turns} turns`.padStart(11), `accepted ${pct(r.acceptanceRate)}`.padStart(14), `per accepted ${usd(r.costPerAcceptedUsd)}`.padStart(24), `cost coverage ${pct(r.costCoverage)}`.padStart(20)].join(" ")
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
