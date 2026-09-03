// Seeds a dedicated Playwright E2E user directly in the local dev database.
// Run with: NODE_OPTIONS=--conditions=react-server tsx scripts/seed-e2e-user.ts
// The account uses the production password scheme (v2 bcrypt over SHA-256),
// so the UI sign-in path exercises the real credential path, not a test hook.
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import { encryptMessageText } from "../src/lib/message-crypto";

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
    where: { key: { startsWith: "signin:pair:", endsWith: `:${EMAIL}` } },
  });
  console.log(`Cleared ${cleared.count} sign-in rate-limit bucket(s) for ${EMAIL}`);

  await seedShowroom(user.id);
  await prisma.$disconnect();
}

/**
 * A project with files and chats, so `/projects/[id]` and `/share/[token]`
 * render with data in screenshots and Playwright without depending on leftovers
 * from an interactive session. Idempotent: the project upserts on a stable
 * import source id, the chat upserts on its client request id, and the chat's
 * messages are rebuilt deterministically on every run.
 */
async function seedShowroom(userId: string) {
  const project = await prisma.project.upsert({
    where: { userId_importSourceId: { userId, importSourceId: "e2e-showroom" } },
    update: { name: "E2E Showroom" },
    create: {
      userId,
      name: "E2E Showroom",
      instructions: "You are the showroom assistant. Answer briefly and with one example.",
      importSourceId: "e2e-showroom",
    },
  });

  const conversation = await prisma.conversation.upsert({
    where: { userId_clientRequestId: { userId, clientRequestId: "e2e-showroom-chat" } },
    update: { projectId: project.id, title: "Showroom tour" },
    create: {
      userId,
      projectId: project.id,
      clientRequestId: "e2e-showroom-chat",
      title: "Showroom tour",
    },
  });

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  const now = Date.now();
  await prisma.message.createMany({
    data: [
      {
        conversationId: conversation.id,
        clientId: "e2e-showroom-user",
        role: "USER",
        content: encryptMessageText("What can you build in this showroom?"),
        createdAt: new Date(now - 60_000),
      },
      {
        conversationId: conversation.id,
        clientId: "e2e-showroom-assistant",
        role: "ASSISTANT",
        model: "anthropic:claude-sonnet-5",
        content: encryptMessageText(
          "I can build pages, diagrams, and code. Ask for a landing page and it appears beside the chat."
        ),
        createdAt: new Date(now - 30_000),
      },
    ],
  });

  await prisma.attachment.upsert({
    where: { id: "e2e-showroom-notes" },
    update: {},
    create: {
      id: "e2e-showroom-notes",
      userId,
      projectId: project.id,
      conversationId: conversation.id,
      kind: "FILE",
      fileName: "showroom-notes.md",
      mimeType: "text/markdown",
      size: 96,
      // No bytes behind this key: the row exists so the project's files tab
      // and the library render with data. Downloads of seeded rows 404.
      storageKey: "e2e/showroom-notes.md",
      extractedText: "# Showroom notes\n\nSeeded with the E2E account for screenshots.",
    },
  });

  const share = await prisma.share.upsert({
    where: { token: "e2e-showroom" },
    update: { conversationId: conversation.id, revokedAt: null, title: "Showroom tour" },
    create: {
      token: "e2e-showroom",
      userId,
      kind: "CHAT",
      conversationId: conversation.id,
      title: "Showroom tour",
    },
  });

  console.log(
    `Showroom ready: project ${project.id}, conversation ${conversation.id}, share /share/${share.token}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
