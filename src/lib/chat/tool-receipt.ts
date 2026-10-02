/**
 * THE RECEIPT, AS WORDS AND MARKS — one vocabulary for every surface that
 * draws a tool call.
 *
 * `tool-detail.ts` owns what of a CALL may travel (args, result, notes).
 * This module owns how that call is SAID once it has landed in a transcript:
 * the one-line label, the house glyph, the status word, and the file-change
 * form (`file_change` receipts with a real diff). Chat, Juno Code, Thought
 * process, macOS and iOS all read from here so a receipt cannot word the same
 * call two ways.
 *
 * The maps mirror `NativeToolPresentation` (JunoChatKit) and
 * `JunoWorkVocabulary` (JunoWorkKit). Keep the three in step: a tool the Mac
 * calls "Editing src/app/page.tsx" and the web calls "Using a tool" is one
 * action with two names.
 *
 * NEVER AN EM-DASH in any string here. Hyphen, comma or period only.
 */

import type { ClientActivityEvent, ClientToolDetail } from "@/types/chat";

/** The house glyph a receipt wears. Mapped to `@/components/ui/icons` at the
 *  call site so this module stays free of JSX and of the icon module. */
export type ReceiptIconKind =
  | "search"
  | "web"
  | "file"
  | "filePlus"
  | "image"
  | "code"
  | "terminal"
  | "clock"
  | "calculator"
  | "task"
  | "research"
  | "agents"
  | "list"
  | "memory"
  | "monitor"
  | "crosshair"
  | "keyboard"
  | "connectors"
  | "tools"
  | "write"
  | "skill"
  | "warning"
  | "error"
  | "success";

/** Running (present continuous) and settled (past) labels, by tool id. */
const RECEIPT_RUNNING: Record<string, string> = {
  web_search: "Searching the web",
  provider_web_search: "Searching the web",
  provider_x_search: "Searching X",
  web_fetch: "Reading a page",
  read_document: "Reading a document",
  inspect_image: "Looking closer at an image",
  run_code: "Running code",
  // The pre-rework id of the same tool (SPEC §3.5); stored rows still carry it.
  code_interpreter: "Running code",
  check_run: "Checking on a run",
  use_skill: "Reading a skill",
  read_skill_file: "Reading a skill file",
  search_chats: "Searching your chats",
  current_time: "Checking the time",
  calculate: "Calculating",
  start_task: "Handing this to a task",
  suggest_research: "Suggested research",
  create_agent: "Creating an agent",
  update_agent: "Updating its profile",
  agent_profile: "Updating its profile",
  agent_goal: "Updating its goals",
  manage_agent_goal: "Updating its goals",
  agent_goals: "Updating its goals",
  agent_routine: "Updating its routines",
  manage_agent_routine: "Updating its routines",
  agent_routines: "Updating its routines",
  agent_memory: "Saving a note",
  manage_agent_note: "Saving a note",
  agent_notes: "Saving a note",
  manage_agent_computer: "Setting up its computer",
  agent_computer: "Setting up its computer",
  computer_screenshot: "Looking at its screen",
  computer_screen: "Looking at its screen",
  computer_click: "Clicking on its screen",
  computer_type: "Typing on its computer",
  computer_key: "Pressing a key",
  computer_scroll: "Scrolling its screen",
  computer_wait: "Waiting on its computer",
  computer_shell: "Running a command",
  computer_exec: "Running a command",
  computer_files: "Working with files on its computer",
  computer_read_file: "Working with files on its computer",
  computer_read_page: "Working with files on its computer",
  computer_write_file: "Writing a file on its computer",
  computer_open_url: "Opening a page on its computer",
  // Juno Code / Work vocabulary (kept in step with JunoWorkVocabulary).
  list_folder: "Looking through a folder",
  read_file: "Reading a file",
  search_files: "Searching your files",
  file_details: "Checking a file",
  apply_changes: "Making changes to your files",
  permanently_delete: "Deleting files for good",
  browser: "Using a web page",
  browser_control: "Using your browser",
  app_control: "Using an app on your Mac",
  screen_control: "Working on your screen",
  web_research: "Searching the web",
  fetch_page: "Reading a web page",
  read_page: "Reading a web page",
  write_file: "Writing a file",
  edit_file: "Editing a file",
  delete_file: "Deleting a file",
  bash: "Running a command",
  glob: "Searching files",
  grep: "Searching file contents",
};

