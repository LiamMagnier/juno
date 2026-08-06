import "server-only";

import { prisma } from "@/lib/prisma";
import { serializeApproval, type ClientWorkApproval } from "@/lib/work/serializers";

/**
 * The approvals a run is actually blocked on, for the surfaces a person reads.
 *
 * **Why this exists.** `serializeApproval` has been in the codebase since the
 * approval model was written, and until now exactly one route called it: the
 * one that *records a decision*. Neither read path shipped approvals at all —
 * `GET /api/work/sessions/[id]` returned `{ session, run }`, and the SSE frames
 * carried `{ session, run, events }`. Both native clients decode an `approvals`
 * key from those payloads (`NativeWorkClient.decodeApprovalList`), so
 * `NativeWorkModel.pendingApprovals` was empty on every Mac and every phone,
 * always. The approval card — the one screen the whole product exists to show —
 * could not render in production no matter what a run did.
 *
 * One reader for both routes so they cannot come to disagree about what
 * "pending" means. A stream that offered an approval the detail route withheld
 * would make the card appear and vanish as the client reconnected.
 *
 * **Answerable, not merely undecided.** An approval past its expiry is dropped
 * rather than returned. The decision route refuses it — "This request expired
 * before it was answered" — so returning it would put a card on screen whose
 * only two buttons are guaranteed to fail, at the exact moment the reader is
 * trying to unblock their own work. The run's log still records that it was
 * asked and that nothing answered, which is where that history belongs.
 */
export async function pendingApprovalsForRun(
  runId: string | null | undefined,
  userId: string,
  now: Date = new Date()
): Promise<ClientWorkApproval[]> {
  if (!runId) return [];
  const rows = await prisma.workApproval.findMany({
    where: {
      runId,
      userId,
      decision: "pending",
      expiresAt: { gt: now },
    },
    // Oldest first: a run asks in the order it needs answers, and
    // `NativeWorkModel.currentApproval` takes the head of this list. Newest
    // first would make somebody answer their run's questions backwards.
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.map(serializeApproval);
}
