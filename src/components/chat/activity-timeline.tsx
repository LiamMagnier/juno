"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { ChevronRight } from "@/components/ui/icons";
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
import { LiveLine, useHeldPhase } from "@/components/chat/live-line";
import { cn, truncate } from "@/lib/utils";
import { receiptLabelForCall } from "@/lib/chat/tool-receipt";
import { activeRunId, runReceiptParts } from "@/lib/chat/tool-run";
import { ToolRunOutputs } from "@/components/chat/tool-run-files";
import type { ClientActivityEvent, ClientAttachment, ClientSource } from "@/types/chat";

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
 * strip communicates the useful contract instead (phase, current action and
 * elapsed time) while the full provider text remains one click away.
 *
 *   live    [Continuum] Searching the web · 4s
 *   rest    Worked 8.4s, searched the web 4 times and read 9 sources  ›
 *
 * IT IS ONE TRIGGER WHOSE TENSE CHANGES, not two controls. The live state is
 * the live line (live-line.tsx) in the present tense; the resting state is one
 * sentence in the past tense, set as type in the third ink, with the caret
 * that opens the dock. There is one formatter (`formatSpan`) and one figure,
 * so the line, the panel and the ledger can never time the run three ways.
 */
export function ActivityTimeline({
  messageId,
  events,
  reasoning,
  reasoningParts,
  sources,
  streaming,
  finishNote,
  attachments,
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
  /** The message's own attachments: run files already among them are drawn
   *  by the message, so the strip leaves them out. */
  attachments?: readonly ClientAttachment[];
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
  // Runs are counted by their own words (the title below), not again as
  // "tool calls": "2 runs · 2 tool calls" says one thing twice.
  const toolCalls = run.calls.filter((c) => !c.warn && !c.run).length;
  // The connectors this run reached, by name, for the resting line. "Run" was
  // the one word the row could say about a turn that used GitHub and Linear,
  // and it named the mechanism rather than what happened.
  const toolServers = [
    ...new Set(list.filter((e) => e.kind === "tool" && e.title.startsWith("Using ")).map((e) => e.title.slice(6).trim())),
  ].filter(Boolean);
  /*
   * THE RESTING LINE IS ONE SENTENCE (INTERACTION_SPEC M4, M5): "Thought for
   * 12s", or "Worked 12s, searched the web and read 3 sources". Typography,
   * not a row: no glyph, no fill, no second column for the clock. The figure
   * is the one formatter's (`formatSpan`), so the line and the panel cannot
   * disagree about how long the run took.
   */
  const span = run.elapsedMs === null ? null : formatSpan(run.elapsedMs);
  const did = [
    runViews.length ? (runViews.length === 1 ? [runReceiptParts(runViews[0]).label, runReceiptParts(runViews[0]).object].filter(Boolean).join(" · ") : `completed ${runViews.length} runs`) : null,
    run.searches ? (run.searches === 1 ? "searched the web" : `searched the web ${run.searches} times`) : null,
    run.sourceCount ? `read ${run.sourceCount} ${run.sourceCount === 1 ? "source" : "sources"}` : null,
    toolServers.length
      ? `used ${toolServers.length > 2 ? `${toolServers.slice(0, 2).join(", ")} and ${toolServers.length - 2} more` : toolServers.join(" and ")}`
      : toolCalls
        ? `made ${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}`
        : null,
  ].filter((part): part is string => !!part);
  const didSentence = did.length > 1 ? `${did.slice(0, -1).join(", ")} and ${did[did.length - 1]}` : did[0] ?? null;
  const lead = did.length
    ? span
      ? `Worked ${span}`
      : "Worked"
    : hasReasoning
      ? span
        ? `Thought for ${span}`
        : "Thought process"
      : null;
  const restingLine = [lead, didSentence].filter(Boolean).join(", ");
  // A settled run with no reasoning, no searches, no sources and no tool calls
  // has nothing to open: the line would invite a reader into an empty panel.
  // ChatGPT and Claude show no trace line for a plain completion, and neither
  // does this. Live runs always render: the live line IS the feedback while
  // the first token is on its way.
  if (!streaming && !restingLine) return null;
  // A phase change asks the mark for one pass. Reasoning-token growth never
  // changes this key, so the collapsed UI stays calm during long streams.
  const copyKey = streaming ? `${active?.key ?? "think"}-${latest?.kind ?? "reasoning"}-${live.message}` : "complete";
  // Only the model reasoning is "thinking"; a search, a read or a tool call is
  // work with a name (MOTION_AND_THINKING.md).
  const livePhase = !latest || latest.kind === "reasoning" || live.message === "Thinking" ? "thinking" : "working";

  // THE ACCESSIBLE NAME IS THE WHOLE CONTROL. The elapsed number alone rewrites
  // once a second, so the visual content is hidden from the tree and the label
  // carries the state instead. It changes once per run, on settle; the live
  // phase itself is announced by the live line's own region, once per phase.
  const label = streaming
    ? "Open thought process, in progress"
    : [hasReasoning ? "Open thought process, complete" : "Open run details, complete", restingLine, run.note]
        .filter(Boolean)
        .join(", ");

  // Live blocks: only the search line still streams under the strip. Reasoning
  // no longer renders here (summary first; the panel owns the full trace).
  const searchSites = streaming ? toSearchSites(run.sources) : [];
  const showSearch = !!streaming && !!run.query;
  const hasLiveBlocks = showSearch;

  return (
    <>
      {streaming && <PhaseAnnouncer text={live.message} />}
      {streaming ? (
        /*
         * LIVE: the live line (live-line.tsx), the same drawing as the reply's
         * own status, so the strip and the line never describe one wait in two
         * voices. It stays a button: the full trace opens in the dock from
         * here at any moment of the run. Plain text, no sweep: the mark is the
         * one thing that moves, and only when a real step arrives.
         */
        <button
          ref={triggerRef}
          type="button"
          onClick={() => panel?.setOpenId(open ? null : messageId)}
          aria-expanded={open}
          aria-controls={open ? panelDomId : undefined}
          aria-label={label}
          className={cn(
            "group/thought -ml-2 flex min-h-8 max-w-[calc(100%+0.5rem)] items-center rounded-md px-2 text-left",
            "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none coarse:min-h-11",
            open && "bg-accent",
            hasLiveBlocks ? "mb-0.5" : "mb-1.5"
          )}
        >
          <LiveLine
            text={live.message}
            phase={live.warning ? "error" : livePhase}
            eventKey={copyKey}
            detail={!live.warning ? liveSources : null}
            seconds={run.elapsedMs === null ? null : Math.floor(run.elapsedMs / 1000)}
            // A region inside a button is read as its name, not announced:
            // the phase is spoken by the announcer beside it instead.
            announce={false}
          />
        </button>
      ) : (
        /*
         * RESTING: one quiet sentence and a caret, set as type in the third
         * ink. It inks up under the pointer and while its panel is open; the
         * caret turns a quarter when the dock is open. Nothing else changes.
         */
        <button
          ref={triggerRef}
          type="button"
          onClick={() => panel?.setOpenId(open ? null : messageId)}
          aria-expanded={open}
          aria-controls={open ? panelDomId : undefined}
          aria-label={label}
          className={cn(
            "group/thought -ml-2 mb-1.5 inline-flex h-7 max-w-[calc(100%+0.5rem)] items-center gap-1 rounded-md pl-2 pr-1.5 text-left text-nav text-muted-foreground",
            "transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none coarse:h-11",
            open && "bg-accent text-foreground"
          )}
        >
          <span aria-hidden="true" className="min-w-0 truncate">
            {restingLine}
            {run.note ? <span className="text-warning">{`. ${run.note}`}</span> : null}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none",
              open && "rotate-90"
            )}
          />
        </button>
      )}

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
      <ToolRunOutputs events={list} streaming={!!streaming} attachments={attachments} />

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

/**
 * The run's phase, spoken politely and at most once every three seconds
 * (INTERACTION_SPEC M5). Separate from the trigger, because a region inside a
 * button is read as the button's name rather than announced, and separate from
 * the clock, which is never spoken.
 */
function PhaseAnnouncer({ text }: { text: string }) {
  const spoken = useHeldPhase(text, 3000);
  return (
    <span className="sr-only" role="status" aria-live="polite" data-no-auto-translate>
      {spoken}
    </span>
  );
}
