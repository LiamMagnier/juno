"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { ThoughtProcessPanel, buildRun, domainOf, formatSpan, useRunClock } from "@/components/chat/thought-process-panel";
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { cn, truncate } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

function liveCopy(activeLabel: string | undefined, latest?: ClientActivityEvent) {
  if (latest?.kind === "warning") {
    return { label: "Attention", detail: latest.title, warning: true };
  }

  if (activeLabel === "Research") {
    if (latest?.kind === "visit" && latest.url) {
      return { label: "Researching", detail: `Reading ${domainOf(latest.url)}`, warning: false };
    }
    if (latest?.kind === "search" && latest.title === "Searching the web" && latest.detail) {
      return { label: "Researching", detail: `Searching for “${truncate(latest.detail, 58)}”`, warning: false };
    }
    return { label: "Researching", detail: "Finding and checking useful sources", warning: false };
  }

  if (latest?.kind === "tool" && latest.title.startsWith("Using ")) {
    const tool = [latest.title.slice(6), latest.detail].filter(Boolean).join(" · ");
    return { label: "Working", detail: tool, warning: false };
  }

  if (activeLabel === "Write") {
    return { label: "Writing", detail: "Composing the response", warning: false };
  }

  return { label: "Thinking", detail: "Working through the request", warning: false };
}

/**
 * The collapsed run strip in the message list. Live reasoning is intentionally
 * not previewed here: provider summaries often contain code, media queries and
 * half-finished sentences, which made the primary transcript look broken. The
 * strip communicates the useful contract instead — phase, current action and
 * elapsed time — while the full provider text remains one click away.
 *
 *   live    •••••  THINKING     Working through the request     4.2s  ›
 *   rest           THOUGHT PROCESS  4 searches · 9 sources      8.4s  ›
 *
 * The duration occupies the SAME node, slot and typeface in both states, so the
 * eye tracks one continuous object from meter to receipt. Completion is four
 * discrete signals — the tick freezes, the number demotes, nouns appear, coral
 * leaves — and motion stopping is the least of them.
 */
