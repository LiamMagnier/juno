/**
 * The account the agents journey (e2e/agents-journey.spec.ts) runs as, made
 * fresh in a LOCAL database.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/seed-agents-journey.ts
 *
 * A dedicated account rather than the shared E2E one, for two reasons:
 *
 *   - the journey's Work runs are driven by the scripted Work model
 *     (src/lib/dev/scripted-work-model.ts), which applies only to the accounts
 *     listed in WORK_SCRIPTED_MODEL_USERS. Listing only this one keeps every
 *     other account on the dev server exactly as it was;
 *   - "Needs you" is asserted to be empty before the journey and to hold
 *     exactly the journey's ask in the middle of it, which only a clean
 *     account can promise.
 *
 * Every run deletes the account (its rows cascade with it) and makes it again
 * with a MAX subscription, so the journey always starts from nothing. It
 * refuses any database that is not on this machine, and it only ever deletes
 * the one account it made, recognised by its .test address AND its name.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import {
  AGENTS_JOURNEY_EMAIL,
  AGENTS_JOURNEY_NAME,
  AGENTS_JOURNEY_PASSWORD,
  localDatabaseProblem,
} from "../e2e/support/agents-journey-account";

async function main(): Promise<void> {
  const problem = localDatabaseProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);
  if (!AGENTS_JOURNEY_EMAIL.endsWith(".test")) throw new Error("The agents journey account must use a .test address.");

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email: AGENTS_JOURNEY_EMAIL }, select: { id: true, name: true } });
    if (existing) {
      if (existing.name !== AGENTS_JOURNEY_NAME) {
        throw new Error(`${AGENTS_JOURNEY_EMAIL} exists and was not made by this script; nothing was deleted.`);
      }
      await prisma.user.delete({ where: { id: existing.id } });
    }
    const user = await prisma.user.create({
      data: {
        email: AGENTS_JOURNEY_EMAIL,
        emailVerified: new Date(),
        name: AGENTS_JOURNEY_NAME,
        hashedPassword: await hashPassword(AGENTS_JOURNEY_PASSWORD),
      },
      select: { id: true, email: true },
    });
    // MAX: a plan that includes agents (src/lib/agents/plan-gate.ts) and cloud Work.
    await prisma.subscription.create({
      data: { userId: user.id, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
    });
    // The sign-in limiter's buckets for this address, so the spec's one sign-in
    // is never refused by an earlier run's attempts.
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "signin:pair:", endsWith: `:${AGENTS_JOURNEY_EMAIL}` } } });
    console.log(JSON.stringify({ seeded: user.email, userId: user.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
