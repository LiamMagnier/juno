"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { Brain, ChevronRight, Globe, Wrench } from "@/components/ui/icons";
import { WebSearchBlock } from "@/components/aicss/web-search";
import {
  buildRun,
  domainOf,
  formatSpan,
  toSearchSites,
  useRunClock,
} from "@/components/chat/thought-process-model";

/**
 * The panel is fetched when it is opened, not when the strip renders.
 *
 * This strip renders on every turn; the panel renders only once a reader
 * presses it open, and it is 64 kB of source. They shared a module until the
 * model was split out (thought-process-model.tsx), which is why the import
 * below can be dynamic at all — a `next/dynamic` here while the helpers above
 * still came from the panel's own file would have moved nothing.
 *
 * `ssr: false` is not a constraint: the render site is already behind
 * `open && panel.container`, and `panel.container` is a DOM node the dock
 * publishes after mount, so this never had a server render to give up.
 */
const ThoughtProcessPanel = nextDynamic(
  () => import("@/components/chat/thought-process-panel").then((m) => m.ThoughtProcessPanel),
  { ssr: false },
);
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { Pressable } from "@/components/ui/pressable";
import { cn, truncate } from "@/lib/utils";
import { receiptLabelForCall } from "@/lib/chat/tool-receipt";
import { activeRunId, runReceiptParts } from "@/lib/chat/tool-run";
import { ToolRunOutputs } from "@/components/chat/tool-run-files";
import type { ClientActivityEvent, ClientSource } from "@/types/chat";

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
    return { message: "Researching", warning: false };
  }

  if (latest?.kind === "tool" && latest.title.startsWith("Using ")) {
    // The receipt's own present tense ("Searching the web", "Linear · Create
    // issue"), so the strip and the Thought process row say one call one way.
    return {
      message: receiptLabelForCall(latest.title.slice("Using ".length), latest.detail, true),
      warning: false,
    };
  }

  // Prefix matches `SKILL_USED_ACTIVITY_PREFIX` in `@/lib/chat/skills`, kept as
  // a literal so this strip does not pull the skill permission module.
  if (latest?.kind === "tool" && latest.title.startsWith("Used skill")) {
    return { message: latest.title, warning: false };
  }

  if (activeLabel === "Write") {
    return { message: "Writing", warning: false };
  }

  // One word until the wait needs explaining. The later rungs keep a long
  // silent reasoning stretch (Kimi, Claude Max, …) from reading as hung, and
  // say that leaving is safe. The same three sentences as the transcript's
  // own status line (message-item.tsx, StreamStatus), so the strip and the
  // line never describe one wait in two voices.
  const elapsed = thinkMs ?? 0;
  if (elapsed >= 10 * 60_000) {
    return { message: "Still working. You can leave; the answer will be here.", warning: false };
  }
  if (elapsed >= 2 * 60_000) {
    return { message: "Still thinking. This can take a few minutes.", warning: false };
  }
  return { message: "Thinking", warning: false };
}

