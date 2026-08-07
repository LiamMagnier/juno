import { str, type Payload } from "@/components/work/work-payload";

/*
 * A burst of tool calls, as one line.
 *
 * The feed renders one row per tool call, and that is right for a run that
 * made six of them. It is wrong for a run that made sixty: the four sentences
 * Juno actually wrote end up separated by two screens of "Read a file", and
 * the narrative — the only part a person reads — is buried under the machinery
 * that produced it. So a consecutive run of calls collapses to a single line
 * that says what the run of calls WAS, and opens to the rows exactly as they
 * render today. Nothing is removed; it is folded.
 *
 * The counts come from the events, never from a second projection: each call
 * is classified once, from the `tool_started`/`tool_finished` payload it was
 * built from, and the classes are then tallied. `work-payload.ts` has already
 * reconciled the two executors' shapes by the time anything here runs.
 *
 * This module is deliberately free of React, of lucide and of the vocabulary
 * component — it takes plain records and returns a string, so the one piece of
 * logic in this feature that can be wrong in a way nobody notices (a count) is
 * a pure function of its input.
 */

// ---------------------------------------------------------------------------
// What a call was
// ---------------------------------------------------------------------------

/**
 * The handful of things a long run does over and over.
 *
 * Small on purpose. A class exists only where the plural reads as a fact a
 * person would want counted — "read 48 files" — and every call that does not
 * fit one is named individually instead of being swept into a vague total.
 * That is why there is no class for deleting, for driving the browser, or for
 * a connector: a run that permanently deleted four things must say so in those
 * words, not contribute four to "changed 6 files".
 */
export type ActivityClass =
  | "write"
  | "command"
  | "document"
  | "read"
  | "search"
  | "web"
  | "websearch";

/**
 * The order the classes are read out in — fixed, and never sorted by count.
 *
 * Frequency order would put the biggest number first, which is tempting and
 * wrong: the group at the end of a live run is still filling up, and a line
 * whose clauses swap places every second as one count overtakes another is
 * harder to read than any static order. So the order is a judgement about what
 * matters instead — what was changed leads, because that is the one a reader
 * would have to undo; what was merely looked at follows.
 */
const CLASS_ORDER: readonly ActivityClass[] = [
  "write",
  "command",
  "document",
  "read",
  "search",
  "web",
  "websearch",
];

function classPhrase(kind: ActivityClass, n: number): string {
  switch (kind) {
    case "write":
      return n === 1 ? "changed 1 file" : `changed ${n} files`;
    case "command":
      return n === 1 ? "ran 1 command" : `ran ${n} commands`;
    case "document":
      return n === 1 ? "wrote 1 document" : `wrote ${n} documents`;
    case "read":
      return n === 1 ? "read 1 file" : `read ${n} files`;
    case "search":
      return n === 1 ? "ran 1 search" : `ran ${n} searches`;
    case "web":
      return n === 1 ? "read 1 web page" : `read ${n} web pages`;
    case "websearch":
      return n === 1 ? "searched the web once" : `searched the web ${n} times`;
  }
}

/**
 * The cloud runner's declared intents. The most reliable signal there is —
 * `intentFor` is a property of the tool definition rather than a guess about
 * its arguments, and the strings are the ones in `runner/agent-core`'s
 * `workspaceTools`, `webTools`, `cloudFilesTool` and `deliverable` tools.
 *
 * `connector.*` is absent deliberately. A connector's intent is
 * `connector.<id>.<toolName>`, which is unbounded and describes somebody
 * else's product, not a thing Juno did a lot of; those calls are named one by
 * one below instead.
 */
const BY_INTENT: Record<string, ActivityClass> = {
  "shell.run": "command",
  "workspace.read": "read",
  "workspace.find": "search",
  "workspace.search": "search",
  "workspace.write": "write",
  "web.search": "websearch",
  "web.fetch": "web",
  "deliverable.create": "document",
  "cloud_file.list": "search",
  "cloud_file.read": "read",
  "cloud_file.write": "write",
};

/**
 * The action identifier, for a call whose intent did not survive.
 *
 * This is the one that carries an orphaned `tool_finished` — the normal case
 * at the top of a resumed transcript, where the cursor replays from the middle
 * of a call and only the provenance came with it.
 */
const BY_ACTION: Record<string, ActivityClass> = {
  "work.shell.run": "command",
  "work.file.read": "read",
  "work.file.list": "search",
  "work.file.write": "write",
  "work.cloud_file.list": "search",
  "work.cloud_file.read": "read",
  "work.cloud_file.write": "write",
};

/**
 * The Mac's tool names. It emits neither an intent nor a tier, so on a local
 * run this table is the whole classifier.
 *
 * `permanently_delete` is missing on purpose, and so are the three control
 * tools. Folding an irreversible delete into "changed N files" would hide the
 * single act in this vocabulary that cannot be taken back, and folding
 * `browser_control` into anything loses the fact that Juno was driving
 * something the user can see. Both are named in full instead.
 */
const BY_TOOL: Record<string, ActivityClass> = {
  read_file: "read",
  file_details: "read",
  search_files: "search",
  list_folder: "search",
  apply_changes: "write",
  web_search: "websearch",
  web_research: "websearch",
  fetch_page: "web",
  read_page: "web",
};

/**
 * What one tool call was, or null when nothing this build knows says.
 *
 * Null is a real answer and not a failure: it means the call gets its own
 * named clause in the summary rather than joining a tally, which is the
 * conservative outcome. A tool Juno gains next release is described by name on
 * a bundle shipped today instead of being miscounted or disappearing.
 */
