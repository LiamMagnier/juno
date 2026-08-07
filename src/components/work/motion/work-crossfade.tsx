"use client";

import * as React from "react";

/*
 * A placeholder that leaves after its content has arrived, rather than the
 * frame before it.
 *
 * THE PROBLEM THIS EXISTS FOR. Every list in the app resolves the same way:
 * render a skeleton while the request is out, then swap it for rows. At three
 * placeholder rows and 86px each that swap is a hard cut across a third of the
 * viewport, and a hard cut at that size reads as a flicker even though the
 * layout barely moves — the eye registers "something went wrong" before it
 * registers "the tasks are here".
 *
 * So the placeholder is held for one more beat and fades out ON TOP of the real
 * rows. The rows own the layout from the first frame they exist in; the ghost is
 * out of flow, inert, and purely pixels (see `.work-crossfade-ghost` in
 * globals.css, which is where the geometry and its one compromise are argued).
 *
 * WHY THE SWAP IS DECIDED DURING RENDER. The obvious version puts the ghost up
 * in an effect, which runs after the browser has already painted the swapped
 * content. That paints the hard cut and THEN fades a skeleton in over the top of
 * it — the placeholder appears to come back. Adjusting state during render (the
 * pattern React documents for state derived from props) means the ghost is in
 * the very first committed render that has content in it, so there is never a
 * frame showing one without the other.
 */

/**
 * How long the ghost is held, mirroring `--dur-base` — the crossfade is one
 * small thing settling, and it must not outlast the entrance of the rows
 * underneath it.
 *
 * Kept in sync by hand because a number in CSS is not readable from here. If the
 * two ever drift the failure is mild in both directions: too short and the fade
 * is cut off partway (a small step in opacity, not a flash), too long and an
 * already-invisible, already-inert overlay lingers a moment longer.
 */
export const WORK_CROSSFADE_MS = 220;

export function WorkCrossfade({
  /** True while the content is still being loaded. */
  pending,
  /** What to show meanwhile — and what fades out afterwards. */
  placeholder,
  children,
}: {
  pending: boolean;
  placeholder: React.ReactNode;
  children: React.ReactNode;
}) {
  const [ghost, setGhost] = React.useState(false);
  const [shown, setShown] = React.useState(pending);

  if (shown !== pending) {
    setShown(pending);
    // Only the pending -> ready direction leaves anything behind. Going back to
    // pending — a filter cleared, a reload that blanks the list — replaces the
    // content with the placeholder itself, so there is nothing to fade over.
    setGhost(!pending);
  }

  React.useEffect(() => {
    if (!ghost) return;
    const timer = window.setTimeout(() => setGhost(false), WORK_CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [ghost]);

  if (pending) return <>{placeholder}</>;

  return (
    <div className="work-crossfade">
      {children}
      {ghost && (
        // aria-hidden: the placeholder has already been announced once, and a
        // screen reader meeting it a second time — after the real content — is
        // told the list is still loading when it is not.
        <div className="work-crossfade-ghost" aria-hidden="true">
          {placeholder}
        </div>
      )}
    </div>
  );
}
