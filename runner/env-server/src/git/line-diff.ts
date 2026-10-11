/**
 * Line diffs and patches without git, for folders that are not repositories.
 *
 * `fileSection` writes the same git-style text `git diff` does (a/ b/
 * prefixes, `new file mode`, `\ No newline at end of file`), so every client
 * parser that reads a repository's Changes reads a plain folder's too.
 * `applyHunks` is the inverse used to revert one hunk: exact context only,
 * all or nothing, never fuzzy.
 */

export interface LineOp {
  kind: " " | "-" | "+";
  text: string;
}

/** A file's lines; the last one carries `noEol` when the file does not end in a newline. */
export interface FileLines {
  lines: string[];
  noEol: boolean;
}

export function splitLines(text: string): FileLines {
  if (text === "") return { lines: [], noEol: false };
  const noEol = !text.endsWith("\n");
  const body = noEol ? text : text.slice(0, -1);
  return { lines: body.split("\n"), noEol };
}

export function joinLines(file: FileLines): string {
  if (file.lines.length === 0) return "";
  return file.lines.join("\n") + (file.noEol ? "" : "\n");
}

/** Past this many edit steps the middle is shown as one replacement rather than searched further. */
const MAX_EDIT_STEPS = 4000;
const NO_EOL = "\u0000\\ No newline at end of file";

/** Shortest edit script from a to b (Myers), common prefix and suffix trimmed first. */
export function diffLines(a: readonly string[], b: readonly string[]): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): LineOp => ({ kind: " ", text }));
  const tail = a.slice(endA).map((text): LineOp => ({ kind: " ", text }));
  return [...head, ...myers(a.slice(start, endA), b.slice(start, endB)), ...tail];
}

function myers(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const replace = (): LineOp[] => [...a.map((text): LineOp => ({ kind: "-", text })), ...b.map((text): LineOp => ({ kind: "+", text }))];
  if (n === 0 || m === 0) return replace();
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT_STEPS); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return replace();
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[]): LineOp[] {
  const ops: LineOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const saved = trace[d];
    const at = (k: number) => saved[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", text: b[y - 1] });
      else ops.push({ kind: "-", text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface TextDiff {
  /** Hunks only (`@@` onwards); empty when the contents are equal. */
  hunks: string;
  additions: number;
  deletions: number;
}

/** Hunks with `context` lines around each change, git's header arithmetic included. */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const tag = (file: FileLines) => (file.noEol && file.lines.length ? [...file.lines.slice(0, -1), file.lines.at(-1)! + NO_EOL] : file.lines);
  const ops = diffLines(tag(splitLines(before)), tag(splitLines(after)));
  let additions = 0;
  let deletions = 0;
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind === "+") additions++;
    if (op.kind === "-") deletions++;
    if (op.kind !== " ") changed.push(i);
  });
  if (changed.length === 0) return { hunks: "", additions: 0, deletions: 0 };
  // Ranges of ops to print, merged when their context would touch.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  // Line numbers before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }
  const out: string[] = [];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const oldStart = oldCount === 0 ? oldAt[from] : oldAt[from] + 1;
    const newStart = newCount === 0 ? newAt[from] : newAt[from] + 1;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const op of slice) {
      if (op.text.endsWith(NO_EOL)) {
        out.push(op.kind + op.text.slice(0, -NO_EOL.length));
        out.push("\\ No newline at end of file");
      } else out.push(op.kind + op.text);
    }
  }
  return { hunks: out.join("\n") + "\n", additions, deletions };
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/** A whole file's git-style section: `diff --git` header, mode lines, ---/+++ and hunks. */
export function fileSection(file: string, before: string | null, after: string | null, binary = false): TextDiff & { text: string } {
  const head = [`diff --git a/${file} b/${file}`];
  if (before === null) head.push("new file mode 100644");
  if (after === null) head.push("deleted file mode 100644");
  if (binary) {
    head.push(`Binary files ${before === null ? "/dev/null" : `a/${file}`} and ${after === null ? "/dev/null" : `b/${file}`} differ`);
    return { text: head.join("\n") + "\n", hunks: "", additions: 0, deletions: 0 };
  }
  const diff = diffText(before ?? "", after ?? "");
  head.push(before === null ? "--- /dev/null" : `--- a/${file}`, after === null ? "+++ /dev/null" : `+++ b/${file}`);
  return { ...diff, text: diff.hunks ? head.join("\n") + "\n" + diff.hunks : head.join("\n") + "\n" };
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface PatchHunk {
  oldStart: number;
  /** The lines the hunk expects (context and removals) and what it leaves (context and additions). */
  expect: string[];
  replace: string[];
  /** `\ No newline` after the last expected / replacing line. */
  expectNoEol: boolean;
  replaceNoEol: boolean;
}

export interface PatchFile {
  /** Path after a/ or b/ is stripped; `/dev/null` sides are reported as null. */
  oldPath: string | null;
  newPath: string | null;
  hunks: PatchHunk[];
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunk: PatchHunk | undefined;
  let last: " " | "-" | "+" | undefined;
  const strip = (raw: string): string | null => {
    let value = raw.replace(/\t.*$/, "").trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "/dev/null") return null;
    return value.replace(/^[ab]\//, "");
  };
  // Lines the current hunk's header still promises on each side: a blank
  // line counts as context only inside them (some tools trim the space).
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("\\")) {
      if (hunk && (last === "-" || last === " ")) hunk.expectNoEol = true;
      if (hunk && (last === "+" || last === " ")) hunk.replaceNoEol = true;
      continue;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0];
      if (kind === " " || line === "") {
        const text = line.slice(1);
        hunk.expect.push(text);
        hunk.replace.push(text);
        oldLeft--;
        newLeft--;
        last = " ";
        continue;
      }
      if (kind === "-") {
        hunk.expect.push(line.slice(1));
        oldLeft--;
        last = "-";
        continue;
      }
      if (kind === "+") {
        hunk.replace.push(line.slice(1));
        newLeft--;
        last = "+";
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      file = undefined;
      hunk = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      file = { oldPath: strip(line.slice(4)), newPath: null, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("+++ ") && file) {
      file.newPath = strip(line.slice(4));
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && file) {
      hunk = { oldStart: Number(header[1]), expect: [], replace: [], expectNoEol: false, replaceNoEol: false };
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      last = undefined;
      file.hunks.push(hunk);
    }
  }
  return files;
}

