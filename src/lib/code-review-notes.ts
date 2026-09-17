/*
 * THE REVIEW A PERSON WRITES, AND THE SENTENCE THE AGENT RECEIVES.
 *
 * The review pane cannot apply, stage, revert or land anything — the browser
 * has no checkout, which is why its verbs are "Looks right" and "Needs a
 * change" rather than Accept and Reject. What it CAN do is turn a reading of
 * the diff into an instruction, and this module is that turn: notes and
 * verdicts in, one block of text out.
 *
 * It lives outside the component for two reasons. The bundle is what the agent
 * actually acts on, so it is the part worth pinning by test, and a "use client"
 * `.tsx` cannot be imported by one. And the same bundle now has two
 * destinations — the session composer's review tray, and the older hand-off
 * that pre-fills a session from the run list — so a second copy of the format
 * would be two reviews that read differently for no reason.
 */

/**
 * The three severities a note can carry.
 *
 * Named for the reader's intent rather than for a colour, and kept to three
 * because a severity list long enough to need thought is one nobody uses. The
 * middle tier exists so a genuine nit can be sent WITHOUT the agent treating it
 * as a defect, and `pre-existing` exists so a reader can point at something
 * wrong that this run did not cause — which is the note people most often
 * swallow, because every other review surface makes it look like a complaint
 * about the work in front of them.
 */
export const SEVERITIES = [
  { id: "important", label: "Important", hint: "Should change before this lands." },
  { id: "nit", label: "Nit", hint: "Worth fixing, not worth blocking." },
  { id: "pre-existing", label: "Pre-existing", hint: "Already wrong before this run touched it." },
] as const;

export type Severity = (typeof SEVERITIES)[number]["id"];

export interface ReviewNote {
  id: string;
  path: string;
  /** The new-file line number the note is anchored to, when one was picked. */
  line: number | null;
  severity: Severity;
  body: string;
}

/** Per-file verdict. Absent means the reader has not said. */
export type Verdict = "ok" | "change";

export interface ReviewDraft {
  notes: ReviewNote[];
  verdicts: Record<string, Verdict>;
}

export const EMPTY_REVIEW_DRAFT: ReviewDraft = { notes: [], verdicts: {} };

/** How many notes and verdicts are waiting — the number on the button. */
export function reviewDraftSize(draft: ReviewDraft): number {
  return draft.notes.length + Object.keys(draft.verdicts).length;
}

/**
 * The review, as the instruction the agent reads.
 *
 * Grouped by severity rather than by file, because the first thing an agent
 * has to decide is what must change, and a file-ordered list buries one
 * "Important" under nine nits. Verdicts come last and as plain lists: they are
 * context for the notes, not instructions of their own, and a file marked
 * "looks right" is worth stating precisely so the agent does not go back over
 * it.
 *
 * Returns the empty string when there is nothing to say, so a caller can test
 * one value rather than reason about which of two inputs was empty.
 */
export function buildReviewBundle(draft: ReviewDraft, opts: { scopedToLastTurn: boolean }): string {
  if (reviewDraftSize(draft) === 0) return "";
  const lines: string[] = [];
  lines.push(opts.scopedToLastTurn ? "Review notes on your last turn:" : "Review notes on the changes so far:");
  lines.push("");
  for (const severity of SEVERITIES) {
    const group = draft.notes.filter((n) => n.severity === severity.id);
    if (group.length === 0) continue;
    lines.push(`${severity.label}:`);
    for (const note of group) {
      lines.push(`- ${note.path}${note.line ? `:${note.line}` : ""} — ${note.body}`);
    }
    lines.push("");
  }
  const entries = Object.entries(draft.verdicts);
  const needsChange = entries.filter(([, v]) => v === "change").map(([p]) => p);
  const looksRight = entries.filter(([, v]) => v === "ok").map(([p]) => p);
  if (needsChange.length > 0) lines.push(`Files I marked as needing a change: ${needsChange.join(", ")}`);
  if (looksRight.length > 0) lines.push(`Files I marked as looking right: ${looksRight.join(", ")}`);
  return lines.join("\n").trim();
}

/* ── Review drafts, per run, per browser ─────────────────────────────────── */

const REVIEW_DRAFT_PREFIX = "juno:code:review:";

/**
 * Notes outlive the pane.
 *
 * They were component state, the pane unmounts on close, and a reader who
 * closed it to check something lost every note with no warning. Storage can be
 * unavailable (private mode, quota) and every access is wrapped for it: a draft
 * is a courtesy, and a courtesy must never be the thing that throws.
 */
export function readReviewDraft(runId: string): ReviewDraft {
  if (typeof window === "undefined") return EMPTY_REVIEW_DRAFT;
  try {
    const raw = window.localStorage.getItem(`${REVIEW_DRAFT_PREFIX}${runId}`);
    if (!raw) return EMPTY_REVIEW_DRAFT;
    const parsed = JSON.parse(raw) as Partial<ReviewDraft>;
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter(
          (n): n is ReviewNote =>
            !!n && typeof n === "object" && typeof n.id === "string" && typeof n.path === "string" && typeof n.body === "string",
        )
      : [];
    const verdicts: Record<string, Verdict> = {};
    if (parsed.verdicts && typeof parsed.verdicts === "object") {
      for (const [path, verdict] of Object.entries(parsed.verdicts)) {
        if (verdict === "ok" || verdict === "change") verdicts[path] = verdict;
      }
    }
    return { notes, verdicts };
  } catch {
    return EMPTY_REVIEW_DRAFT;
  }
}

export function writeReviewDraft(runId: string, draft: ReviewDraft): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${REVIEW_DRAFT_PREFIX}${runId}`;
    if (reviewDraftSize(draft) === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode, quota); the draft is a courtesy.
  }
}

export function clearReviewDraft(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${REVIEW_DRAFT_PREFIX}${runId}`);
  } catch {
    /* nothing to clear */
  }
}
