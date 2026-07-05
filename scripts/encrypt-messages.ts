/**
 * One-off migration: encrypt all plaintext Message.content / Message.reasoning
 * rows at rest (AES-256-GCM, see src/lib/message-crypto.ts).
 *
 *   npx tsx scripts/encrypt-messages.ts            # encrypt everything pending
 *   npx tsx scripts/encrypt-messages.ts --dry-run  # print counts only, write nothing
 *
 * Idempotent: rows already carrying the enc:v1: prefix are skipped, so it is
 * safe to re-run (e.g. after a partial run or to sweep rows written by an old
 * process during a rolling deploy). Works in batches of 500 with progress logs.
 *
 * PRODUCTION: run this ONCE on the VM after deploying the message-crypto
 * change, from the app directory (so .env provides DATABASE_URL and
 * AUTH_SECRET / DATA_ENCRYPTION_KEY):
 *
 *   npx tsx scripts/encrypt-messages.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// —— Env loading (.env then .env.local; never override already-set keys) ——
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

const BATCH_SIZE = 500;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  // Env must be in place before the lib chain loads — import inside main.
  const { prisma } = await import("../src/lib/prisma");
  const { encryptMessageText, MESSAGE_ENC_PREFIX } = await import("../src/lib/message-crypto");

  // A row is pending when its content OR its (non-null) reasoning is plaintext.
  const pendingWhere = {
    OR: [
      { NOT: { content: { startsWith: MESSAGE_ENC_PREFIX } } },
      { AND: [{ reasoning: { not: null } }, { NOT: { reasoning: { startsWith: MESSAGE_ENC_PREFIX } } }] },
    ],
  };

  const [total, pending] = await Promise.all([
    prisma.message.count(),
    prisma.message.count({ where: pendingWhere }),
  ]);
  console.log(`${total} message rows total; ${pending} with plaintext content and/or reasoning.`);

  if (dryRun) {
    console.log("Dry run — nothing written.");
    process.exit(0);
  }
  if (pending === 0) {
    console.log("Nothing to do — every row is already enc:v1:.");
    process.exit(0);
  }

  let processed = 0;
  for (;;) {
    // Encrypted rows drop out of the filter, so plain take-N pagination drains it.
    const rows = await prisma.message.findMany({
      where: pendingWhere,
      select: { id: true, content: true, reasoning: true },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    await prisma.$transaction(
      rows.map((row) =>
        prisma.message.update({
          where: { id: row.id },
          data: {
            ...(row.content.startsWith(MESSAGE_ENC_PREFIX) ? {} : { content: encryptMessageText(row.content) }),
            ...(row.reasoning != null && !row.reasoning.startsWith(MESSAGE_ENC_PREFIX)
              ? { reasoning: encryptMessageText(row.reasoning) }
              : {}),
          },
        })
      )
    );
    processed += rows.length;
    console.log(`  encrypted ${processed}/${pending} rows…`);
  }

  console.log(`Done: ${processed} rows encrypted (${total} rows total).`);
  process.exit(0);
}

void main().catch((err) => {
  console.error("encrypt-messages failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
