/**
 * Re-encrypt every secret-at-rest under the current primary key.
 *
 * Run after adding a new key and setting TOKEN_ENCRYPTION_PRIMARY (see
 * src/lib/crypto.ts). Rows already sealed with the primary key are skipped, so
 * the script is idempotent and safe to re-run.
 *
 *   npm run crypto:rotate            # apply
 *   npm run crypto:rotate -- --dry   # report what would change, write nothing
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script) so
 * the `server-only` guard in the crypto import chain resolves to a no-op.
 */
import { prismaUnguarded } from "@/lib/db";
import { isSealedWithPrimary, reencryptSecret } from "@/lib/crypto";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");

/** Re-seal one ciphertext column; returns the new value or null if unchanged. */
function rotate(value: string | null): string | null {
  if (!value) return null;
  if (isSealedWithPrimary(value)) return null;
  return reencryptSecret(value);
}

type Tally = { changed: number; failed: number };

async function rotateConnections(): Promise<Tally> {
  const rows = await prismaUnguarded.connection.findMany({
    select: { id: true, accessToken: true, refreshToken: true, oauthClientSecret: true },
  });
  let changed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const data: Record<string, string> = {};
      const accessToken = rotate(row.accessToken);
      const refreshToken = rotate(row.refreshToken);
      const oauthClientSecret = rotate(row.oauthClientSecret);
      if (accessToken) data.accessToken = accessToken;
      if (refreshToken) data.refreshToken = refreshToken;
      if (oauthClientSecret) data.oauthClientSecret = oauthClientSecret;
      if (Object.keys(data).length === 0) continue;
      changed++;
      if (!DRY) await prismaUnguarded.connection.update({ where: { id: row.id }, data });
    } catch (err) {
      // One un-rotatable row (e.g. its sealing key was dropped too early) must
      // not silently halt the backfill — record it and keep going.
      failed++;
      console.error(`  ✗ connection ${row.id}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

async function rotateAccounts(): Promise<Tally> {
  const rows = await prismaUnguarded.account.findMany({
    select: { id: true, access_token: true, refresh_token: true, id_token: true },
  });
  let changed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const data: Record<string, string> = {};
      const access_token = rotate(row.access_token);
      const refresh_token = rotate(row.refresh_token);
      const id_token = rotate(row.id_token);
      if (access_token) data.access_token = access_token;
      if (refresh_token) data.refresh_token = refresh_token;
      if (id_token) data.id_token = id_token;
      if (Object.keys(data).length === 0) continue;
      changed++;
      if (!DRY) await prismaUnguarded.account.update({ where: { id: row.id }, data });
    } catch (err) {
      failed++;
      console.error(`  ✗ account ${row.id}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

/**
 * User MCP servers keep their Authorization header sealed in `authHeader`.
 * This table was missed when it shipped, so a rotation that then retired the
 * old key left those headers unreadable, and the server was dialled without
 * one (src/lib/mcp.ts now skips such a row instead).
 */
async function rotateUserMcpServers(): Promise<Tally> {
  const rows = await prismaUnguarded.userMcpServer.findMany({
    where: { authHeader: { not: null } },
    select: { id: true, authHeader: true },
  });
  let changed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const authHeader = rotate(row.authHeader);
      if (!authHeader) continue;
      changed++;
      if (!DRY) await prismaUnguarded.userMcpServer.update({ where: { id: row.id }, data: { authHeader } });
    } catch (err) {
      failed++;
      console.error(`  ✗ user MCP server ${row.id}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

async function main() {
  console.log(DRY ? "Rotation dry-run (no writes)…" : "Rotating secrets onto the primary key…");
  const connections = await rotateConnections();
  const accounts = await rotateAccounts();
  const userMcpServers = await rotateUserMcpServers();
  const verb = DRY ? "would be re-sealed" : "re-sealed";
  console.log(`Connections ${verb}: ${connections.changed}` + (connections.failed ? ` (${connections.failed} FAILED)` : ""));
  console.log(`Accounts ${verb}:    ${accounts.changed}` + (accounts.failed ? ` (${accounts.failed} FAILED)` : ""));
  console.log(
    `User MCP servers ${verb}: ${userMcpServers.changed}` + (userMcpServers.failed ? ` (${userMcpServers.failed} FAILED)` : "")
  );
  const failed = connections.failed + accounts.failed + userMcpServers.failed;
  if (failed > 0) {
    console.error(`\n${failed} row(s) could not be rotated — keep every old key in TOKEN_ENCRYPTION_KEYS until this reports 0 failures, then re-run.`);
    process.exitCode = 1;
  } else {
    console.log("Done — all rows sealed under the primary key.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prismaUnguarded.$disconnect());
