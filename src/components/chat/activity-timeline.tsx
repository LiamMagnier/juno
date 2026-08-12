"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { ThinkingReasoning } from "@/components/aicss/thinking-reasoning";
import { ThinkingState } from "@/components/aicss/thinking-state";
import { WebSearchBlock } from "@/components/aicss/web-search";
import {
  ThoughtProcessPanel,
  buildRun,
  domainOf,
  formatSpan,
  toSearchSites,
  useRunClock,
} from "@/components/chat/thought-process-panel";
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { Pressable } from "@/components/ui/pressable";
import { toReasoningLines } from "@/lib/reasoning-lines";
import { cn, truncate } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

/**
 * WHAT THE RUN IS DOING, RIGHT NOW — one sentence, computed once.
 *
 * Exported in spirit but not in fact: the panel receives the RESULT of this as a
 * prop rather than calling it a second time. It has no events of its own to call
 * it with, and one value handed down cannot drift from itself, which is the same
 * argument that keeps `useRunClock` to a single caller.
 *
 * `thinkMs` — NOT the total elapsed. The "Still thinking" ladder below is about
 * a silent reasoning stretch, and passing the whole run's elapsed time fired it
 * on a deep-research run that had spent its first hundred seconds visibly
 * SEARCHING, with sources landing on screen the entire time.
 */
