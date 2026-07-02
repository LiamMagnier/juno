// Pure line-level diff — no dependencies. LCS-based, with a size cap so huge
// artifacts fall back to a prefix/suffix trim instead of an O(n*m) table.

export type DiffLine = {
  type: "same" | "added" | "removed";
  text: string;
  aLine?: number;
  bLine?: number;
};

const MAX_LCS_LINES = 1500;

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

function lcsDiff(aMid: string[], bMid: string[], aOffset: number, bOffset: number, out: DiffLine[]) {
  const n = aMid.length;
  const m = bMid.length;
  const width = m + 1;
  // dp[i][j] = LCS length of aMid[i..] vs bMid[j..] (suffix table so we can walk forward).
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aMid[i] === bMid[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aMid[i] === bMid[j]) {
      out.push({ type: "same", text: aMid[i], aLine: aOffset + i + 1, bLine: bOffset + j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: "removed", text: aMid[i], aLine: aOffset + i + 1 });
      i++;
    } else {
      out.push({ type: "added", text: bMid[j], bLine: bOffset + j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ type: "removed", text: aMid[i], aLine: aOffset + i + 1 });
  for (; j < m; j++) out.push({ type: "added", text: bMid[j], bLine: bOffset + j + 1 });
}

export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = splitLines(a);
  const bLines = splitLines(b);

  // Trim common prefix/suffix first — cheap, and shrinks the LCS window.
  const maxShared = Math.min(aLines.length, bLines.length);
  let prefix = 0;
  while (prefix < maxShared && aLines[prefix] === bLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxShared - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ type: "same", text: aLines[i], aLine: i + 1, bLine: i + 1 });
  }

  const aMid = aLines.slice(prefix, aLines.length - suffix);
  const bMid = bLines.slice(prefix, bLines.length - suffix);

  if (aMid.length > MAX_LCS_LINES || bMid.length > MAX_LCS_LINES) {
    // Too large for the LCS table: emit the whole middle as removed + added blocks.
    aMid.forEach((text, i) => out.push({ type: "removed", text, aLine: prefix + i + 1 }));
    bMid.forEach((text, i) => out.push({ type: "added", text, bLine: prefix + i + 1 }));
  } else {
    lcsDiff(aMid, bMid, prefix, prefix, out);
  }

  for (let k = 0; k < suffix; k++) {
    const aIdx = aLines.length - suffix + k;
    const bIdx = bLines.length - suffix + k;
    out.push({ type: "same", text: aLines[aIdx], aLine: aIdx + 1, bLine: bIdx + 1 });
  }
  return out;
}

function fmtRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function lastLineBefore(diff: DiffLine[], from: number, side: "aLine" | "bLine"): number {
  for (let idx = from - 1; idx >= 0; idx--) {
    const line = diff[idx][side];
    if (line !== undefined) return line;
  }
  return 0;
}

export function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string): string {
  const CONTEXT = 3;
  const diff = diffLines(a, b);
  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];

  const changed: number[] = [];
  diff.forEach((l, idx) => {
    if (l.type !== "same") changed.push(idx);
  });
  if (changed.length === 0) return lines.join("\n");

  // Group changes into hunks whose context windows touch or overlap.
  const hunks: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - end <= CONTEXT * 2) {
      end = changed[k];
    } else {
      hunks.push([start, end]);
      start = changed[k];
      end = changed[k];
    }
  }
  hunks.push([start, end]);

  for (const [s, e] of hunks) {
    const from = Math.max(0, s - CONTEXT);
    const to = Math.min(diff.length - 1, e + CONTEXT);
    let aStart = 0;
    let bStart = 0;
    let aCount = 0;
    let bCount = 0;
    for (let idx = from; idx <= to; idx++) {
      const l = diff[idx];
      if (l.aLine !== undefined) {
        if (aCount === 0) aStart = l.aLine;
        aCount++;
      }
      if (l.bLine !== undefined) {
        if (bCount === 0) bStart = l.bLine;
        bCount++;
      }
    }
    // Empty sides anchor to the line preceding the hunk (unified diff convention).
    if (aCount === 0) aStart = lastLineBefore(diff, from, "aLine");
    if (bCount === 0) bStart = lastLineBefore(diff, from, "bLine");
    lines.push(`@@ -${fmtRange(aStart, aCount)} +${fmtRange(bStart, bCount)} @@`);
    for (let idx = from; idx <= to; idx++) {
      const l = diff[idx];
      lines.push((l.type === "added" ? "+" : l.type === "removed" ? "-" : " ") + l.text);
    }
  }
  return lines.join("\n");
}
