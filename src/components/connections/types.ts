export interface ConnectorStatus {
  id: string;
  kind: string;
  label: string;
  description: string;
  capability: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: string | null;
  /**
   * user_mcp only. Tool names from the last successful test, so a picker or
   * the directory can say what the server offers without opening a connection.
   */
  tools?: string[];
  /** user_mcp: the account's own enable switch (server-side, not localStorage). */
  enabled?: boolean;
  /** user_mcp: untested | ok | error from the last test. */
  status?: string | null;
  /** user_mcp: why the last test failed. Cleared when a test passes. */
  lastError?: string | null;
  toolCount?: number;
  lastCheckedAt?: string | null;
}

/**
 * One user-registered remote MCP server, as returned by /api/mcp/servers.
 * The Authorization header is never present; `hasAuthHeader` is presence only.
 */
export interface UserMcpServerStatus {
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
