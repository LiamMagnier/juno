import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { probeMcpEndpoint, type McpProbeResult } from "@/lib/mcp-probe";
import { safeMcpFetch, userMcpUrlProblem } from "@/lib/mcp-safe-fetch";

/*
 * User-registered remote MCP servers (URL + optional Authorization header).
 *
 * Native connectors live in connectors.ts as a closed union; Composio covers
 * the managed long tail. This is the third shape: an arbitrary Streamable HTTP
 * MCP endpoint the account owns. Ids reach chat/agents as `user_mcp:<cuid>` so
 * they never collide with a registry ConnectorId or a Composio app id.
 *
 * ENABLE IS THIS ROW'S `enabled` COLUMN, and nothing else. Connections used to
 * keep a second "Use in chats" switch in localStorage (`juno:mcp:enabled`) next
 * to Settings' real `blockedConnectors`, so the same question had two answers
 * on two machines. A user MCP server has ONE switch: off means it is not in
 * getActiveConnectors and not offered in pickers. Account-wide hard blocks stay
 * in Settings.blockedConnectors, which every connector id already respects.
 */

export const USER_MCP_ID_PREFIX = "user_mcp:";

export function userMcpConnectorId(rowId: string): string {
  return `${USER_MCP_ID_PREFIX}${rowId}`;
}

/** True for `user_mcp:<id>` connector ids, which never appear in Connection. */
export function isUserMcpConnectorId(id: string): boolean {
  return id.startsWith(USER_MCP_ID_PREFIX);
}

export function userMcpRowId(connectorId: string): string | null {
  if (!isUserMcpConnectorId(connectorId)) return null;
  const rowId = connectorId.slice(USER_MCP_ID_PREFIX.length);
  return rowId.length > 0 ? rowId : null;
}

export { userMcpUrlProblem };

/**
 * Whether a URL may be saved or dialled as a user MCP server: https to a
 * public host, and `http://localhost` only in development. The rules, and
 * why each exists, live with the fetcher that enforces them again on every
 * request (`userMcpUrlProblem`, src/lib/mcp-safe-fetch.ts). This used to check
 * the scheme alone and accepted `http://localhost` in production, which made
 * the Test button a way to reach the VM's own services.
 */
export function isAllowedMcpUrl(raw: string): boolean {
  return userMcpUrlProblem(raw) === null;
}

/** Build the request headers for one server. Empty means "connect anonymous". */
export function headersForServer(authHeader: string | null | undefined): Record<string, string> {
  const value = (authHeader ?? "").trim();
  return value ? { Authorization: value } : {};
}

export function decryptAuthHeader(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    return decryptSecret(sealed);
  } catch {
    // Key rotated / corrupt: treat as missing rather than failing the whole list.
    return null;
  }
}

export function encryptAuthHeader(plain: string | null | undefined): string | null {
  const value = (plain ?? "").trim();
  return value ? encryptSecret(value) : null;
}

export interface UserMcpServerDto {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  toolCount: number;
  tools: string[];
  accountLabel: string | null;
  hasAuthHeader: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Wire shape. Never includes the Authorization header, sealed or not. */
export function serializeUserMcpServer(row: {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: Date | null;
  toolCount: number;
  tools: string[];
  accountLabel: string | null;
  authHeader: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UserMcpServerDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    toolCount: row.toolCount,
    tools: row.tools,
    accountLabel: row.accountLabel,
    // Presence only: the UI shows a lock glyph, never a prefix of the secret.
    hasAuthHeader: !!row.authHeader,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type UserMcpTestResult = McpProbeResult;

/**
 * Probe one server definition (saved or still in the dialog). Same
 * `probeMcpEndpoint` a native-connector Test button will call later, so the
 * three surfaces cannot disagree about what "connected" means.
 */
export async function testUserMcpConnection(input: {
  url: string;
  authHeader?: string | null;
}): Promise<UserMcpTestResult> {
  const url = input.url.trim();
  const problem = userMcpUrlProblem(url);
  if (problem) return { ok: false, error: problem };
  return probeMcpEndpoint({ url, headers: headersForServer(input.authHeader), fetch: safeMcpFetch });
}

/**
 * Persist a test outcome on a saved row. `lastError` is written on failure and
 * CLEARED on success: a tile that still showed last Tuesday's timeout after a
 * green test would be lying in the alarming direction.
 */
export async function recordUserMcpTest(
  userId: string,
  id: string,
  result: UserMcpTestResult
): Promise<void> {
  await prisma.userMcpServer.update({
    where: { id, userId },
    data: result.ok
      ? {
          status: "ok",
          lastError: null,
          lastCheckedAt: new Date(),
          toolCount: result.toolCount,
          tools: result.toolNames.slice(0, 200),
          accountLabel: result.accountLabel,
        }
      : {
          status: "error",
          lastError: result.error,
          lastCheckedAt: new Date(),
          // Keep the previous tool snapshot: a network blip does not erase what
          // the server offered the last time it answered.
        },
  });
}
