/**
 * Telling a connector tool that READS from one that WRITES.
 *
 * Up to five connectors are live per turn, each acting with the user's own
 * credentials, and write tools already ship: create_event / delete_event on our
 * own calendar server, add_to_playlist on music, plus whatever a linked GitHub
 * (repo scope) or Notion (page updates) exposes. Nothing downstream could
 * previously distinguish "list my events" from "delete this event" — both were
 * just a name and a JSON schema.
 *
 * Two sources of truth, in order:
 *
 *  1. The MCP server's own `annotations` (readOnlyHint / destructiveHint).
 *     Authoritative when present, with one deliberate asymmetry: a server
 *     claiming readOnlyHint:true is believed, because the alternative is
 *     treating every tool as a write and confirming everything. The spec itself
 *     calls these HINTS from an untrusted party — see the note in mcp.ts.
 *
 *  2. A verb heuristic on the tool name, for the (common) case of a server that
 *     ships no annotations at all. Verb-first naming — `create_event`,
 *     `list_events`, `search_messages` — is near-universal in MCP servers, so
 *     the first token carries almost all the signal.
 *
 * What this does NOT do: guess. A tool that matches neither source stays
 * "unknown" rather than being forced into a bucket, so callers get to decide
 * how to treat the residue instead of inheriting a coin flip from here. The
 * honest cost of that: a write tool from an unannotated server whose name has
 * no recognisable verb (`notion_pages`, `jira_transition_23`) classifies as
 * unknown, and any gate keyed on "write" will not fire for it.
 */

export type ToolAccess = "read" | "write" | "unknown";

/** Read/write metadata as declared by an MCP server (the subset we act on). */
export interface ToolAccessHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/*
 * Verb-first tool names. Only the leading token is trusted as a classifier:
 * scanning every token would misread the very common `get_post` / `list_issues`
 * shape, where a noun that happens to be a verb elsewhere sits after a read
 * verb. A trailing scan runs only when the first token says nothing, which is
 * what catches the `noun_verb` minority (`repo_create`, `page_update`).
 */
const READ_VERBS = new Set([
  "browse", "check", "count", "describe", "diff", "download", "export", "fetch", "find", "get",
  "inspect", "list", "load", "lookup", "ls", "query", "read", "resolve", "retrieve", "search",
  "show", "stat", "summarize", "summarise", "view",
]);

const WRITE_VERBS = new Set([
  "add", "append", "apply", "approve", "archive", "assign", "cancel", "clear", "close", "comment",
  "complete", "create", "decline", "delete", "deploy", "disable", "dismiss", "drop", "edit",
  "empty", "enable", "execute", "import", "insert", "invite", "label", "leave", "lock", "merge",
  "move", "mute", "patch", "pay", "pin", "post", "publish", "purchase", "push", "put",
  "reject", "remove", "rename", "reply", "reset", "restore", "revoke", "run", "schedule", "send",
  "set", "share", "star", "start", "stop", "submit", "subscribe", "sync", "transfer", "trash",
  "unarchive", "unlock", "unpin", "unstar", "unsubscribe", "update", "upload", "upsert", "write",
]);

/** Split a tool name into lowercase word tokens across snake, kebab and camel case. */
export function toolNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((part) => (part ? [part.toLowerCase()] : []));
}

/**
 * Classify a single tool.
 *
 * @param toolName the tool's own name, WITHOUT any `<connector>__` namespace
 *                 prefix — the prefix would otherwise become the first token
 *                 and the verb heuristic would read the connector id instead.
 */
export function classifyToolAccess(toolName: string, hints?: ToolAccessHints): ToolAccess {
  // destructiveHint is only meaningful alongside a write, but a server that sets
  // it while leaving readOnlyHint unset has still told us the thing writes.
  if (hints?.destructiveHint === true) return "write";
  if (hints?.readOnlyHint === true) return "read";
  if (hints?.readOnlyHint === false) return "write";

  const tokens = toolNameTokens(toolName);
  if (tokens.length === 0) return "unknown";
  if (READ_VERBS.has(tokens[0])) return "read";
  if (WRITE_VERBS.has(tokens[0])) return "write";
  if (tokens.slice(1).some((t) => WRITE_VERBS.has(t))) return "write";
  return "unknown";
}
