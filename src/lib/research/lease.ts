/**
 * The chat route's hold on a native in-chat research run (SPEC §9.3 B2): it
 * renews the drive's lease while the chat model streams the report, and
 * cancels the run when the stream ends early (Stop, an error, a disconnect).
 *
 * The timing is `lease-core.ts` (pure, tested with a fake clock); this file
 * is the Prisma half.
 */

import "server-only";
import { prismaUnguarded } from "@/lib/prisma";
import { RESEARCH_WORKER_LEASE_MS, RESEARCH_WORKING_STATES } from "@/lib/research/domain";
import { createLeaseKeeper } from "@/lib/research/lease-core";
import { researchEngine } from "@/lib/research/run";

/**
 * Renews the run's worker lease for `owner` every 45 s until the returned stop
 * is called. The same condition `claimRun` uses — held by this owner, or not
 * held at all — so a keep-alive never takes a lease another driver holds, and
 * a run that went terminal (finalize, cancel) simply stops matching.
 *
 * Unguarded: the route holds a run id and the owner string it was handed by
 * `runDeepResearch`, and the owner is the fence — no other caller knows it.
 */
export function keepResearchLeaseAlive(runId: string, owner: string): () => void {
  return createLeaseKeeper(async () => {
    const now = new Date();
    await prismaUnguarded.researchRun.updateMany({
      where: {
        id: runId,
        state: { in: ["accepted", ...RESEARCH_WORKING_STATES] },
        OR: [{ workerLeaseOwner: owner }, { workerLeaseUntil: null }, { workerLeaseUntil: { lte: now } }],
      },
      data: {
        workerLeaseOwner: owner,
        workerLeaseUntil: new Date(now.getTime() + RESEARCH_WORKER_LEASE_MS),
        lastHeartbeatAt: now,
      },
    });
  });
}

/**
 * Cancels a run the chat started, when its stream ended before the report was
 * finalised (B2, B17 for native): without this, a stopped chat left a working
 * run with a lapsing lease, and the PM2 worker adopted it and wrote a report
 * nobody would read, on the person's money. A run already terminal is left
 * alone — the cancel's conditional write loses, which is the point.
 */
export async function cancelResearchRun(runId: string, reason: string): Promise<void> {
  const row = await prismaUnguarded.researchRun.findUnique({ where: { id: runId }, select: { userId: true } });
  if (!row) return;
  await researchEngine().cancel({ runId, userId: row.userId, reason });
}
