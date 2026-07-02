/*
 * Mock data for the MCP dashboard (/connections). Tool names mirror the
 * server-side namespacing convention `<connectorId>__<tool>` (see lib/mcp.ts).
 * Swap for real data once tool listing / call logging is persisted.
 */

export interface McpToolInfo {
  name: string;
  description: string;
  paramCount: number;
}

export type LogStatus = "ok" | "error";

export interface LogEntry {
  id: string;
  /** ISO timestamp of the call. */
  at: string;
  connectorId: string;
  tool: string;
  status: LogStatus;
  durationMs: number;
  params: object;
  /** Raw result payload — usually a compact JSON string. */
  result: string;
}

export const MOCK_TOOLS: Record<string, McpToolInfo[]> = {
  github: [
    { name: "github__search_repositories", description: "Search repositories by keyword, owner, or topic.", paramCount: 3 },
    { name: "github__get_repository", description: "Read repository metadata, topics, and default branch.", paramCount: 2 },
    { name: "github__get_file_contents", description: "Read a file or directory listing from a repository.", paramCount: 4 },
    { name: "github__search_code", description: "Search code across indexed repositories.", paramCount: 3 },
    { name: "github__list_issues", description: "List issues with state, label, and assignee filters.", paramCount: 5 },
    { name: "github__get_pull_request", description: "Fetch a pull request with reviews and merge status.", paramCount: 3 },
    { name: "github__list_commits", description: "List commits on a branch, newest first.", paramCount: 4 },
  ],
  figma: [
    { name: "figma__get_design_context", description: "Extract structured design context from a frame or component.", paramCount: 3 },
    { name: "figma__get_screenshot", description: "Render a node as an image for visual review.", paramCount: 2 },
    { name: "figma__get_metadata", description: "Read the node tree metadata for a page or frame.", paramCount: 2 },
    { name: "figma__get_variable_defs", description: "List variables and design tokens used by a node.", paramCount: 2 },
    { name: "figma__search_design_system", description: "Search published components across team libraries.", paramCount: 3 },
    { name: "figma__get_code_connect_map", description: "Map Figma node ids to their code components.", paramCount: 2 },
    { name: "figma__get_comments", description: "List comments anchored to a file or frame.", paramCount: 2 },
  ],
  notion: [
    { name: "notion__search", description: "Search across pages, databases, and workspace content.", paramCount: 2 },
    { name: "notion__fetch", description: "Fetch a page, database, or block by id or URL.", paramCount: 1 },
    { name: "notion__create_pages", description: "Create one or more pages from structured content.", paramCount: 3 },
    { name: "notion__update_page", description: "Update a page's properties and content.", paramCount: 3 },
    { name: "notion__query_database", description: "Query a database with filters and sorts.", paramCount: 4 },
    { name: "notion__create_comment", description: "Add a comment to a page or discussion.", paramCount: 2 },
  ],
};

const ago = (min: number, sec = 0) => new Date(Date.now() - min * 60_000 - sec * 1000).toISOString();

