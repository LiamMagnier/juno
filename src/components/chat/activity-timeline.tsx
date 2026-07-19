"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { ThoughtProcessPanel, buildRun, domainOf, formatSpan, useRunClock } from "@/components/chat/thought-process-panel";
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { cn, truncate } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

function liveCopy(
  activeLabel: string | undefined,
  latest: ClientActivityEvent | undefined,
  elapsedMs: number | null
) {
  if (latest?.kind === "warning") {
    return { message: latest.title, warning: true };
  }

  if (activeLabel === "Research") {
    if (latest?.kind === "visit" && latest.url) {
      return { message: `Reading ${domainOf(latest.url)}`, warning: false };
    }
    if (latest?.kind === "search" && latest.title === "Searching the web" && latest.detail) {
      return { message: `Searching for “${truncate(latest.detail, 58)}”`, warning: false };
    }
    return { message: "Researching your request", warning: false };
  }

  if (latest?.kind === "tool" && latest.title.startsWith("Using ")) {
    const tool = [latest.title.slice(6), latest.detail].filter(Boolean).join(" · ");
    return { message: `Using ${tool}`, warning: false };
  }

  if (activeLabel === "Write") {
    return { message: "Writing the response", warning: false };
  }

  // Progressive copy so a long silent reasoning stretch (Kimi, Claude Max, …)
  // doesn't read as hung — and reminds people they can leave and come back.
  const elapsed = elapsedMs ?? 0;
  if (elapsed >= 10 * 60_000) {
    return {
      message: "Still thinking deeply — safe to leave; the answer will be here when you return",
      warning: false,
    };
  }
  if (elapsed >= 2 * 60_000) {
    return {
      message: "Still thinking — working in the background",
      warning: false,
    };
  }
  return { message: "Thinking about your request", warning: false };
}

function formatLiveSpan(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The collapsed run strip in the message list. Live reasoning is intentionally
 * not previewed here: provider summaries often contain code, media queries and
 * half-finished sentences, which made the primary transcript look broken. The
 * strip communicates the useful contract instead — phase, current action and
 * elapsed time — while the full provider text remains one click away.
 *
 *   live    3×3 matrix  Thinking about your request · 4s
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
  const live = liveCopy(active?.label, latest, run.elapsedMs);
  const restingDetail = [
    run.searches ? `${run.searches} ${run.searches === 1 ? "search" : "searches"}` : null,
    run.sourceCount ? `${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail = restingDetail || "See how this response was made";
  // A phase change should animate once. Reasoning-token growth never changes
  // this key, so the collapsed UI stays calm during long streams.
  const copyKey = streaming ? `${active?.key ?? "think"}-${latest?.kind ?? "reasoning"}-${live.message}` : "complete";

  // THE ACCESSIBLE NAME IS THE WHOLE CONTROL. message-item mounts this inside an
  // `aria-live="polite"` region, so every mutating text node underneath is
  // announced. The elapsed number alone rewrites once a second. Left visible
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
          "group/thought relative -mx-2 mb-3 flex w-[calc(100%+1rem)] items-center overflow-hidden rounded-xl px-2 py-1.5 text-left",
          "transition-colors duration-base ease-out-soft hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none coarse:min-h-14",
          streaming ? "min-h-10 gap-3" : "min-h-12 gap-3",
          open && "bg-muted/55"
        )}
      >
        {/* aria-hidden: see `label`. The button is named by aria-label, so this
            stops the surrounding live region announcing every clock tick. */}
        {streaming ? (
          <>
            <ThinkingDots className="text-muted-foreground/65" />
            <span
              key={copyKey}
              aria-hidden="true"
              className={cn(
                "min-w-0 truncate text-body-lg leading-6",
                live.warning ? "text-warning" : "text-muted-foreground/85 motion-safe:animate-status-glow"
              )}
            >
              {live.message}
              {run.elapsedMs !== null && <span className="whitespace-nowrap tabular-nums"> · {formatLiveSpan(run.elapsedMs)}</span>}
            </span>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="flex w-9 shrink-0 items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45 transition-colors duration-base group-hover/thought:bg-primary/70 motion-reduce:transition-none" />
            </span>
            <span aria-hidden="true" className="min-w-0 flex-1">
              <span className="block font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em] text-muted-foreground/65">Thought process</span>
              <span className="block truncate text-body leading-5 text-foreground/78">
                {detail}
                {run.note && <span className="text-warning"> · {run.note}</span>}
              </span>
            </span>
            {run.elapsedMs !== null && <span aria-hidden="true" className="shrink-0 px-1 font-mono text-caption tabular-nums text-muted-foreground/60">{formatSpan(run.elapsedMs)}</span>}
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/35 transition-[color,transform] duration-base ease-out-soft group-hover/thought:translate-x-0.5 group-hover/thought:text-foreground/70 motion-reduce:transition-none" aria-hidden="true" />
          </>
        )}
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
