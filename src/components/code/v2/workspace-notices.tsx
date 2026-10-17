"use client";

/**
 * Two things the Code workspace used to do TO the reader, now offered to them:
 *
 * - Connections. A new account's first session opened the Connections sheet
 *   over the thread just as its first prompt sent, though Alevr's included
 *   models already work. Now the empty state carries one quiet line that
 *   offers it, and it is gone for good once dismissed or followed.
 * - New agents. Each new subagent switched the right panel to Agents,
 *   pulling the reader off whatever they had open there (a diff, the
 *   terminal). Now the panel button carries a count and a screen reader hears
 *   one polite line; the Agents tab is a click away.
 */
import * as React from "react";
import { Glyph } from "./primitives";

/** Agent ids in `next` that `seen` did not have, in order. */
export function newAgentIds(seen: ReadonlySet<string>, next: readonly string[]): string[] {
  return [...new Set(next.filter((id) => !seen.has(id)))];
}

export function ConnectionsHint({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="cv2-hint" role="note">
      <span className="cv2-grow">
        You’re on Alevr’s models. To use Claude, Codex or your own keys,{" "}
        <button type="button" className="cv2-link" onClick={onOpen}>
          open Connections
        </button>
        .
      </span>
      <button type="button" className="cv2-iconbtn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <Glyph name="close" size={14} />
      </button>
    </div>
  );
}

/** The count on the panel button while new agents wait to be seen. */
export function NewAgentsBadge({ count }: { count: number }) {
  const [announce, setAnnounce] = React.useState(false);
  const last = React.useRef(count);
  React.useEffect(() => {
    if (count > last.current) setAnnounce(true);
    last.current = count;
    if (count === 0) setAnnounce(false);
  }, [count]);
  return (
    <>
      {count > 0 && (
        <span className="cv2-badge" aria-hidden>
          {count > 9 ? "9+" : count}
        </span>
      )}
      <span className="cv2-sr" aria-live="polite">
        {announce && count > 0 ? (count === 1 ? "A new agent started. It is in the Agents panel." : "New agents started. They are in the Agents panel.") : ""}
      </span>
    </>
  );
}