export class HunkMismatch extends Error {}

/**
 * Applies hunks (or their reverse) to a file's text. Every hunk must match
 * exactly, nearest its stated line first; otherwise nothing is applied.
 */
export function applyHunks(text: string, hunks: readonly PatchHunk[], reverse = false): string {
  const file = splitLines(text);
  const lines = [...file.lines];
  let noEol = file.noEol;
  let shift = 0;
  for (const h of hunks) {
    const expect = reverse ? h.replace : h.expect;
    const replace = reverse ? h.expect : h.replace;
    const replaceNoEol = reverse ? h.expectNoEol : h.replaceNoEol;
    // A patch without `\ No newline` markers (clients drop them) keeps the file's own ending.
    const marked = h.expectNoEol || h.replaceNoEol;
    const hint = Math.max(0, h.oldStart - 1 + shift);
    const at = locate(lines, expect, hint);
    if (at < 0) throw new HunkMismatch("The change no longer applies: the file changed since.");
    const touchesEnd = at + expect.length === lines.length;
    lines.splice(at, expect.length, ...replace);
    if (touchesEnd && marked) noEol = replaceNoEol;
    shift += replace.length - expect.length;
  }
  return joinLines({ lines, noEol: lines.length ? noEol : false });
}

function locate(lines: readonly string[], block: readonly string[], hint: number): number {
  const fits = (at: number) => {
    if (at < 0 || at + block.length > lines.length) return false;
    for (let i = 0; i < block.length; i++) if (lines[at + i] !== block[i]) return false;
    return true;
  };
  if (block.length === 0) return Math.min(hint, lines.length);
  for (let delta = 0; delta <= lines.length; delta++) {
    if (fits(hint - delta)) return hint - delta;
    if (delta && fits(hint + delta)) return hint + delta;
  }
  return -1;
}
