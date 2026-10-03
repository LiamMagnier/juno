/**
 * Permanently delete one account by email, from the server: the same path as
 * Settings › Account › Delete and the admin panel (`deleteAccountPermanently`),
 * so billing is cancelled, every stored object the account owns is purged, and
 * the user row goes with everything that cascades from it.
 *
 * Run it on the VM from the live release, which has the .env:
 *
 *   cd ~/juno/current
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/delete-account.ts someone@example.com
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/delete-account.ts someone@example.com --confirm
 *
 * Without --confirm it only prints what the account holds. Matching is
 * case-insensitive. A missing account is reported, not an error.
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

async function main() {
  const email = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const confirm = process.argv.includes("--confirm");
  if (!email) {
    console.error("usage: tsx scripts/delete-account.ts <email> [--confirm]");
    process.exit(2);
  }

  // Env must be in place before the lib chain loads — import inside main.
  const { prisma } = await import("../src/lib/prisma");
  const { deleteAccountPermanently } = await import("../src/app/api/account/delete-account");

  const users = await prisma.user.findMany({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, email: true, image: true, name: true, createdAt: true },
  });
  if (users.length === 0) {
    console.log(`No account with the email ${email}. Nothing to delete.`);
    process.exit(0);
  }

  for (const user of users) {
    const [conversations, projects, attachments] = await Promise.all([
      prisma.conversation.count({ where: { userId: user.id } }),
      prisma.project.count({ where: { userId: user.id } }),
      prisma.attachment.count({ where: { userId: user.id } }),
    ]);
    console.log(
      `${user.email} (${user.name ?? "no name"}), created ${user.createdAt.toISOString()}: ` +
        `${conversations} chats, ${projects} projects, ${attachments} files`
    );
    if (!confirm) continue;
    const report = await deleteAccountPermanently(user);
    console.log(
      `Deleted. ${report.purgedObjects} stored objects purged` +
        (report.failedObjects ? `, ${report.failedObjects} could not be purged` : "") +
        "."
    );
  }
  if (!confirm) console.log("\nDry run: nothing deleted. Add --confirm to delete permanently.");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