/** Seed log, newest first. */
export const MOCK_LOG: LogEntry[] = [
  {
    id: "log-1",
    at: ago(1, 12),
    connectorId: "github",
    tool: "github__search_repositories",
    status: "ok",
    durationMs: 412,
    params: { query: "juno in:name user:liam", perPage: 5 },
    result: '{"total_count":3,"items":["liam/juno","liam/juno-docs","liam/juno-cli"]}',
  },
  {
    id: "log-2",
    at: ago(3, 40),
    connectorId: "figma",
    tool: "figma__get_design_context",
    status: "ok",
    durationMs: 1240,
    params: { fileKey: "Xq9vRb21", nodeId: "128:642" },
    result: '{"frame":"Composer / Desktop","components":12,"variables":["--radius","--primary"]}',
  },
  {
    id: "log-3",
    at: ago(6, 5),
    connectorId: "github",
    tool: "github__get_file_contents",
    status: "ok",
    durationMs: 388,
    params: { owner: "liam", repo: "juno", path: "src/lib/mcp.ts" },
    result: '{"type":"file","size":6180,"encoding":"base64"}',
  },
  {
    id: "log-4",
    at: ago(9, 30),
    connectorId: "figma",
    tool: "figma__get_screenshot",
    status: "error",
    durationMs: 5210,
    params: { fileKey: "Xq9vRb21", nodeId: "301:12" },
    result: '{"error":"node_not_found","message":"Node 301:12 does not exist in this file"}',
  },
  {
    id: "log-5",
    at: ago(14),
    connectorId: "github",
    tool: "github__get_pull_request",
    status: "ok",
    durationMs: 345,
    params: { owner: "liam", repo: "juno", number: 42 },
    result: '{"title":"Per-model thinking tiers","state":"open","reviewDecision":"APPROVED"}',
  },
  {
    id: "log-6",
    at: ago(21, 15),
    connectorId: "figma",
    tool: "figma__get_variable_defs",
    status: "ok",
    durationMs: 902,
    params: { fileKey: "Xq9vRb21", nodeId: "1:2" },
    result: '{"variables":48,"collections":["Color","Radius","Spacing"]}',
  },
  {
    id: "log-7",
    at: ago(28),
    connectorId: "github",
    tool: "github__list_issues",
    status: "ok",
    durationMs: 501,
    params: { owner: "liam", repo: "juno", state: "open", labels: "bug" },
    result: '{"count":4,"top":"Composer loses focus after slash command"}',
  },
  {
    id: "log-8",
    at: ago(37, 45),
    connectorId: "github",
    tool: "github__list_commits",
    status: "ok",
    durationMs: 298,
    params: { owner: "liam", repo: "juno", sha: "main", perPage: 10 },
    result: '{"count":10,"head":"5e038ff Optimize the MiniMax provider logo PNGs"}',
  },
  {
    id: "log-9",
    at: ago(52, 20),
    connectorId: "figma",
    tool: "figma__get_metadata",
    status: "ok",
    durationMs: 764,
    params: { fileKey: "Xq9vRb21", pageId: "0:1" },
    result: '{"page":"Juno / Desktop","frames":18,"components":31}',
  },
];

const LIVE_SAMPLES: Array<Pick<LogEntry, "connectorId" | "tool" | "status" | "params" | "result"> & { baseMs: number }> = [
  {
    connectorId: "github",
    tool: "github__search_code",
    status: "ok",
    baseMs: 430,
    params: { query: "openMcpToolset repo:liam/juno" },
    result: '{"total_count":2,"paths":["src/lib/mcp.ts","src/app/api/chat/route.ts"]}',
  },
  {
    connectorId: "figma",
    tool: "figma__search_design_system",
    status: "ok",
    baseMs: 810,
    params: { query: "status pill" },
    result: '{"matches":3,"top":"Pill / Status / Active"}',
  },
  {
    connectorId: "github",
    tool: "github__get_repository",
    status: "ok",
    baseMs: 260,
    params: { owner: "liam", repo: "juno" },
    result: '{"default_branch":"main","open_issues":7,"stars":128}',
  },
  {
    connectorId: "figma",
    tool: "figma__get_code_connect_map",
    status: "ok",
    baseMs: 640,
    params: { fileKey: "Xq9vRb21", nodeId: "128:642" },
    result: '{"mapped":9,"unmapped":3}',
  },
  {
    connectorId: "github",
    tool: "github__get_file_contents",
    status: "error",
    baseMs: 1900,
    params: { owner: "liam", repo: "juno", path: "src/lib/does-not-exist.ts" },
    result: '{"error":"not_found","message":"No file matches this path on main"}',
  },
  {
    connectorId: "figma",
    tool: "figma__get_screenshot",
    status: "ok",
    baseMs: 1450,
    params: { fileKey: "Xq9vRb21", nodeId: "128:642" },
    result: '{"format":"png","width":1440,"height":900}',
  },
  {
    connectorId: "github",
    tool: "github__list_commits",
    status: "ok",
    baseMs: 310,
    params: { owner: "liam", repo: "juno", sha: "main", perPage: 5 },
    result: '{"count":5,"head":"50b9c31 Use PNG for the MiniMax provider logo"}',
  },
  {
    connectorId: "notion",
    tool: "notion__search",
    status: "ok",
    baseMs: 690,
    params: { query: "product roadmap", limit: 5 },
    result: '{"results":5,"top":"Juno / Product Roadmap"}',
  },
];

let liveCursor = 0;

/** Next fixture entry for the live feed — cycles through realistic samples. */
export function makeLiveLogEntry(): LogEntry {
  const sample = LIVE_SAMPLES[liveCursor % LIVE_SAMPLES.length];
  liveCursor += 1;
  return {
    id: `live-${Date.now().toString(36)}-${liveCursor}`,
    at: new Date().toISOString(),
    connectorId: sample.connectorId,
    tool: sample.tool,
    status: sample.status,
    durationMs: Math.round(sample.baseMs * (0.75 + Math.random() * 0.5)),
    params: sample.params,
    result: sample.result,
  };
}
