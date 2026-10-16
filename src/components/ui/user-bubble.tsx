"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE ONE USER BUBBLE (spec D6, §6.17), on the web.
 *
 * Card radius 12 with an 8 tuck on the bottom-trailing corner — the LOGICAL
 * end-end corner, so it mirrors under RTL — padding 10/16 (today's
 * `px-4 py-2.5`, unchanged), at most 85% of the column, filled with
 * `--user-bubble`, the one tonal fill in the flat transcript. Controls drawn
 * on it (Show more, the editor's buttons) hover on `--user-bubble-hover`.
 * Under high contrast it gains the 1px tone-step edge (`data-tone-step`).
 *
 * Every context that draws a user turn (chat, Code, share, galleries) renders
 * this component or spreads these constants, behind the six-context parity
 * gate (spec §9): radii 12/12/12/8 and the one fill. [S3]
 *
 * LONG MESSAGES. Taller than 12 lines, the bubble clamps with a fade to its
 * own fill and a "Show more" button in ui 13; the fade's stop is exported so
 * an editor that draws its own clamp matches.
 *
 * FLIP. `layoutId` is a stable `data-layout-id` for the send travel (C17),
 * so QuoteCards and AttachmentChips can land in the bubble they belong to.
 */

/** The fill, as a CSS colour. */
export const USER_BUBBLE_FILL = "hsl(var(--user-bubble))";
/** Hover and press of controls drawn on the bubble. */
export const USER_BUBBLE_HOVER_FILL = "hsl(var(--user-bubble-hover))";
export const USER_BUBBLE_HOVER_CLASS = "hover:bg-[hsl(var(--user-bubble-hover))] active:bg-[hsl(var(--user-bubble-hover))]";
/** The clamp's fade: transparent to the bubble's own fill. */
export const USER_BUBBLE_CLAMP_GRADIENT = `linear-gradient(to bottom, hsl(var(--user-bubble) / 0), ${USER_BUBBLE_FILL})`;
/** How many lines show before the bubble clamps. */
export const USER_BUBBLE_CLAMP_LINES = 12;

/** The bubble's shape and fill, for a context that cannot render the component. */
export const USER_BUBBLE_CLASS =
  "ui-user-bubble whitespace-pre-wrap bg-[hsl(var(--user-bubble))] px-4 py-2.5 text-reading";

export interface UserBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Clamp at 12 lines with a fade and Show more (default true). */
  clamp?: boolean;
  /** A stable id for the send FLIP (C17). */
  layoutId?: string;
  /** Labels the expand control (the i18n layer translates it). */
  showMoreLabel?: string;
  showLessLabel?: string;
}

export const UserBubble = React.forwardRef<HTMLDivElement, UserBubbleProps>(
  ({ className, children, clamp = true, layoutId, showMoreLabel = "Show more", showLessLabel = "Show less", style, ...props }, ref) => {
    const body = React.useRef<HTMLDivElement>(null);
    const [overflows, setOverflows] = React.useState(false);
    const [expanded, setExpanded] = React.useState(false);

    React.useLayoutEffect(() => {
      const el = body.current;
      if (!clamp || !el || typeof ResizeObserver === "undefined") return;
      const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }, [clamp, children]);

    const clamped = clamp && !expanded;
    return (
      <div
        ref={ref}
        className={cn(USER_BUBBLE_CLASS, "relative max-w-[85%] break-words", className)}
        data-user-bubble=""
        data-tone-step=""
        data-layout-id={layoutId}
        style={style}
        {...props}
      >
        <div
          ref={body}
          className="ui-user-bubble__body"
          style={clamped ? { maxHeight: `calc(${USER_BUBBLE_CLAMP_LINES} * 1lh)`, overflow: "hidden" } : undefined}
        >
          {children}
        </div>
        {clamp && (overflows || expanded) ? (
          <>
            {clamped ? (
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-4 bottom-10 h-10" style={{ backgroundImage: USER_BUBBLE_CLAMP_GRADIENT }} />
            ) : null}
            <button
              type="button"
              className={cn("mt-1 -mx-2 rounded-control px-2 py-0.5 text-ui text-muted-on-fill transition-colors duration-fast ease-out-soft", USER_BUBBLE_HOVER_CLASS)}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? showLessLabel : showMoreLabel}
            </button>
          </>
        ) : null}
      </div>
    );
  }
);
UserBubble.displayName = "UserBubble";
