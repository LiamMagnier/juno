"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AIcss "File Diff" — a unified diff in the code-block shell.
 *
 * Two number columns and a sign column, so a row states both where it was and
 * where it is now. The left accent bar carries the sign a second time — solid
 * for an addition, a 45° hatch for a deletion — which is what keeps the diff
 * readable by someone who cannot separate the greens from the reds. Colour alone
 * would make the two tint bands the only difference between adding and deleting
 * a line.
 */

export type DiffRowType = "ctx" | "add" | "del";

export interface DiffRow {
  /** Line number in the old file, or null for an addition. */
  old: number | null;
  /** Line number in the new file, or null for a deletion. */
  cur: number | null;
  type: DiffRowType;
  text: string;
}

const DiffIcon = () => (
  <svg className="aicss-cb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path
      d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function FileDiff({ file, rows, className }: { file: string; rows: DiffRow[]; className?: string }) {
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;

  return (
    <div className={cn("aicss-cb aicss-diff", className)}>
      <div className="aicss-cb-head">
        <span className="aicss-cb-file">
          <DiffIcon />
          <span className="aicss-cb-lang">{file}</span>
        </span>
        <span className="aicss-diff-stat">
          <span className="aicss-diff-add">+{added}</span>
          <span className="aicss-diff-del">-{removed}</span>
        </span>
      </div>
      <div className="aicss-diff-body">
        {rows.map((row, i) => (
          <div key={i} className="aicss-diff-row" data-type={row.type}>
            <span className="aicss-diff-ln aicss-diff-ln-old">{row.old ?? ""}</span>
            <span className="aicss-diff-ln aicss-diff-ln-new">{row.cur ?? ""}</span>
            <span className="aicss-diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : ""}</span>
            <code>{row.text === "" ? " " : row.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Parse a unified diff hunk body into rows.
 *
 * Deliberately narrow: it reads `@@ -a,b +c,d @@` headers for the line numbers
 * and then walks the body. A malformed patch yields the lines it could read
 * rather than throwing, because this renders inside a transcript where a wrong
 * exception costs the whole message and a short diff costs a scroll.
 *
 * HEADERS ARE ONLY HEADERS OUTSIDE A HUNK, and that distinction is not
 * pedantry — it decides whether the diff you are shown is the diff that was
 * made. Header detection used to run on every line, so DELETING a line whose
 * own text begins with `-- ` produced the raw line `--- …`, which matched the
 * `--- ` file-header pattern and was silently dropped: a real removal vanished
 * from a diff that still looked complete. Same for a removed line reading
 * `index …` or an added one reading `++ …`. Inside a hunk, `-`/`+`/space are
 * content and nothing else; a `diff ` line is what ends a hunk and starts the
 * next file's preamble, which is what keeps multi-file patches working.
 *
 * A LINE NUMBER IS ONLY PRINTED WHERE A `@@` SAID WHAT IT WAS. Lines outside
 * any hunk — a `Binary files … differ` note, or a headerless body handed
 * straight to this function — render with empty number cells, because their
 * position in the file is genuinely unknown and a confident `0` would be a
 * figure this parser invented. A patch with no `@@` anywhere is treated as one
 * long hunk body rather than as preamble, which is what keeps a bare fragment
 * rendering as the additions and deletions it plainly is.
 */
export function parseUnifiedDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let numbered = false;
  let inHunk = !/^@@ -\d/m.test(patch);

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      numbered = true;
      continue;
    }
    if (line.startsWith("diff ")) {
      inHunk = false;
      numbered = false;
      continue;
    }
    // File headers carry no line content — but only where a header can be.
    if (!inHunk && /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (inHunk && line.startsWith("+")) {
      rows.push({ old: null, cur: numbered ? newLine++ : null, type: "add", text: line.slice(1) });
    } else if (inHunk && line.startsWith("-")) {
      rows.push({ old: numbered ? oldLine++ : null, cur: null, type: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a note about the patch, not a line in it.
      continue;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        old: inHunk && numbered ? oldLine++ : null,
        cur: inHunk && numbered ? newLine++ : null,
        type: "ctx",
        text,
      });
    }
  }
  return rows;
}