const RECEIPT_DONE: Record<string, string> = {
  web_search: "Searched the web",
  provider_web_search: "Searched the web",
  provider_x_search: "Searched X",
  web_fetch: "Read a page",
  read_document: "Read a document",
  inspect_image: "Looked closer at an image",
  run_code: "Ran code",
  code_interpreter: "Ran code",
  check_run: "Checked on a run",
  use_skill: "Read a skill",
  read_skill_file: "Read a skill file",
  search_chats: "Searched your chats",
  current_time: "Checked the time",
  calculate: "Calculated",
  start_task: "Started a task",
  suggest_research: "Suggested research",
  create_agent: "Created an agent",
  update_agent: "Updated its profile",
  agent_profile: "Updated its profile",
  agent_goal: "Updated its goals",
  manage_agent_goal: "Updated its goals",
  agent_goals: "Updated its goals",
  agent_routine: "Updated its routines",
  manage_agent_routine: "Updated its routines",
  agent_routines: "Updated its routines",
  agent_memory: "Saved a note",
  manage_agent_note: "Saved a note",
  agent_notes: "Saved a note",
  manage_agent_computer: "Updated its computer",
  agent_computer: "Updated its computer",
  computer_screenshot: "Looked at its screen",
  computer_screen: "Looked at its screen",
  computer_click: "Clicked on its screen",
  computer_type: "Typed on its computer",
  computer_key: "Pressed a key",
  computer_scroll: "Scrolled its screen",
  computer_wait: "Waited on its computer",
  computer_shell: "Ran a command",
  computer_exec: "Ran a command",
  computer_files: "Worked with files on its computer",
  computer_read_file: "Worked with files on its computer",
  computer_read_page: "Worked with files on its computer",
  computer_write_file: "Wrote a file on its computer",
  computer_open_url: "Opened a page on its computer",
  list_folder: "Looked through a folder",
  read_file: "Read a file",
  search_files: "Searched your files",
  file_details: "Checked a file",
  apply_changes: "Changed your files",
  permanently_delete: "Deleted files for good",
  browser: "Used a web page",
  browser_control: "Used your browser",
  app_control: "Used an app on your Mac",
  screen_control: "Worked on your screen",
  web_research: "Searched the web",
  fetch_page: "Read a web page",
  read_page: "Read a web page",
  write_file: "Wrote a file",
  edit_file: "Edited a file",
  delete_file: "Deleted a file",
  bash: "Ran a command",
  glob: "Searched files",
  grep: "Searched file contents",
};

const RECEIPT_ICON: Record<string, ReceiptIconKind> = {
  web_search: "search",
  provider_web_search: "search",
  provider_x_search: "search",
  web_fetch: "web",
  read_document: "file",
  inspect_image: "image",
  run_code: "code",
  code_interpreter: "code",
  check_run: "code",
  use_skill: "skill",
  read_skill_file: "skill",
  search_chats: "tools",
  current_time: "clock",
  calculate: "calculator",
  start_task: "task",
  suggest_research: "research",
  create_agent: "agents",
  update_agent: "agents",
  agent_profile: "agents",
  agent_goal: "list",
  manage_agent_goal: "list",
  agent_goals: "list",
  agent_routine: "clock",
  manage_agent_routine: "clock",
  agent_routines: "clock",
  agent_memory: "memory",
  manage_agent_note: "memory",
  agent_notes: "memory",
  manage_agent_computer: "monitor",
  agent_computer: "monitor",
  computer_screenshot: "monitor",
  computer_screen: "monitor",
  computer_click: "crosshair",
  computer_type: "keyboard",
  computer_key: "keyboard",
  computer_scroll: "monitor",
  computer_wait: "clock",
  computer_shell: "terminal",
  computer_exec: "terminal",
  computer_files: "file",
  computer_read_file: "file",
  computer_read_page: "file",
  computer_write_file: "filePlus",
  computer_open_url: "web",
  list_folder: "file",
  read_file: "file",
  search_files: "search",
  file_details: "file",
  apply_changes: "write",
  permanently_delete: "error",
  browser: "web",
  browser_control: "web",
  app_control: "monitor",
  screen_control: "monitor",
  web_research: "search",
  fetch_page: "web",
  read_page: "web",
  write_file: "filePlus",
  edit_file: "write",
  delete_file: "error",
  bash: "terminal",
  glob: "search",
  grep: "search",
  mcp: "connectors",
};

