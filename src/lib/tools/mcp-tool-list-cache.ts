/**
 * A short-lived, per-process memory of each connector's `tools/list` answer.
 *
 * WHY. A chat turn with connectors used to connect to every MCP server and
 * ask for its tool list before the provider was called, on every turn: one
 * handshake and one list per server, in the path to the first token. The
 * list rarely changes between two messages a minute apart, so a chat turn
 * (`openMcpToolset` with `cacheTools`) reuses a recent answer and does not
 * dial a cached server at all until the model calls one of its tools.
 *
 * WHAT A KEY IS. One user, one connector, one endpoint, one version of the
 * connector: `version` is what the tool list depends on, as a stable string
 * (`ActiveConnector.toolListVersion`: the connector row's `updatedAt`, which
 * moves when the person edits, re-links or refreshes it). Without a version
 * the headers stand in for it, so a credential that changes is a new entry.
 * A key never holds a credential: the endpoint and the version are hashed.
 * Nothing is shared between users, even for the same first-party connector.
 *
 * WHAT IT NEVER DOES. It decides nothing about permission: the connectors a
 * turn may reach are resolved from the database every turn
 * (`getActiveConnectors`), a switched-off tool is filtered after the cache,
 * and every call still goes through the broker. An entry lives
 * `MCP_TOOL_LIST_CACHE_SECONDS` (default 300; 0 turns the cache off) and is
 * dropped as soon as its server fails to connect.
 *
 * Pure (no `server-only`, no I/O): tests/mcp-open-bounds.test.ts drives it.
 */

import { createHash } from "node:crypto";

/** The parts of one MCP tool the toolset reads; nothing else is kept. */
export interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolListCacheKeyInput {
  userId: string;
  connectorId: string;
  mcpUrl: string;
  headers: Record<string, string>;
  /** `ActiveConnector.toolListVersion`. */
  version?: string;
}

/** Default lifetime of an entry: a few minutes. */
export const DEFAULT_MCP_TOOL_LIST_CACHE_SECONDS = 300;
/** The most entries one process keeps; the oldest goes first. */
export const MCP_TOOL_LIST_CACHE_MAX_ENTRIES = 200;

/**
 * `MCP_TOOL_LIST_CACHE_SECONDS`, in ms: default 300 s, bounded 0 to 3600 s.
 * 0 turns the cache off (every chat turn lists every server, as before).
 */
export function mcpToolListCacheTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MCP_TOOL_LIST_CACHE_SECONDS;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const seconds = Number.isFinite(value) ? Math.min(3600, Math.max(0, Math.round(value))) : DEFAULT_MCP_TOOL_LIST_CACHE_SECONDS;
  return seconds * 1000;
}

function stableHeaders(headers: Record<string, string>): string {
  return JSON.stringify(Object.keys(headers).sort().map((name) => [name.toLowerCase(), headers[name]]));
}

const SEP = "\u0000";

/** The cache key: readable user and connector, hashed endpoint and version. */
export function mcpToolListCacheKey(input: McpToolListCacheKeyInput): string {
  const depends = input.version !== undefined ? `v${SEP}${input.version}` : `h${SEP}${stableHeaders(input.headers)}`;
  const digest = createHash("sha256").update(`${input.mcpUrl}${SEP}${depends}`).digest("hex").slice(0, 32);
  return `${input.userId}${SEP}${input.connectorId}${SEP}${digest}`;
}

/** Only the fields `openMcpToolset` reads, copied so a caller cannot change an entry. */
export function pickCachedMcpTool(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}): CachedMcpTool {
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object"
      ? { inputSchema: structuredClone(tool.inputSchema) as Record<string, unknown> }
      : {}),
    ...(tool.annotations && typeof tool.annotations === "object"
      ? { annotations: structuredClone(tool.annotations) as Record<string, unknown> }
      : {}),
  };
}

export interface McpToolListCache {
  /** The tools listed for this key within the lifetime, or undefined. */
  get(key: string): readonly CachedMcpTool[] | undefined;
  set(key: string, tools: readonly CachedMcpTool[]): void;
  /** Forgets one key (its server failed to connect). */
  delete(key: string): void;
  /** Forgets every entry of a user, or of one of their connectors. */
  invalidate(userId: string, connectorId?: string): number;
  clear(): void;
  readonly size: number;
}

export function createMcpToolListCache(options: {
  ttlMs: () => number;
  maxEntries?: number;
  now?: () => number;
}): McpToolListCache {
  const entries = new Map<string, { at: number; tools: readonly CachedMcpTool[] }>();
  const now = options.now ?? Date.now;
  const max = Math.max(1, options.maxEntries ?? MCP_TOOL_LIST_CACHE_MAX_ENTRIES);
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const ttl = options.ttlMs();
      if (ttl <= 0 || now() - entry.at >= ttl) {
        entries.delete(key);
        return undefined;
      }
      return entry.tools.map((tool) => pickCachedMcpTool(tool));
    },
    set(key, tools) {
      if (options.ttlMs() <= 0) return;
      entries.delete(key);
      entries.set(key, { at: now(), tools: Object.freeze(tools.map((tool) => pickCachedMcpTool(tool))) });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    invalidate(userId, connectorId) {
      const prefix = connectorId === undefined ? `${userId}${SEP}` : `${userId}${SEP}${connectorId}${SEP}`;
      let removed = 0;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
