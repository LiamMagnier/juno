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
import { isBoundSealedWithPrimary, isSealedWithPrimary, reencryptSecret, reencryptSecretBound } from "@/lib/crypto";
import { credentialContext } from "@/lib/secrets/store";
import { agentCredentialContext } from "@/lib/computer/vault-policy";

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

/**
 * Alevr Secrets credentials are sealed with their owner and id as additional
 * data (encryptSecretBound), so they are re-sealed with that same context. A
 * revoked row's value has already been overwritten and is skipped.
 */
async function rotateSecretCredentials(): Promise<Tally> {
  const rows = await prismaUnguarded.secretCredential.findMany({
    where: { revokedAt: null },
    select: { id: true, userId: true, sealed: true },
  });
  let changed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      if (isBoundSealedWithPrimary(row.sealed)) continue;
      const sealed = reencryptSecretBound(row.sealed, credentialContext(row.userId, row.id));
      changed++;
      if (!DRY) {
        await prismaUnguarded.secretCredential.updateMany({ where: { id: row.id, userId: row.userId }, data: { sealed } });
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ saved login ${row.id}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

/**
 * Agents' saved logins (docs/design/agents-v2/VAULT.md): each of the three
 * values is sealed with its owner, agent, row and field as additional data,
 * and re-sealed with that same context.
 */
async function rotateAgentCredentials(): Promise<Tally> {
  const rows = await prismaUnguarded.agentCredential.findMany({
    select: { id: true, userId: true, agentId: true, usernameSealed: true, passwordSealed: true, totpSealed: true },
  });
  let changed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const reseal = (value: string, field: "username" | "password" | "totp") =>
        isBoundSealedWithPrimary(value) ? null : reencryptSecretBound(value, agentCredentialContext(row.userId, row.agentId, row.id, field));
      const data: { usernameSealed?: string; passwordSealed?: string; totpSealed?: string } = {};
      const username = reseal(row.usernameSealed, "username");
      const password = reseal(row.passwordSealed, "password");
      const totp = row.totpSealed ? reseal(row.totpSealed, "totp") : null;
      if (username) data.usernameSealed = username;
      if (password) data.passwordSealed = password;
      if (totp) data.totpSealed = totp;
      if (Object.keys(data).length === 0) continue;
      changed++;
      if (!DRY) {
        await prismaUnguarded.agentCredential.updateMany({ where: { id: row.id, userId: row.userId, agentId: row.agentId }, data });
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ agent saved login ${row.id}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

async function main() {
  console.log(DRY ? "Rotation dry-run (no writes)…" : "Rotating secrets onto the primary key…");
  const connections = await rotateConnections();
  const accounts = await rotateAccounts();
  const userMcpServers = await rotateUserMcpServers();
  const secretCredentials = await rotateSecretCredentials();
  const agentCredentials = await rotateAgentCredentials();
  const verb = DRY ? "would be re-sealed" : "re-sealed";
  console.log(`Connections ${verb}: ${connections.changed}` + (connections.failed ? ` (${connections.failed} FAILED)` : ""));
  console.log(`Accounts ${verb}:    ${accounts.changed}` + (accounts.failed ? ` (${accounts.failed} FAILED)` : ""));
  console.log(
    `User MCP servers ${verb}: ${userMcpServers.changed}` + (userMcpServers.failed ? ` (${userMcpServers.failed} FAILED)` : "")
  );
  console.log(
    `Saved logins ${verb}: ${secretCredentials.changed}` + (secretCredentials.failed ? ` (${secretCredentials.failed} FAILED)` : "")
  );
  console.log(
    `Agents' saved logins ${verb}: ${agentCredentials.changed}` + (agentCredentials.failed ? ` (${agentCredentials.failed} FAILED)` : "")
  );
  const failed = connections.failed + accounts.failed + userMcpServers.failed + secretCredentials.failed + agentCredentials.failed;
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
