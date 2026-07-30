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
 */
export function parseUnifiedDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    // File headers carry no line content.
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith("+")) {
      rows.push({ old: null, cur: newLine++, type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ old: oldLine++, cur: null, type: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a note about the patch, not a line in it.
      continue;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ old: oldLine++, cur: newLine++, type: "ctx", text });
    }
  }
  return rows;
}
