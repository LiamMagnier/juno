import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { probeMcpEndpoint, type McpProbeResult } from "@/lib/mcp-probe";

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

/**
 * Accept https anywhere, and http only on loopback so local dev can point at
 * `http://localhost:3001/mcp` without opening the product to cleartext
 * credential exfiltration on the open internet. The auth header is a live
 * credential; sending it over plain http to a remote host is the bug this
 * check exists to refuse.
 */
export function isAllowedMcpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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
  if (!isAllowedMcpUrl(url)) {
    return { ok: false, error: "Use an https URL, or http only on localhost." };
  }
  return probeMcpEndpoint({ url, headers: headersForServer(input.authHeader) });
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
