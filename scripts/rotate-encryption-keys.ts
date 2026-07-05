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

async function main() {
  console.log(DRY ? "Rotation dry-run (no writes)…" : "Rotating secrets onto the primary key…");
  const connections = await rotateConnections();
  const accounts = await rotateAccounts();
  const verb = DRY ? "would be re-sealed" : "re-sealed";
  console.log(`Connections ${verb}: ${connections.changed}` + (connections.failed ? ` (${connections.failed} FAILED)` : ""));
  console.log(`Accounts ${verb}:    ${accounts.changed}` + (accounts.failed ? ` (${accounts.failed} FAILED)` : ""));
  const failed = connections.failed + accounts.failed;
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
