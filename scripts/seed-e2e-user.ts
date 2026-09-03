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
 * A project with a few files and a couple of chats, so `/projects/[id]` and
 * `/share/[token]` render with data in screenshots and Playwright without
 * depending on leftovers from an interactive session. Idempotent: the project
 * upserts on a stable import source id, each chat upserts on its client
 * request id, and the chats' messages are rebuilt deterministically on every
 * run.
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

  const tour = await seedShowroomChat(userId, project.id, "e2e-showroom-chat", "Showroom tour", [
    { clientId: "e2e-showroom-user", role: "USER", content: "What can you build in this showroom?" },
    {
      clientId: "e2e-showroom-assistant",
      role: "ASSISTANT",
      model: "anthropic:claude-sonnet-5",
      content:
        "I can build pages, diagrams, and code. Ask for a landing page and it appears beside the chat.",
    },
  ]);

  // A second chat so the project page shows a conversation list, not a single
  // row, and the sidebar's project section has something to nest.
  await seedShowroomChat(userId, project.id, "e2e-showroom-chat-2", "Palette questions", [
    { clientId: "e2e-showroom-user-2", role: "USER", content: "Which palette should the landing page use?" },
    {
      clientId: "e2e-showroom-assistant-2",
      role: "ASSISTANT",
      model: "anthropic:claude-sonnet-5",
      content: "Start with the showroom neutrals and one accent. I applied it to the mock beside this chat.",
    },
  ]);

  // Project files: rows only, no bytes behind the storage keys — they exist so
  // the project's files tab and the library render with data. Downloads of
  // seeded rows 404.
  const files = [
    {
      id: "e2e-showroom-notes",
      // Tied to the tour chat so the chat's context panel shows an attachment.
      conversationId: tour.id,
      fileName: "showroom-notes.md",
      mimeType: "text/markdown",
      size: 96,
      storageKey: "e2e/showroom-notes.md",
      extractedText: "# Showroom notes\n\nSeeded with the E2E account for screenshots.",
    },
    {
      id: "e2e-showroom-brief",
      conversationId: null,
      fileName: "showroom-brief.md",
      mimeType: "text/markdown",
      size: 214,
      storageKey: "e2e/showroom-brief.md",
      extractedText:
        "# Showroom brief\n\nGoal: a landing page that screenshots well. One accent colour, generous whitespace.",
    },
    {
      id: "e2e-showroom-palette",
      conversationId: null,
      fileName: "palette.json",
      mimeType: "application/json",
      size: 128,
      storageKey: "e2e/showroom-palette.json",
      extractedText: '{\n  "background": "#faf9f7",\n  "ink": "#1c1b1a",\n  "accent": "#c96f4a"\n}',
    },
  ];
  for (const file of files) {
    await prisma.attachment.upsert({
      where: { id: file.id },
      update: {},
      create: { ...file, userId, projectId: project.id, kind: "FILE" },
    });
  }

  // A share link for the tour chat, so /share/<token> renders for screenshots
  // without going through the share API. The slug must clear the lookup's
  // 16-character minimum (short tokens are junk-URL-gated), hence the suffix.
  const share = await prisma.share.upsert({
    where: { token: "e2e-showroom-tour-2026" },
    update: { conversationId: tour.id, revokedAt: null, title: "Showroom tour" },
    create: {
      token: "e2e-showroom-tour-2026",
      userId,
      kind: "CHAT",
      conversationId: tour.id,
      title: "Showroom tour",
    },
  });

  // Remove the pre-fix short token if a previous seed created it: it falls
  // under the share lookup's 16-character junk-URL gate and can never render.
  await prisma.share.deleteMany({ where: { token: "e2e-showroom" } });

  console.log(
    `Showroom ready: project ${project.id}, 2 chats, ${files.length} files, share /share/${share.token}`
  );
}

/**
 * One showroom chat, upserted on its client request id with its messages
 * rebuilt deterministically (delete + recreate, so re-runs never duplicate or
 * drift). Messages are spaced a minute apart ending "now".
 */
async function seedShowroomChat(
  userId: string,
  projectId: string,
  clientRequestId: string,
  title: string,
  turns: { clientId: string; role: "USER" | "ASSISTANT"; model?: string; content: string }[]
) {
  const conversation = await prisma.conversation.upsert({
    where: { userId_clientRequestId: { userId, clientRequestId } },
    update: { projectId, title },
    create: { userId, projectId, clientRequestId, title },
  });

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  const end = Date.now();
  const step = 60_000;
  await prisma.message.createMany({
    data: turns.map((turn, index) => ({
      conversationId: conversation.id,
      clientId: turn.clientId,
      role: turn.role,
      ...(turn.model ? { model: turn.model } : {}),
      content: encryptMessageText(turn.content),
      createdAt: new Date(end - (turns.length - index) * step),
    })),
  });

  return conversation;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
