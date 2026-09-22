/**
 * The claim lease on Code session commands (phone → relay → Mac).
 *
 * A host claims a command by moving it from `pending` to `claimed`, runs it,
 * and acknowledges it. Before this module a claimed command whose
 * acknowledgement never arrived — the Mac slept mid-command, lost its network,
 * or quit — stayed `claimed` forever: nothing handed it out again, nothing
 * failed it, and the phone showed a command that neither happened nor didn't.
 *
 * Now a claim is a lease. A command still `claimed` after `COMMAND_CLAIM_LEASE_MS`
 * goes back to `pending` so the host picks it up again, at most
 * `COMMAND_MAX_CLAIMS` times; after that it is failed with a message a person
 * can read. Re-handing a command is only safe because the Mac keeps a ledger of
 * what it has run (`CodeRemoteCommandLedger`): a command it already executed is
 * answered from the ledger, never run twice.
 *
 * Kept free of Prisma and Next imports, like `code-session-command-compat.ts`,
 * so the decisions are testable without a database. The sweep takes the one
 * operation it needs as an argument.
 */

/**
 * How long a claim may stay unacknowledged. A Code command is quick to run —
 * a prompt is accepted, not completed, before the Mac acknowledges — so two
 * minutes is ample for a slow Mac and short enough that a phone is not left
 * waiting on one that went to sleep.
 */
export const COMMAND_CLAIM_LEASE_MS = 120_000;

/** How many claims a command gets before it is failed instead of re-queued. */
export const COMMAND_MAX_CLAIMS = 3;

/**
 * A claim that ran out this long ago is failed, never re-queued, whatever its
 * count. Handing a Mac an hours-old "send this prompt" the moment it wakes
 * would start work nobody is waiting for any more — and it is also what keeps
 * commands stuck before the lease existed from all firing at once.
 */
export const COMMAND_REQUEUE_WINDOW_MS = 30 * 60_000;

export const COMMAND_LEASE_EXHAUSTED_ERROR =
  "Your Mac took this command but never confirmed it ran. Check the session on the Mac before sending it again.";

/** The columns of a `CodeSessionCommand` the lease reads, and no others. */
export type CommandLeaseView = {
  status: string;
  claimedAt: Date | null;
  attempts: number;
};

export type CommandLeaseDisposition =
  /** Not claimed, or claimed within its lease. */
  | "keep"
  /** Claimed, lease run out recently, claims left: back to `pending`. */
  | "requeue"
  /** Claimed and lease run out, with no claims left or too long ago: failed. */
  | "fail";

export function commandLeaseDisposition(
  command: CommandLeaseView,
  now: Date,
): CommandLeaseDisposition {
  if (command.status !== "claimed") return "keep";
  // A claim with no timestamp has no lease to honour; it is treated as long
  // expired rather than as fresh.
  const age = now.getTime() - (command.claimedAt?.getTime() ?? 0);
  if (age < COMMAND_CLAIM_LEASE_MS) return "keep";
  if (command.attempts >= COMMAND_MAX_CLAIMS || age >= COMMAND_REQUEUE_WINDOW_MS) return "fail";
  return "requeue";
}

type LeaseWhere = {
  userId: string;
  deviceId: string;
  status: "claimed";
  OR: Array<
    | { claimedAt: { lt: Date }; attempts?: { gte: number } }
    | { claimedAt: null }
  >;
} | {
  userId: string;
  deviceId: string;
  status: "claimed";
  claimedAt: { lt: Date; gte: Date };
  attempts: { lt: number };
};

/** The one operation the sweep needs, shaped like Prisma's `updateMany`. */
export type CommandLeaseStore = {
  codeSessionCommand: {
    updateMany(args: {
      where: LeaseWhere;
      data:
        | { status: "failed"; error: string; completedAt: Date }
        | { status: "pending"; claimedAt: null };
    }): Promise<{ count: number }>;
  };
};

/**
 * Settles every expired claim for one device, exactly as
 * `commandLeaseDisposition` would: fails those out of claims or too old,
 * re-queues the rest. Run by the host's own long poll before it looks for
 * work, so an expired claim is handed straight back to the Mac that is asking.
 *
 * Fails first, so the re-queue's conditions never have to exclude them.
 */
export async function sweepExpiredCommandClaims(
  db: CommandLeaseStore,
  scope: { userId: string; deviceId: string },
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number }> {
  const leaseCutoff = new Date(now.getTime() - COMMAND_CLAIM_LEASE_MS);
  const staleCutoff = new Date(now.getTime() - COMMAND_REQUEUE_WINDOW_MS);
  const failed = await db.codeSessionCommand.updateMany({
    where: {
      ...scope,
      status: "claimed",
      OR: [
        { claimedAt: { lt: leaseCutoff }, attempts: { gte: COMMAND_MAX_CLAIMS } },
        { claimedAt: { lt: staleCutoff } },
        { claimedAt: null },
      ],
    },
    data: { status: "failed", error: COMMAND_LEASE_EXHAUSTED_ERROR, completedAt: now },
  });
  const requeued = await db.codeSessionCommand.updateMany({
    where: {
      ...scope,
      status: "claimed",
      claimedAt: { lt: leaseCutoff, gte: staleCutoff },
      attempts: { lt: COMMAND_MAX_CLAIMS },
    },
    data: { status: "pending", claimedAt: null },
  });
  return { requeued: requeued.count, failed: failed.count };
}

/**
 * Which rows an acknowledgement may settle. A claimed command, obviously —
 * and one the lease has already re-queued but that was claimed before, since
 * its acknowledgement arriving late means the Mac did run it. Accepting that
 * late answer spares a second claim that would only be answered from the
 * Mac's ledger anyway.
 */
export const ACKNOWLEDGEABLE_COMMAND = {
  OR: [{ status: "claimed" }, { status: "pending", attempts: { gt: 0 } }],
};