/** Sentence-case a wire token no build knows ("foo_bar" -> "Foo bar"). */
function sentenceCased(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (!words) return "Used a tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The receipt's one-line label.
 *
 * `running` picks the present continuous; settled picks the past. An `mcp`
 * call wears its connector and tool title ("GitHub · Create issue") rather
 * than a fixed phrase, because those two ARE the label.
 */
export function receiptLabel(
  tool: string | undefined,
  opts: {
    running?: boolean;
    connectorLabel?: string | null;
    toolTitle?: string | null;
    /** A query, path or domain the phrase should carry when the map is generic. */
    object?: string | null;
  } = {},
): string {
  if (tool === "mcp" || tool === undefined) {
    const connector = opts.connectorLabel?.trim();
    const title = opts.toolTitle?.trim();
    if (connector && title) return `${connector} · ${title}`;
    if (connector) return connector;
    if (title) return title;
  }
  if (!tool) return opts.running ? "Using a tool" : "Used a tool";
  const map = opts.running ? RECEIPT_RUNNING : RECEIPT_DONE;
  const phrase = map[tool] ?? sentenceCased(tool);
  const object = opts.object?.trim();
  if (object && opts.running) return `${phrase}: ${object}`;
  return phrase;
}

/** The house glyph kind for a tool id. Unknown tools wear `tools`. */
export function receiptIconKind(tool: string | undefined): ReceiptIconKind {
  if (!tool) return "tools";
  return RECEIPT_ICON[tool] ?? "tools";
}

/**
 * The label for one chat tool call, from the connector label the producer
 * sent (`server`: "Linear", "Web search") and the function the model called
 * (`name`: "linear__create_issue", "web_search").
 *
 * A tool this vocabulary knows says what it did ("Searched the web"). Any
 * other call wears its connector and a readable tool title ("Linear · Create
 * issue"), never the raw namespaced function name.
 */
export function receiptLabelForCall(
  server: string | undefined,
  name: string | undefined,
  running = false,
): string {
  const map = running ? RECEIPT_RUNNING : RECEIPT_DONE;
  if (name && map[name]) return map[name];
  const connector = server?.trim() || null;
  let title = name?.trim() ?? "";
  const split = title.indexOf("__");
  if (split !== -1) title = title.slice(split + 2);
  if (!connector && !title) return running ? "Using a tool" : "Used a tool";
  return receiptLabel("mcp", {
    running,
    connectorLabel: connector,
    toolTitle: title ? sentenceCased(title) : null,
  });
}

/** The same, for a chat tool detail row. */
export function receiptLabelForDetail(tool: ClientToolDetail, running = false): string {
  return receiptLabelForCall(tool.server, tool.name, running);
}

/** The glyph for a chat tool call: the vocabulary's own, else a connector. */
export function receiptIconKindForCall(name: string | undefined): ReceiptIconKind {
  if (name && RECEIPT_ICON[name]) return RECEIPT_ICON[name];
  return "connectors";
}

/**
 * `stopped` and `unknown` are the two ends a real run can have that are
 * neither a success nor a failure (tool-run.ts): the person pressed Stop, or
 * nobody saw the end. Each wears its own still mark and says nothing on the
 * right; the label already carries the words.
 */
export type ReceiptStatus = "running" | "ok" | "failed" | "denied" | "waiting" | "stopped" | "unknown";

/**
 * The right-aligned status word. Short, text-label size, never a pill.
 * A success says nothing: absence is the ordinary case (the duration carries
 * the fact that it finished). Failures and denials speak.
 */
export function receiptStatusText(status: ReceiptStatus): string | null {
  switch (status) {
    case "failed":
      return "Failed";
    case "denied":
      return "Declined";
    case "waiting":
      return "Waiting";
    default:
      return null;
  }
}

/**
 * A Code `write` / `file_change` row, parsed into its receipt form.
 *
 * The producer composes `${changeKind} ${path}` and a path cannot contain the
 * first space, which is why the path is recovered with a split. `detail` is
 * the churn string (`+3 −1`) when one was measured.
 */
export interface FileChangeReceipt {
  path: string;
  changeKind: string;
  /** `+3 −1`, or null when the producer measured nothing. */
  churn: string | null;
  /** Unified diff for this file, when one was transported. Null means "no
   *  patch arrived", never "the change was empty". */
  patch: string | null;
}

export function fileChangeFromEvent(event: ClientActivityEvent): FileChangeReceipt {
  const space = event.title.indexOf(" ");
  const changeKind = space === -1 ? "edit" : event.title.slice(0, space);
  const path = space === -1 ? event.title : event.title.slice(space + 1);
  const patchValue = (event as { patch?: unknown }).patch;
  return {
    path,
    changeKind,
    churn: event.detail?.trim() || null,
    patch: typeof patchValue === "string" && patchValue.trim() !== "" ? patchValue : null,
  };
}

/** `+3 −1` per file, summed. U+2212 MINUS SIGN is what the producer writes. */
export function parseChurn(churn: string | null | undefined): { added: number; removed: number } | null {
  if (!churn) return null;
  const match = churn.match(/\+(\d+)\s+[−-](\d+)/);
  if (!match) return null;
  return { added: Number(match[1]), removed: Number(match[2]) };
}

/** `+3 −1` for one file, or null when nothing was measured. */
export function churnLabel(churn: string | null | undefined): string | null {
  const parsed = parseChurn(churn);
  if (!parsed) return null;
  return `+${parsed.added} −${parsed.removed}`;
}

/**
 * Every path this turn wrote, from `write` activity rows.
 *
 * Used by the transcript to keep a full file out of the body when a write
 * receipt already carries it: when a write occurred, the chat body must not
 * also contain the full file as a fenced block.
 */
export function writtenPaths(events: readonly ClientActivityEvent[] | undefined): Set<string> {
  const paths = new Set<string>();
  for (const event of events ?? []) {
    if (event.kind !== "write") continue;
    paths.add(fileChangeFromEvent(event).path);
  }
  return paths;
}

/**
 * Whether a fenced block is the same file a write receipt already carries.
 *
 * Matches on full path or on the leaf name, because a fence that says
 * `page.tsx` and a write that says `src/app/page.tsx` are the same file to a
 * reader. A block with no declared filename is never suppressed: we do not
 * know what it is, and dropping it would lose real content.
 */
export function fenceMatchesWrittenFile(
  filename: string | undefined,
  written: ReadonlySet<string>,
): boolean {
  if (!filename || written.size === 0) return false;
  const normalized = filename.replace(/^\.\//, "");
  if (written.has(normalized)) return true;
  const leaf = normalized.split("/").pop() ?? normalized;
  for (const path of written) {
    if (path === leaf || (path.split("/").pop() ?? path) === leaf) return true;
  }
  return false;
}

/**
 * A failure's reason line. One sentence, no em-dash. Null when the call
 * simply finished, so the receipt stays one row.
 */
export function receiptFailureReason(tool: ClientToolDetail | undefined): string | null {
  if (!tool || tool.status !== "failed") return null;
  if (tool.resultNote === "unfinished") return "The run ended before this call returned.";
  if (tool.resultNote === "empty") return "The call returned nothing.";
  if (tool.result?.trim()) {
    const first = tool.result.trim().split("\n").find((line) => line.trim());
    return first ? first.slice(0, 160) : "Failed.";
  }
  return "Failed.";
}

/** Whether a failed call is safe to ask to run again (never a write). */
export function receiptCanRetry(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes("write") || lower.includes("delete") || lower.includes("create")) return false;
  if (lower.includes("apply_changes") || lower.includes("permanently_delete")) return false;
  return true;
}