export function ActivityTimeline({
  messageId,
  events,
  reasoning,
  reasoningParts,
  streaming,
}: {
  /** Identifies THIS run's panel in the chat-scoped open state, so only one
   *  dock is open at a time across the whole thread. */
  messageId: string;
  events?: ClientActivityEvent[];
  reasoning?: string | null;
  /** Discrete summary parts, when the provider sent them. Passed straight
   *  through — this component derives nothing from them. */
  reasoningParts?: string[] | null;
  streaming?: boolean;
}) {
  // Open/close lives in chat-view (see thought-panel-context): the panel is a
  // docked column and cannot be painted from inside this scrolling row. The RUN
  // and its clock stay here, and the panel rides a portal to reach the dock.
  const panel = useThoughtPanel();
  const open = !!panel && panel.openId === messageId;
  const panelDomId = `thought-panel-${messageId}`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const list = React.useMemo(() => events ?? [], [events]);

  // Focus comes back on close — the panel took it on open and nothing else
  // claimed it (Esc, or the close button, which unmounts under the caret and
  // drops focus to <body>). If the user closed this dock by opening ANOTHER
  // row's, focus is already on that row's trigger, so we leave it alone rather
  // than yanking it backwards.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const hasEvents = list.length > 0;
  const hasReasoning = !!reasoning?.trim();

  // WITHDRAW THE CLAIM when there is nothing left to show. The dock is keyed on
  // `messageId`, but this row can stop rendering while that id stays perfectly
  // valid: paging the VersionPager back to an older version hands us
  // `activity: undefined` and `reasoning: null` under the SAME message, and the
  // early return below takes the panel AND the trigger with it — leaving an
  // empty dock with nothing left to toggle it shut. chat-view reconciles against
  // the message list and cannot see this; only we can.
  const renders = hasEvents || hasReasoning;
  const setPanelOpenId = panel?.setOpenId;
  React.useEffect(() => {
    if (open && !renders) setPanelOpenId?.(null);
  }, [open, renders, setPanelOpenId]);

  // THE run's clock and THE run's model — singular, and passed down to the panel
  // rather than rebuilt there. Calibration happens on the render that first sees
  // an event, which is this component's, because it mounts with the run. A second
  // instance inside the panel would calibrate whenever the sheet was opened and
  // read 0.0s next to this row's 8.4s.
  const { nowServer, anchorT0 } = useRunClock(list, streaming);
  const run = React.useMemo(() => buildRun(list, nowServer, anchorT0), [list, nowServer, anchorT0]);

  if (!hasEvents && !hasReasoning) return null;

  const latest = hasEvents ? list[list.length - 1] : undefined;
  const active = run.phases.find((p) => p.active);
  const live = liveCopy(active?.label, latest);
  const restingDetail = [
    run.searches ? `${run.searches} ${run.searches === 1 ? "search" : "searches"}` : null,
    run.sourceCount ? `${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const phaseLabel = streaming ? live.label : "Thought process";
  const detail = streaming ? live.detail : restingDetail || "See how this response was made";
  // A phase change should animate once. Reasoning-token growth never changes
  // this key, so the collapsed UI stays calm during long streams.
  const copyKey = streaming ? `${active?.key ?? "think"}-${latest?.kind ?? "reasoning"}-${live.detail}` : "complete";

  // THE ACCESSIBLE NAME IS THE WHOLE CONTROL. message-item mounts this inside an
  // `aria-live="polite"` region, so every mutating text node underneath is
  // announced. The elapsed number alone can rewrite 10x a second. Left visible
  // to the a11y tree, a screen reader would read
  // "4.2s, 4.3s, 4.4s…" for the whole pre-first-token wait, which route.ts
  // documents as lasting MINUTES on hidden-reasoning models, with no way to
  // reach the answer. A stable aria-label on the button does not help while the
  // live region can still see the text nodes inside it — so the visual content
  // is hidden from the tree outright and the label carries the full state
  // instead. It changes exactly once per run, on settle, which is the one
  // announcement actually worth making.
  const label = streaming
    ? "Open thought process — in progress"
    : [`Open thought process — complete`, run.elapsedMs === null ? null : formatSpan(run.elapsedMs)]
        .filter(Boolean)
        .join(", ");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => panel?.setOpenId(open ? null : messageId)}
        aria-expanded={open}
        /* No aria-haspopup: this is no longer a dialog, it is a disclosure that
           docks a region. aria-controls is set only while the panel is mounted,
           so it never points at an id that is not in the document. */
        aria-controls={open ? panelDomId : undefined}
        aria-label={label}
        className={cn(
          "group/thought relative -mx-2 mb-3 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 overflow-hidden rounded-xl px-2 py-1.5 text-left",
          "transition-colors duration-base ease-out-soft hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none coarse:min-h-14",
          open && "bg-muted/55"
        )}
      >
        {/* aria-hidden: see `label`. The button is named by aria-label, so this
            stops the surrounding live region announcing every clock tick. */}
        <span aria-hidden="true" className="flex w-9 shrink-0 items-center justify-center">
          {streaming ? (
            <ThinkingDots className="text-muted-foreground/55" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45 transition-colors duration-base group-hover/thought:bg-primary/70 motion-reduce:transition-none" />
          )}
        </span>

        <span aria-hidden="true" className="min-w-0 flex-1">
          <span
            className={cn(
              "block font-mono text-[10px] font-medium uppercase leading-4 tracking-[0.13em]",
              streaming ? (live.warning ? "text-warning" : "text-primary") : "text-muted-foreground/65"
            )}
          >
            {phaseLabel}
          </span>
          <span
            key={copyKey}
            className={cn(
              "block truncate text-body leading-5 motion-safe:animate-fade-in",
              live.warning && streaming ? "text-warning" : "text-foreground/78"
            )}
          >
            {detail}
            {!streaming && run.note && <span className="text-warning"> · {run.note}</span>}
          </span>
        </span>

        {run.elapsedMs !== null && (
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0 font-mono text-caption tabular-nums transition-colors duration-slow ease-out-soft motion-reduce:transition-none",
              // Same node across the lifecycle. It freezes rather than being
              // replaced, and visibly demotes from meter to artifact.
              streaming ? "rounded-full bg-primary/8 px-2 py-1 text-primary" : "px-1 text-muted-foreground/60"
            )}
          >
            {formatSpan(run.elapsedMs)}
          </span>
        )}

        {/* The only icon on this surface, and it is an affordance, not a status
            mark: it says "this opens something" in the register of punctuation.
            It does not rotate — this opens a side panel, not an accordion. */}
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground/35 transition-[color,transform] duration-base ease-out-soft group-hover/thought:translate-x-0.5 group-hover/thought:text-foreground/70 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </button>

      {/* The portal is the whole trick: the panel stays in THIS React subtree —
          so it keeps receiving the run built from the one clock above — while
          its DOM lands in the dock beside the chat column. */}
      {open && panel.container
        ? createPortal(
            <ThoughtProcessPanel
              id={panelDomId}
              onClose={() => panel.setOpenId(null)}
              run={run}
              reasoning={reasoning}
              reasoningParts={reasoningParts}
              streaming={streaming}
            />,
            panel.container
          )
        : null}
    </>
  );
}
