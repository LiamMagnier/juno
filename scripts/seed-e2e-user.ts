// Seeds a dedicated Playwright E2E user directly in the local dev database.
// Run with: NODE_OPTIONS=--conditions=react-server tsx scripts/seed-e2e-user.ts
// The account uses the production password scheme (v2 bcrypt over SHA-256),
// so the UI sign-in path exercises the real credential path, not a test hook.
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const EMAIL = "e2e@juno.test";
const PASSWORD = "E2E-Test-Password-2026!";

const prisma = new PrismaClient();

async function main() {
  const hashed = await hashPassword(PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {
      hashedPassword: hashed,
      emailVerified: new Date(),
      name: "E2E Test User",
      bannedAt: null,
    },
    create: {
      email: EMAIL,
      emailVerified: new Date(),
      name: "E2E Test User",
      hashedPassword: hashed,
    },
  });
  console.log(`E2E user ready: ${user.email} (${user.id})`);

  // Ensure active PRO subscription so E2E tests have full message and feature budget
  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: { plan: "PRO", status: "ACTIVE" },
    create: { userId: user.id, plan: "PRO", status: "ACTIVE" },
  });

  // Reset usage counters
  await prisma.usage.deleteMany({
    where: { userId: user.id },
  });

  // Clear the credentials sign-in rate-limit bucket for this account so the
  // Playwright setup step can authenticate immediately after seeding, no
  // matter how many failed/throttled attempts a previous run made.
  const cleared = await prisma.rateLimit.deleteMany({
    where: { key: { startsWith: `signin:email:${EMAIL}` } },
  });
  console.log(`Cleared ${cleared.count} sign-in rate-limit bucket(s) for ${EMAIL}`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});