export function classifyCall(payload: Payload): ActivityClass | null {
  const intent = str(payload, "intent");
  if (intent !== null) {
    const byIntent = BY_INTENT[intent];
    if (byIntent !== undefined) return byIntent;
    // A declared intent this build does not recognise — a connector's, or a
    // tool added since this bundle shipped — is still a statement about what
    // the call was for, so it stops here rather than falling through to the
    // tool-name table and being classified by a name the intent has already
    // contradicted.
    return null;
  }
  const action = str(payload, "action");
  if (action !== null) {
    const byAction = BY_ACTION[action];
    if (byAction !== undefined) return byAction;
  }
  const tool = str(payload, "tool", "name");
  if (tool !== null) {
    const byTool = BY_TOOL[tool];
    if (byTool !== undefined) return byTool;
  }
  // Last resort, and only for the one tier whose meaning is unambiguous. A
  // `structured_file` call could be a read or a write and guessing between
  // them would put a number in front of the user that is wrong about whether
  // anything changed.
  return str(payload, "tier") === "shell" ? "command" : null;
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

/**
 * The ways a call in a batch can have gone wrong.
 *
 * Three rather than one, because a reader needs different things of each: a
 * failure is Juno's problem, a refusal is a permission the run did not have,
 * and `unreported` means the run stopped mid-call and nobody knows which of
 * the two it was.
 */
export type BatchTrouble = "failed" | "refused" | "unreported";

export interface BatchItem {
  /** What the call was, from `classifyCall`. Null gets named individually. */
  batch: ActivityClass | null;
  /** What to call an unclassified call, already in the reader's words. */
  label: string | null;
  trouble: BatchTrouble | null;
  /** True when the injection scan flagged this call's output. */
  flagged: boolean;
  durationMs: number | null;
}

export interface BatchSummary {
  /** The whole thing as one sentence-cased line. */
  line: string;
  /**
   * True when something in here needs reading rather than counting.
   *
   * The caller opens a troubled batch by default. A collapsed error is worse
   * than a long list: the list is only tedious, whereas a failure folded into
   * a tally of successes is a run that looks like it worked.
   */
  troubled: boolean;
  /** Time spent inside these calls, or null when none of them said. */
  durationMs: number | null;
}

/**
 * How many named clauses the line may carry before the rest becomes a count.
 *
 * Four is about as much as reads in one glance. The clauses that get dropped
 * are the individually-named ones, which are the least frequent by
 * construction, and the calls they stood for are still counted in the tail —
 * so the numbers in the line always add up to the size of the batch.
 */
const MAX_CLAUSES = 4;

export function summariseBatch(items: readonly BatchItem[]): BatchSummary {
  const byClass = new Map<ActivityClass, number>();
  const byLabel = new Map<string, number>();
  const troubles = new Map<BatchTrouble, number>();
  let flagged = 0;
  let durationMs: number | null = null;

  for (const item of items) {
    if (item.batch !== null) {
      byClass.set(item.batch, (byClass.get(item.batch) ?? 0) + 1);
    } else {
      const label = item.label ?? "Other steps";
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    if (item.trouble !== null) {
      troubles.set(item.trouble, (troubles.get(item.trouble) ?? 0) + 1);
    }
    if (item.flagged) flagged += 1;
    if (item.durationMs !== null) durationMs = (durationMs ?? 0) + item.durationMs;
  }

  const clauses: { text: string; calls: number }[] = [];
  for (const kind of CLASS_ORDER) {
    const n = byClass.get(kind);
    if (n !== undefined) clauses.push({ text: classPhrase(kind, n), calls: n });
  }
  /*
   * The named ones come last and are ranked by weight, unlike the classes.
   *
   * They have to be: there are only so many clauses in the line and the rest
   * become a number, so a tool called twice must not lose its place to one
   * called once merely because of its initial. The classes above are exempt
   * because they never compete — there are seven of them and four slots is
   * rarely reached before the named ones start arriving.
   *
   * Ties break alphabetically rather than by insertion, so a batch that gains
   * a call does not reshuffle two clauses that were already level.
   */
  const labels = [...byLabel.entries()].sort(
    ([leftLabel, left], [rightLabel, right]) =>
      right - left || leftLabel.localeCompare(rightLabel)
  );
  for (const [label, n] of labels) {
    clauses.push({ text: n === 1 ? label : `${label} ×${n}`, calls: n });
  }

  const shown = clauses.slice(0, MAX_CLAUSES);
  const folded = clauses.slice(MAX_CLAUSES).reduce((total, clause) => total + clause.calls, 0);
  const parts = shown.map((clause) => clause.text);
  if (folded > 0) parts.push(`${folded} more`);

  // Always last, and never folded away. Everything above this is a tally; this
  // is the part that says the tally is not the whole story.
  const failed = troubles.get("failed") ?? 0;
  const refused = troubles.get("refused") ?? 0;
  const unreported = troubles.get("unreported") ?? 0;
  if (failed > 0) parts.push(`${failed} failed`);
  if (refused > 0) parts.push(`${refused} refused`);
  if (unreported > 0) parts.push(`${unreported} never reported back`);
  if (flagged > 0) parts.push(flagged === 1 ? "1 flagged result" : `${flagged} flagged results`);

  const line = parts.join(" · ");
  return {
    line: line.length === 0 ? `${items.length} steps` : line[0].toUpperCase() + line.slice(1),
    troubled: failed > 0 || refused > 0 || unreported > 0 || flagged > 0,
    durationMs,
  };
}
