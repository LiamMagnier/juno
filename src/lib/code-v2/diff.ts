/**
 * Unified diffs for the Changes dock (DESIGN §5.16; INTERACTION I-11): parse
 * into files and hunks, number the lines, pair removed/added lines for
 * word-level highlights, and fold per-hunk Accept / Reject decisions into
 * counts and into the patch the reader actually kept.
 *
 * Pure. Accepting is the default state of a change the agent already wrote;
 * Reject asks the host to revert that hunk (the env server applies the
 * reverse patch; see `rejectedPatch`).
 */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Word-level highlight ranges [start, end) within `text`, for paired lines. */
  marks?: [number, number][];
}

export interface DiffHunk {
  /** Stable id: `${path}:${oldStart}:${newStart}`. */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second @@ (function context). */
  section?: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

export interface DiffFile {
  path: string;
  previousPath?: string;
  change: "add" | "modify" | "delete" | "rename";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary?: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff (git or plain). A diff without file headers is
 * attributed to `fallbackPath`.
 */
export function parseUnifiedDiff(diff: string, fallbackPath = "file"): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const ensureFile = (path: string): DiffFile => {
    if (!file) {
      file = { path, change: "modify", hunks: [], additions: 0, deletions: 0 };
      files.push(file);
    }
    return file;
  };

  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { path: m ? m[2] : fallbackPath, change: "modify", hunks: [], additions: 0, deletions: 0 };
      if (m && m[1] !== m[2]) {
        file.previousPath = m[1];
        file.change = "rename";
      }
      files.push(file);
      hunk = null;
      continue;
    }
    if (line.startsWith("new file mode")) {
      ensureFile(fallbackPath).change = "add";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      ensureFile(fallbackPath).change = "delete";
      continue;
    }
    if (line.startsWith("Binary files")) {
      ensureFile(fallbackPath).binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      const next = lines[i + 1] ?? "";
      if (next.startsWith("+++ ")) {
        const q = next.slice(4).trim();
        const target = q === "/dev/null" ? stripPrefix(p) : stripPrefix(q);
        if (!file || file.hunks.length > 0) {
          file = { path: target, change: "modify", hunks: [], additions: 0, deletions: 0 };
          files.push(file);
        } else {
          file.path = target;
        }
        if (p === "/dev/null") file.change = "add";
        if (q === "/dev/null") file.change = "delete";
        hunk = null;
        i++;
        continue;
      }
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      const f = ensureFile(fallbackPath);
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = {
        id: `${f.path}:${h[1]}:${h[3]}`,
        header: `@@ -${h[1]}${h[2] !== undefined ? `,${h[2]}` : ""} +${h[3]}${h[4] !== undefined ? `,${h[4]}` : ""} @@`,
        oldStart: oldNo,
        oldLines: h[2] !== undefined ? Number(h[2]) : 1,
        newStart: newNo,
        newLines: h[4] !== undefined ? Number(h[4]) : 1,
        section: h[5]?.trim() || undefined,
        lines: [],
        additions: 0,
        deletions: 0,
      };
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk || !file) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const f: DiffFile = file;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      hunk.additions++;
      f.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      hunk.deletions++;
      f.deletions++;
    } else if (line.startsWith(" ") || (line === "" && i < lines.length - 1)) {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  for (const f of files) for (const h of f.hunks) markWords(h);
  return files;
}

/**
 * Word-level marks: pair each run of removed lines with the run of added lines
 * that follows it, line by line, and mark the differing middle (common prefix
 * and suffix stay unmarked). Lines that differ entirely get no marks (the line
 * fill already says it).
 */
function markWords(hunk: DiffHunk): void {
  const ls = hunk.lines;
  for (let i = 0; i < ls.length; ) {
    if (ls[i].kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < ls.length && ls[d].kind === "del") d++;
    let a = d;
    while (a < ls.length && ls[a].kind === "add") a++;
    const dels = ls.slice(i, d);
    const adds = ls.slice(d, a);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const range = changedRange(dels[k].text, adds[k].text);
      if (range) {
        dels[k].marks = [range.old];
        adds[k].marks = [range.new];
      }
    }
    i = a;
  }
}

export function changedRange(a: string, b: string): { old: [number, number]; new: [number, number] } | null {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Snap to word boundaries so a highlight never splits an identifier.
  while (p > 0 && /\w/.test(a[p - 1] ?? "") && /\w/.test(b[p - 1] ?? "")) p--;
  const oldEnd = a.length - s;
  const newEnd = b.length - s;
  const common = p + s;
  // A change that rewrites almost the whole line reads better as a plain line.
  if (common < Math.min(a.length, b.length) * 0.25) return null;
  return { old: [p, Math.max(p, oldEnd)], new: [p, Math.max(p, newEnd)] };
}

export type HunkDecision = "accepted" | "rejected";
export type Decisions = Record<string, HunkDecision>;

export interface DiffCounts {
  additions: number;
  deletions: number;
  files: number;
  pending: number;
}

/** Counts of what is kept: rejected hunks drop out. */
export function keptCounts(files: readonly DiffFile[], decisions: Decisions = {}): DiffCounts {
  let additions = 0;
  let deletions = 0;
  let pending = 0;
  let touched = 0;
  for (const f of files) {
    let fileKept = false;
    for (const h of f.hunks) {
      const d = decisions[h.id];
      if (d === "rejected") continue;
      if (!d) pending++;
      additions += h.additions;
      deletions += h.deletions;
      fileKept = true;
    }
    if (fileKept || f.hunks.length === 0) touched++;
  }
  return { additions, deletions, files: touched, pending };
}

/** Every hunk id in reading order (for ] / [ focus moves). */
export function hunkOrder(files: readonly DiffFile[]): string[] {
  return files.flatMap((f) => f.hunks.map((h) => h.id));
}

export function moveHunkFocus(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  if (current === null) return delta === 1 ? order[0] : order[order.length - 1];
  const i = order.indexOf(current);
  if (i < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, i + delta))];
}

/**
 * The reverse patch for the rejected hunks of one file: what the host applies
 * (with `git apply`) to undo exactly those hunks. Empty string when nothing
 * in the file is rejected.
 */
export function rejectedPatch(file: DiffFile, decisions: Decisions): string {
  const rejected = file.hunks.filter((h) => decisions[h.id] === "rejected");
  if (rejected.length === 0) return "";
  const out: string[] = [`--- a/${file.path}`, `+++ b/${file.path}`];
  for (const h of rejected) {
    // Reverse: swap sides, swap +/-.
    out.push(`@@ -${h.newStart},${h.newLines} +${h.oldStart},${h.oldLines} @@${h.section ? ` ${h.section}` : ""}`);
    for (const l of h.lines) {
      if (l.kind === "context") out.push(` ${l.text}`);
      else if (l.kind === "add") out.push(`-${l.text}`);
      else out.push(`+${l.text}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Split view rows: pair dels with adds side by side; context on both. */
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const ls = hunk.lines;
  for (let i = 0; i < ls.length; ) {
    if (ls[i].kind === "context") {
      rows.push({ left: ls[i], right: ls[i] });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < ls.length && ls[i].kind === "del") dels.push(ls[i++]);
    while (i < ls.length && ls[i].kind === "add") adds.push(ls[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

/** "src/server/cart/total.ts" → { name: "total.ts", dir: "src/server/cart/" } */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}
