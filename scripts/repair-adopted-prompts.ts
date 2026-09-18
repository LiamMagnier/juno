/**
 * Puts the plaintext back into routines an earlier sweep adopted from ciphertext.
 *
 * `ScheduledTask.prompt` is sealed at rest, and until this wave
 * `scripts/work-scheduler.ts` handed the raw Prisma row to `planTaskMigration`.
 * The routines that sweep created therefore hold `enc:v2:<base64>` in
 * `WorkSchedule.instructions` and in the `WorkSession.goal` beside it — they
 * fire on the right morning, spend real money, and instruct the run with a
 * base64 blob.
 *
 * Fixing the sweep does nothing for those rows: it skips a task that already
 * has a routine, and always will. So this is a one-off pass over exactly the
 * routines the sweep created (`legacyScheduledTaskId` is not null), which is
 * also why it does not touch a routine somebody wrote by hand — those were
 * never sealed, and `decryptField` would return them unchanged anyway.
 *
 *   npm run work:repair-prompts            # apply
 *   npm run work:repair-prompts -- --dry   # report, write nothing
 *
 * Idempotent: a routine already holding plaintext is `leave`, which costs a
 * read and no write, so running it twice is running it once. The per-row
 * decision is `planAdoptedPromptRepair` in src/lib/work/schedule.ts, tested
 * there without a database.
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script),
 * because field-crypto's keyring loads through the app's env module.
 */
import { prismaUnguarded } from "@/lib/db";
import { decryptField } from "@/lib/field-crypto";
import { planAdoptedPromptRepair } from "@/lib/work/schedule";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");

/** One page of routines per round trip; the table is small and bounded by the
 *  number of legacy tasks that ever existed, but a full read is still a full
 *  read. */
const PAGE = 200;

/** The columns the repair reads and writes back. */
interface AdoptedRow {
  id: string;
  userId: string;
  sessionId: string;
  instructions: string;
}

async function main(): Promise<void> {
  let cursor: string | null = null;
  let rewritten = 0;
  let paused = 0;
  let untouched = 0;

  for (;;) {
    // Cross-account by nature — this walks every user's adopted routines — so
    // it says so rather than tripping the guard whose whole job is to notice a
    // query that forgot its userId.
    const page: AdoptedRow[] = await prismaUnguarded.workSchedule.findMany({
      where: { legacyScheduledTaskId: { not: null } },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: PAGE,
      select: { id: true, userId: true, sessionId: true, instructions: true },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const schedule of page) {
      const repair = planAdoptedPromptRepair(
        schedule.instructions,
        decryptField(schedule.instructions)
      );
      if (repair.action === "leave") {
        untouched += 1;
        continue;
      }
      if (repair.action === "pause") {
        // No plaintext to put back: the key that sealed it is off the ring. A
        // routine left running would bill somebody every morning to act on the
        // words "[encrypted field could not be decrypted]", so it is switched
        // off and named here — the same call `planTaskMigration` makes when it
        // refuses such a task outright.
        paused += 1;
        console.warn(
          `[repair-adopted-prompts] ${schedule.id}: the prompt cannot be decrypted — pausing the routine`
        );
        if (!DRY) {
          await prismaUnguarded.workSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false },
          });
        }
        continue;
      }

      rewritten += 1;
      if (DRY) continue;
      // Both halves in one transaction. The goal is what a Work run is
      // validated against and the instructions are what it is given, so a pass
      // that fixed one and died before the other would leave the routine
      // disagreeing with itself about what it is for.
      await prismaUnguarded.$transaction([
        prismaUnguarded.workSchedule.update({
          where: { id: schedule.id },
          data: { instructions: repair.prompt },
        }),
        prismaUnguarded.workSession.updateMany({
          where: { id: schedule.sessionId, userId: schedule.userId },
          data: { goal: repair.prompt },
        }),
      ]);
    }

    if (page.length < PAGE) break;
  }

  console.log(
    `[repair-adopted-prompts] ${DRY ? "would rewrite" : "rewrote"} ${rewritten}, ` +
      `${DRY ? "would pause" : "paused"} ${paused}, left ${untouched} alone`
  );
  await prismaUnguarded.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