function liveCopy(
  activeLabel: string | undefined,
  latest: ClientActivityEvent | undefined,
  thinkMs: number | null
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
  const elapsed = thinkMs ?? 0;
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
 *
 * IT IS ONE TRIGGER WHOSE TENSE CHANGES, not two controls. The live state is a
 * present-tense sentence under a shimmer; the resting state is the same row
 * rewritten in the past tense with the same number in the same slot. What the
 * resting row does NOT say is "Thought for 2.7s": that string was the panel's
 * old third opinion on the run's duration, printed next to the strip's and the
 * ledger's, and all three could disagree because two formatters were involved.
 * There is now one formatter (`formatSpan`) and one figure, and the label above
 * it names the run rather than re-timing it.
 */
export function ActivityTimeline({
  messageId,
  events,
  reasoning,
  reasoningParts,
  streaming,
  finishNote,
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
  /** The finish-reason sentence message-item already resolved. Passed straight
   *  through to the panel's Notice block; this row does not render it (the
   *  strip already carries `run.note`, and two wordings of "it stopped early"
   *  in one line is how a strip becomes a paragraph). */
  finishNote?: string | null;
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
      // preventScroll, or the browser scrolls the transcript back up to this row
      // the instant the dock closes — throwing the reader off the answer they
      // had just scrolled down to read.
      if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true });
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
  // The THINK span, not the whole run — see liveCopy.
  const live = liveCopy(active?.label, latest, run.phases.find((p) => p.key === "think")?.ms ?? null);
  // Tool calls join the resting nouns for the same reason sources did: a run
  // that used connectors and searched nothing had NO noun at all, so its strip
  // read "See how this response was made" — the generic invitation — over the
  // one kind of run whose panel now carries the most. Warnings are excluded;
  // they already have their own slot in `run.note`.
  const toolCalls = run.calls.filter((c) => !c.warn).length;
  const restingDetail = [
    run.searches ? `${run.searches} ${run.searches === 1 ? "search" : "searches"}` : null,
    run.sourceCount ? `${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}` : null,
    toolCalls ? `${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}` : null,
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
    : [
        hasReasoning ? `Open thought process — complete` : `Open run details — complete`,
        run.elapsedMs === null ? null : formatSpan(run.elapsedMs),
      ]
        .filter(Boolean)
        .join(", ");

  // The lines AIcss's viewport shows. A display chunking of what the provider
  // sent — never a claim about where its steps were; see reasoning-lines.ts.
  const reasoningLines = streaming ? toReasoningLines(reasoning, reasoningParts) : [];
  const searchSites = streaming ? toSearchSites(run.sources) : [];
  const showSearch = !!streaming && !!run.query;
  const hasLiveBlocks = reasoningLines.length > 0 || showSearch;

  return (
    <>
      {/* A selectable row, so it uses the row primitive. Open used to differ from
          hovered by 10% of one alpha (bg-muted/55 vs bg-muted/45), and since the
          pointer is by definition resting on the row you just clicked, opening
          the panel produced no perceptible change in its own trigger. Pressable's
          selected treatment — primary tint plus an inset ring — exists precisely
          because a selected row and a hovered row must not be the same fill.
          Focus is left to the global :focus-visible rule, which this had
          overridden with a local ring. */}
      <Pressable
        ref={triggerRef}
        kind="row"
        selected={open}
        onClick={() => panel?.setOpenId(open ? null : messageId)}
        aria-expanded={open}
        /* No aria-haspopup: this is no longer a dialog, it is a disclosure that
           docks a region. aria-controls is set only while the panel is mounted,
           so it never points at an id that is not in the document. */
        aria-controls={open ? panelDomId : undefined}
        aria-label={label}
        className={cn(
          "group/thought relative -mx-2 w-[calc(100%+1rem)] overflow-hidden rounded-field px-2 py-1.5",
          "transition-colors duration-base ease-out-soft motion-reduce:transition-none coarse:min-h-14",
          streaming ? "min-h-10 gap-3" : "min-h-12 gap-3",
          // The gap to the answer belongs to whatever is last. With live blocks
          // below, this row's own margin would open a hole between the label and
          // the trace it labels.
          hasLiveBlocks ? "mb-0.5" : "mb-3"
        )}
      >
        {/* aria-hidden: see `label`. The button is named by aria-label, so this
            stops the surrounding live region announcing every clock tick. */}
        {streaming ? (
          <>
            <ThinkingDots className="text-muted-foreground/65" />
            {/* AIcss's Thinking State in place of `animate-status-glow`. Both say
                "still here" without spending coral on it, but the glow breathed
                the whole line's opacity — which dims the sentence you are trying
                to read — where the shine moves a valley of alpha THROUGH the
                text at full weight. Same node, same slot; on settle it simply
                stops rather than fading to a different colour. */}
            {live.warning ? (
              <span key={copyKey} aria-hidden="true" className="min-w-0 truncate text-body-lg leading-6 text-warning">
                {live.message}
                {run.elapsedMs !== null && (
                  <span className="whitespace-nowrap tabular-nums"> · {formatSpan(run.elapsedMs, { live: true })}</span>
                )}
              </span>
            ) : (
              <ThinkingState key={copyKey} aria-hidden="true" className="min-w-0 truncate text-body-lg leading-6">
                {live.message}
                {run.elapsedMs !== null && (
                  <span className="whitespace-nowrap tabular-nums"> · {formatSpan(run.elapsedMs, { live: true })}</span>
                )}
              </ThinkingState>
            )}
          </>
        ) : (
          <>
            <span aria-hidden="true" className="flex w-9 shrink-0 items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45 transition-colors duration-base group-hover/thought:bg-primary/70 motion-reduce:transition-none" />
            </span>
            <span aria-hidden="true" className="min-w-0 flex-1">
              {/* "Thought process" only when there WAS one. Plenty of models
                  emit no reasoning at all, and labelling their turn with a
                  thought process invites the reader to open a panel that has
                  nothing in it — and quietly implies the model reasoned when it
                  did not. `hasReasoning` is already computed above. */}
              <span className="block font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em] text-muted-foreground">
                {hasReasoning ? "Thought process" : "Run"}
              </span>
              <span className="block truncate text-body leading-5 text-foreground/80">
                {detail}
                {run.note && <span className="text-warning"> · {run.note}</span>}
              </span>
            </span>
            {run.elapsedMs !== null && <span aria-hidden="true" className="shrink-0 px-1 font-mono text-caption tabular-nums text-muted-foreground">{formatSpan(run.elapsedMs)}</span>}
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-[color,transform] duration-base ease-out-soft group-hover/thought:translate-x-0.5 group-hover/thought:text-foreground/70 motion-reduce:transition-none" aria-hidden="true" />
          </>
        )}
      </Pressable>

      {/* THE LIVE TRACE, which this component used to refuse to show.
          The refusal was right about the CONTAINER and got read as being about
          the content: a raw growing block of provider summary — half sentences,
          stray code, media queries — reflowed the transcript on every delta and
          made the answer look broken. AIcss's viewport is the container that
          answers it. Each line is a 40px slot clamped to two lines, the whole
          thing caps at 180px and then scrolls behind a mask, and the newest line
          is translated into view rather than scrolled to. Nothing under the
          reader moves, and a half-finished sentence is the last of six quiet grey
          lines instead of a wall.

          `aria-hidden` because message-item mounts this inside an
          `aria-live="polite"` region: every delta rewrites these nodes, and a
          screen reader would read the model's entire private reasoning aloud,
          twice-revised, before ever reaching the answer. The strip's own
          aria-label already names the state. */}
      {hasLiveBlocks && (
        <div aria-hidden="true" className="mb-3 flex flex-col gap-2.5 pl-2">
          {showSearch && (
            <WebSearchBlock
              query={run.query!}
              sites={searchSites}
              // Settled once the run has moved past research: the query stops
              // shimmering the moment the phase it describes is over, not when
              // the whole answer lands.
              settled={!run.phases.some((phase) => phase.key === "research" && phase.active)}
            />
          )}
          {reasoningLines.length > 0 && (
            <ThinkingReasoning lines={reasoningLines} streaming showHeader={false} />
          )}
        </div>
      )}

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
              // Computed ONCE, above, and handed down — the same argument as
              // `run`: the strip and the panel must be incapable of disagreeing
              // about what the run is doing, and the only way to guarantee that
              // is for there to be one value rather than two agreeing ones.
              live={live}
              finishNote={finishNote}
            />,
            panel.container
          )
        : null}
    </>
  );
}