/**
 * The collapsed run strip in the message list. Live reasoning is intentionally
 * not previewed here: provider summaries often contain code, media queries and
 * half-finished sentences, which made the primary transcript look broken. The
 * strip communicates the useful contract instead — phase, current action and
 * elapsed time — while the full provider text remains one click away.
 *
 *   live    3×3 matrix  Thinking · 4s
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
  sources,
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
  /** The message's own source list. Forwarded into `buildRun` for ONE purpose:
   *  a source step's `citeIndex`, which is meaningful only when the model was
   *  handed a numbered corpus (`ClientSource.cited`). Nothing else reads it —
   *  the run's own `visit` events remain the only claim about what was read. */
  sources?: ClientSource[];
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
  const run = React.useMemo(
    () => buildRun(list, nowServer, anchorT0, { sources, reasoning, reasoningParts }),
    [list, nowServer, anchorT0, sources, reasoning, reasoningParts],
  );

  if (!hasEvents && !hasReasoning) return null;

  const latest = hasEvents ? list[list.length - 1] : undefined;
  const active = run.phases.find((p) => p.active);
  // A real run that is working is what the turn is doing, in its own words
  // ("Running Python", "Waiting for your answer"), not "Thinking": the strip
  // follows the truthful work row (MOTION_AND_THINKING.md).
  const runViews = run.calls.flatMap((c) => (c.run ? [c.run] : []));
  const liveRunId = activeRunId(runViews, !!streaming);
  const liveRun = liveRunId ? runViews.find((v) => v.id === liveRunId) : undefined;
  // The THINK span, not the whole run — see liveCopy.
  const live = liveRun
    ? { message: runReceiptParts(liveRun).label, warning: false }
    : liveCopy(active?.label, latest, run.phases.find((p) => p.key === "think")?.ms ?? null);
  // One reading, two consumers: the live count below and WebSearchBlock's
  // settled flag further down describe the same moment of the run.
  const researchActive = run.phases.some((phase) => phase.key === "research" && phase.active);
  // The running count beside the verb, while the run is visibly reading. The
  // verbs alone can't carry progress — "Reading nature.com" looks identical at
  // source 2 and source 20 — and the count lands in the exact noun the resting
  // row will keep ("9 sources"), so settling rewrites tense, not layout. It is
  // deliberately NOT part of copyKey: a count tick must not restart the shine
  // the way a phase change does.
  const liveSources =
    streaming && researchActive && run.sourceCount
      ? `${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}`
      : null;
  // Tool calls join the resting nouns for the same reason sources did: a run
  // that used connectors and searched nothing had NO noun at all, so its strip
  // read "See how this response was made" — the generic invitation — over the
  // one kind of run whose panel now carries the most. Warnings are excluded;
  // they already have their own slot in `run.note`.
  const toolCalls = run.calls.filter((c) => !c.warn).length;
  // The connectors this run reached, by name, for the resting label. "Run" was
  // the one word the row could say about a turn that used GitHub and Linear,
  // and it named the mechanism rather than what happened.
  const toolServers = [
    ...new Set(list.filter((e) => e.kind === "tool" && e.title.startsWith("Using ")).map((e) => e.title.slice(6).trim())),
  ].filter(Boolean);
  const restingTitle = hasReasoning
    ? "Thought process"
    : runViews.length === 1
      ? runReceiptParts(runViews[0]).label
      : runViews.length > 1
        ? `${runViews.length} runs`
        : toolServers.length
      ? `Used ${toolServers.length > 2 ? `${toolServers.slice(0, 2).join(", ")} and ${toolServers.length - 2} more` : toolServers.join(" and ")}`
      : run.searches
        ? "Searched the web"
        : "Run";
  // The resting mark says what KIND of work the row holds, in the place a
  // decorative grey dot used to sit.
  // It follows the title: a thought process is reasoning first, whatever
  // else the run did on the way.
  const RestingIcon = hasReasoning ? Brain : toolCalls ? Wrench : run.searches || run.sourceCount ? Globe : Brain;
  const restingDetail = [
    run.searches ? `${run.searches} ${run.searches === 1 ? "search" : "searches"}` : null,
    run.sourceCount ? `${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}` : null,
    toolCalls ? `${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // A settled run with no reasoning, no searches, no sources and no tool calls
  // has nothing to open: the row would read "Run · See how this response was
  // made" over a panel that is empty. ChatGPT and Claude show no trace line for
  // a plain completion, and neither does this. Live runs always render — the
  // shimmering status IS the feedback while the first token is on its way.
  if (!streaming && !hasReasoning && !restingDetail) return null;
  // A phase change should animate once. Reasoning-token growth never changes
  // this key, so the collapsed UI stays calm during long streams.
  const copyKey = streaming ? `${active?.key ?? "think"}-${latest?.kind ?? "reasoning"}-${live.message}` : "complete";

  // THE ACCESSIBLE NAME IS THE WHOLE CONTROL. The elapsed number alone rewrites
  // once a second. While message-item still mounted this strip inside the
  // turn's `aria-live="polite"` region (the region is the answer body now),
  // every mutating text node underneath was announced, and a screen reader
  // read "4.2s, 4.3s, 4.4s…" for the whole pre-first-token wait, which
  // route.ts documents as lasting MINUTES on hidden-reasoning models, with no
  // way to reach the answer. A stable aria-label on the button does not help
  // while the tree can still see the text nodes inside it — so the visual
  // content is hidden from the tree outright and the label carries the full
  // state instead. It changes exactly once per run, on settle, which is the
  // one announcement actually worth making, and it stays the control's one
  // name now that the region has moved: a ticking text node is noise on every
  // path a reader takes through the strip.
  const label = streaming
    ? "Open thought process, in progress"
    : [
        hasReasoning ? "Open thought process, complete" : "Open run details, complete",
        run.elapsedMs === null ? null : formatSpan(run.elapsedMs),
      ]
        .filter(Boolean)
        .join(", ");

  // Live blocks: only the search line still streams under the strip. Reasoning
  // no longer renders here (summary first; the panel owns the full trace).
  const searchSites = streaming ? toSearchSites(run.sources) : [];
  const showSearch = !!streaming && !!run.query;
  const hasLiveBlocks = showSearch;

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
          // No `transition-*` utility: `.pressable` (inside Pressable) already
          // times the tonal hover on --dur-fast and the press on --dur-press,
          // and a utility here replaced that list and let the press snap.
          "group/thought relative -mx-2 w-[calc(100%+1rem)] overflow-hidden rounded-field px-2 py-1",
          "motion-reduce:transition-none coarse:min-h-11",
          // One compact line, directly above the answer it describes. The
          // resting row used to be a two-line block at min-h-12 with a 12px
          // margin, which put a 60px hole between the user's turn and the
          // reply on every answer that had a trace.
          streaming ? "min-h-9 gap-3" : "min-h-8 gap-2.5",
          // The gap to the answer belongs to whatever is last. With live blocks
          // below, this row's own margin would open a hole between the label and
          // the trace it labels.
          hasLiveBlocks ? "mb-0.5" : "mb-1.5"
        )}
      >
        {/* aria-hidden: see `label`. The button is named by aria-label; its
            visible content is a clock the tree has no reason to see. */}
        {streaming ? (
          <>
            {/* PLAIN TEXT. This carried AIcss's `.aicss-shine` sweep, a second
                looping thing beside the matrix, moving a valley of alpha
                through a sentence the reader is trying to read. The matrix
                already says "still here"; the sentence's job is to say WHAT.

                At the reply's size and in muted ink, the same as the
                transcript's status line: it was `text-body-lg` in foreground
                ink, a size above the answer and a voice competing with it, so
                the first token shrank the line and changed its colour. Keyed on
                the copy, so a phase change fades in once and a clock tick does
                not. */}
            <span
              key={copyKey}
              aria-hidden="true"
              className={cn(
                "min-w-0 truncate text-reading duration-fast motion-safe:animate-fade-in",
                live.warning ? "text-warning" : "text-muted-foreground"
              )}
            >
              {live.message}
              {!live.warning && liveSources && (
                <span className="whitespace-nowrap tabular-nums"> · {liveSources}</span>
              )}
              {run.elapsedMs !== null && (
                <span className="whitespace-nowrap tabular-nums"> · {formatSpan(run.elapsedMs, { live: true })}</span>
              )}
            </span>
          </>
        ) : (
          <>
            {/* A glyph, not a status dot: it names the kind of work (tools,
                the web, reasoning), and inks up with the row on hover. */}
            <span aria-hidden="true" className="flex w-5 shrink-0 items-center justify-center">
              <RestingIcon className="size-4 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/thought:text-foreground motion-reduce:transition-none" />
            </span>
            {/* One line: the label, then the nouns. "Thought process" only when
                there WAS one — plenty of models emit no reasoning at all, and
                labelling their turn with a thought process invites the reader to
                open a panel that has nothing in it. `hasReasoning` is computed
                above; a run with neither reasoning nor nouns returned early. */}
            <span aria-hidden="true" className="min-w-0 flex-1 truncate text-ui leading-5 text-muted-foreground">
              <span className="font-medium text-foreground/80">{restingTitle}</span>
              {restingDetail && <span> · {restingDetail}</span>}
              {run.note && <span className="text-warning"> · {run.note}</span>}
            </span>
            {run.elapsedMs !== null && <span aria-hidden="true" className="shrink-0 px-1 font-mono text-caption tabular-nums text-muted-foreground">{formatSpan(run.elapsedMs)}</span>}
            {/* Ink only on hover. A caret is a state mark and does not travel
                before it is pressed (ICONS_AND_MOTION.md §1.3). */}
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/thought:text-foreground motion-reduce:transition-none" aria-hidden="true" />
          </>
        )}
      </Pressable>

      {/* LIVE REASONING STAYS OUT OF THE TRANSCRIPT. Summary first, detail on
          demand (Claude Code / Codex): the strip above is the whole live status
          ("Thinking · 4s"), and the full trace opens in ThoughtProcessPanel.
          Streaming `ThinkingReasoning` here used to dump provider reasoning as
          a growing grey wall above the answer; even capped at 180px it made
          the primary timeline look broken and buried the reply. Searches still
          stream because they are a single query line the reader is waiting on,
          not the model's private channel. */}
      {/* What the turn's runs made (lib/chat/tool-run): the chart or the
          workbook, above the answer that talks about it, and the polite
          announcement of each run's phase change. Nothing when no run. */}
      <ToolRunOutputs events={list} streaming={!!streaming} />

      {showSearch && (
        <div aria-hidden="true" className="mb-3 flex flex-col gap-2.5 pl-2">
          <WebSearchBlock
            query={run.query!}
            sites={searchSites}
            // Settled once the run has moved past research: the query stops
            // shimmering the moment the phase it describes is over, not when
            // the whole answer lands.
            settled={!researchActive}
          />
        </div>
      )}

      {/* The portal is the whole trick: the panel stays in THIS React subtree —
          so it keeps receiving the run built from the one clock above — while
          its DOM lands in the dock beside the chat column. */}
      {open && panel.container
        ? createPortal(
            <ThoughtProcessPanel
              id={panelDomId}
              messageId={messageId}
              onClose={() => panel.setOpenId(null)}
              run={run}
              reasoning={reasoning}
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
