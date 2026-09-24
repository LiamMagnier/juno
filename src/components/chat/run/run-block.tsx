"use client";

import * as React from "react";

import { ApprovalSlot, hasApprovalSlot, prefetchApprovalCard } from "@/components/chat/run/approval-slot";
import { RunCommentary } from "@/components/chat/run/run-commentary";
import { RunLine, summaryWorkedMs } from "@/components/chat/run/run-line";
import { RunPeek } from "@/components/chat/run/run-peek";
import { RunTimelineInline } from "@/components/chat/run/run-timeline-inline";
import { Collapse } from "@/components/ui/collapse";
import type { ChatMessage } from "@/hooks/use-chat";
import type { LiveMessage } from "@/lib/chat/live-message";
import { useUiLocale } from "@/lib/i18n-format";
import { formatPhrase } from "@/lib/i18n-phrase";
import { RUN_PACING } from "@/lib/motion";
import { reducedMotionAt } from "@/lib/run/loop-phase";
import { createPhasePacer } from "@/lib/run/pacer";
import { derivePhase } from "@/lib/run/phase";
import { RUN_COPY } from "@/lib/run/presentation";
import {
  answerStarted as anyAnswerStarted,
  classifyRounds,
  heldCommentary,
  nextPeekState,
  type PeekState,
} from "@/lib/run/provisional-text";
import { useScrollAnchoredSize } from "@/lib/run/scroll-anchor";
import { announceRun, setLiveAnswer, setRunPhase } from "@/lib/run/store";
import { announcementFor, isWorkingPhase, mustRenderAtRest, wordCount, type RunOutcome } from "@/lib/run/summary";
import { useRunView } from "@/lib/run/timeline";
import type { PacedPhase, PhaseState, RoundVerdict } from "@/lib/run/types";
import type { GenerationStatus } from "@/types/chat";

/*
 * The inline run block above each chat answer, from send to done (SPEC §7.1,
 * DECISIONS U1): the status line, the two-slot peek while live, approval
 * slots, the inline timeline on click, and the commentary region.
 *
 * It owns the run's live choreography and publishes it, so nothing else
 * needs a prop chain: the paced phase and the clock go to the phase store
 * (the line, the Activity panel's header and the announcer read them), and
 * the provisional hold's verdicts plus whether the peek is out of the way go
 * to the live-answer store (the answer body reads them through
 * `liveAnswerText`, so held text never renders as answer and the first
 * answer text renders only after the peek has folded).
 *
 * Height changes it makes on its own — the block appearing, the peek opening
 * once and folding, an approval card and its receipt — go through
 * `scroll-anchor.ts`; opening the timeline is the reader's own click.
 */

/** Where the Activity panel should open: a call to scroll to and expand, or the top. */
export interface PanelFocus {
  callId?: string;
}

export interface RunBlockProps {
  message: ChatMessage;
  /** Identity across the temp → server id swap; keys the phase store. */
  renderKey: string;
  streaming: boolean;
  status: GenerationStatus;
  onOpenPanel(focus?: PanelFocus): void;
}

const QUIET = { stalled: false, calm: false, escalation: 0 as const };
/** The peek's fold, plus a frame: the fallback when `transitionend` never comes. */
const COLLAPSE_FALLBACK_MS = 250;

/** `Date.now()`, refreshed once a second while `active` (and once just after the 400 ms label threshold). */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    const early = setTimeout(() => setNow(Date.now()), RUN_PACING.showDelayMs + 10);
    return () => {
      clearInterval(interval);
      clearTimeout(early);
    };
  }, [active]);
  return now;
}

function outcomeOf(message: ChatMessage): RunOutcome {
  if (message.finishReason === "user_stopped") return "stopped";
  return message.error ? "failed" : "done";
}

/** A signature of what the pacer acts on, so an unchanged phase is not pushed again. */
function phaseSignature(state: PhaseState): string {
  return [state.phase, state.subjectKey, state.stalled, state.calm, state.escalation, state.coalesced, state.stalledSince].join("|");
}

function RunBlockImpl({ message, renderKey, streaming, status: _status, onOpenPanel }: RunBlockProps) {
  const live = message as LiveMessage;
  const locale = useUiLocale();
  const view = useRunView(message);
  const loopId = `run-line:${renderKey}`;
  const timelineId = React.useId();
  const [expanded, setExpanded] = React.useState(false);

  // Whether this tab watched the run live: only then does it pace, hold, announce and animate.
  const [wasLive, setWasLive] = React.useState(streaming);
  if (streaming && !wasLive) setWasLive(true);

  const [clientStart, setClientStart] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (streaming && clientStart === null) setClientStart(Date.now());
  }, [streaming, clientStart]);
  // The last frame other than `ping` (a ping never changes the message).
  const lastEventAt = React.useRef(0);
  React.useEffect(() => {
    lastEventAt.current = Date.now();
  }, [message]);
  const now = useNow(streaming);

  // ── The provisional hold (§7.3) ────────────────────────────────────────────
  const liveRounds = live.liveRounds;
  const tools = view.facts.tools;
  const toolsOffered = tools?.key === "tools" && (tools.offered.length > 0 || tools.nativeSearch);
  const callRoundKey = view.tools.map((item) => item.round).join(",");
  const firstSeen = React.useRef(new Map<number, number>());
  const [verdicts, setVerdicts] = React.useState<Readonly<Record<number, RoundVerdict>>>({});
  const [holdTick, setHoldTick] = React.useState(0);
  React.useEffect(() => {
    if (!liveRounds) return;
    const at = Date.now();
    for (const entry of liveRounds) if (!firstSeen.current.has(entry.round)) firstSeen.current.set(entry.round, at);
    const callRounds = new Set(callRoundKey ? callRoundKey.split(",").map(Number) : []);
    const result = classifyRounds({ rounds: liveRounds, toolsOffered, callRounds, streaming, firstSeenAt: firstSeen.current, now: at, verdicts });
    if (result.verdicts !== verdicts) setVerdicts(result.verdicts);
    if (result.nextCheckAt === null) return;
    const timer = setTimeout(() => setHoldTick((n) => n + 1), Math.max(0, result.nextCheckAt - Date.now()));
    return () => clearTimeout(timer);
  }, [liveRounds, toolsOffered, callRoundKey, streaming, verdicts, holdTick]);
  // Without `liveRounds` (no `timeline`), text arriving is the answer starting.
  const answerStarted = liveRounds ? anyAnswerStarted(verdicts) : message.content.trim().length > 0;

  // ── The peek: opens once, folds at the first answer text (§7.5) ────────────
  const lastRound = liveRounds?.at(-1);
  const liveCommentary =
    streaming && lastRound?.phase === "commentary" ? { round: lastRound.round, text: lastRound.text } : null;
  const hasStep = view.latestStepKeys.length > 0 || liveCommentary !== null;
  const [peek, setPeek] = React.useState<PeekState>("closed");
  const [collapsing, setCollapsing] = React.useState(false);
  const nextPeek = nextPeekState(peek, { streaming, hasStep, answerStarted });
  if (nextPeek !== peek) {
    setPeek(nextPeek);
    if (peek === "open") setCollapsing(true);
  }
  const peekRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!collapsing) return;
    if (reducedMotionAt(peekRef.current)) {
      setCollapsing(false);
      return;
    }
    const timer = setTimeout(() => setCollapsing(false), COLLAPSE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [collapsing]);
  // The held answer text renders once the peek is out of the way (at once if it never opened).
  const revealed = peek !== "open" && !collapsing;
  React.useEffect(() => {
    setLiveAnswer(renderKey, { verdicts, revealed });
  }, [renderKey, verdicts, revealed]);
  React.useEffect(() => () => setLiveAnswer(renderKey, null), [renderKey]);

  // ── The phase, paced (§7.3) ─────────────────────────────────────────────────
  const phaseState = React.useMemo(
    () =>
      derivePhase(view, {
        streaming,
        error: Boolean(live.error),
        finishReason: message.finishReason ?? null,
        answerStarted,
        lastEventAt: lastEventAt.current || clientStart || now,
        now,
        startedAt: clientStart ?? now,
      }),
    [view, streaming, live.error, message.finishReason, answerStarted, clientStart, now],
  );
  const [paced, setPaced] = React.useState<PacedPhase | null>(null);
  const pacer = React.useRef<ReturnType<typeof createPhasePacer> | null>(null);
  React.useEffect(() => {
    if (!wasLive) return;
    const created = createPhasePacer(setPaced);
    pacer.current = created;
    return () => {
      created.dispose();
      pacer.current = null;
    };
  }, [wasLive]);
  const signature = phaseSignature(phaseState);
  const latestPhase = React.useRef(phaseState);
  React.useEffect(() => {
    latestPhase.current = phaseState;
  }, [phaseState]);
  React.useEffect(() => {
    pacer.current?.push(latestPhase.current);
  }, [signature, wasLive]);

  // ── The clock: from the send, held at the answer, resumed by a later tool ──
  const [clock, setClock] = React.useState<{ elapsedMs: number; since: number | null }>({ elapsedMs: 0, since: null });
  const pacedPhase = paced?.phase;
  React.useEffect(() => {
    if (!pacedPhase) return;
    const running = streaming && (isWorkingPhase(pacedPhase) || pacedPhase === "waiting");
    setClock((current) => {
      if (running && current.since === null) {
        return { elapsedMs: current.elapsedMs, since: current.elapsedMs === 0 && clientStart !== null ? clientStart : Date.now() };
      }
      if (!running && current.since !== null) {
        return { elapsedMs: current.elapsedMs + Math.max(0, Date.now() - current.since), since: null };
      }
      return current;
    });
  }, [pacedPhase, streaming, clientStart]);

  // Published for the line, the panel header and the announcer. A block that was never live
  // publishes its settled phase directly: nothing to pace.
  const outcome = outcomeOf(message);
  React.useEffect(() => {
    if (wasLive) {
      if (paced) setRunPhase(renderKey, { ...paced, clock });
      return;
    }
    setRunPhase(renderKey, { phase: outcome, reveal: "label", ...QUIET });
  }, [renderKey, wasLive, paced, clock, outcome]);
  React.useEffect(() => () => setRunPhase(renderKey, null), [renderKey]);

  // ── What the announcer hears (§7.12) ────────────────────────────────────────
  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!wasLive || !paced || paced.reveal !== "label") return;
    const key = `${paced.phase}|${paced.subjectKey ?? ""}`;
    if (announced.current === key) return;
    announced.current = key;
    const opts = { locale, workedMs: summaryWorkedMs({ clock }, view), panelCoversChat: false, words: wordCount(message.content, locale) };
    const text = announcementFor(paced, view, opts);
    if (!text) return;
    const thinking = paced.phase === "thinking" || paced.phase === "queued";
    const ended = paced.phase === "done" || paced.phase === "stopped" || paced.phase === "failed";
    announceRun(renderKey, {
      key: thinking ? `${renderKey}:thinking` : `${renderKey}:${key}`,
      text,
      ...(paced.phase === "waiting" ? { panelText: announcementFor(paced, view, { ...opts, panelCoversChat: true }) ?? text } : {}),
      urgent: paced.phase === "waiting" || ended,
      once: thinking || ended,
    });
    // Only phase boundaries speak; the view and the clock are read as they stand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paced?.phase, paced?.subjectKey, paced?.reveal, wasLive]);
  const stalled = Boolean(paced?.stalled);
  React.useEffect(() => {
    if (!stalled || !streaming) return;
    announceRun(renderKey, { key: `${renderKey}:stalled`, text: formatPhrase(RUN_COPY.announceStillWorking, locale), once: true });
  }, [stalled, streaming, renderKey, locale]);

  // The approval card's code is fetched once the run makes a call, before any card is needed.
  const calls = view.tools.length;
  React.useEffect(() => {
    if (streaming && calls > 0) prefetchApprovalCard();
  }, [streaming, calls]);

  // ── What shows ──────────────────────────────────────────────────────────────
  const rendersAtRest = mustRenderAtRest(view) || outcome !== "done";
  const blockOpen = streaming
    ? (paced?.reveal ?? "none") !== "none" && !(answerStarted && !mustRenderAtRest(view))
    : rendersAtRest;
  const peekOpen = peek === "open" && !expanded;

  const blockRef = React.useRef<HTMLDivElement | null>(null);
  useScrollAnchoredSize(blockRef);
  useScrollAnchoredSize(peekRef);

  const commentary = React.useMemo(() => {
    const recorded = view.items.filter((item) => item.kind === "commentary" && item.inline);
    const rounds = new Set(recorded.map((item) => (item.kind === "commentary" ? item.round : -1)));
    const held = heldCommentary(liveRounds, verdicts).filter((entry) => !rounds.has(entry.round));
    return [
      ...recorded.map((item) => ({ key: item.key, text: item.kind === "commentary" ? item.text : "" })),
      ...held.map((entry) => ({ key: `held:${entry.round}`, text: entry.text })),
    ];
  }, [view.items, liveRounds, verdicts]);

  const approvalsById = React.useMemo(() => new Map((message.approvals ?? []).map((a) => [a.id, a])), [message.approvals]);
  const slots = view.tools.filter(hasApprovalSlot);

  if (!streaming && !wasLive && !rendersAtRest) return null;

  return (
    <div ref={blockRef} className="@container/run -mx-2" data-run-block="" data-scroll-anchor="">
      <div className="run-collapse" data-open={blockOpen ? "true" : "false"}>
        <div className="run-collapse__inner px-2" inert={!blockOpen}>
          <RunLine
            renderKey={renderKey}
            view={view}
            streaming={streaming}
            expanded={expanded}
            onToggle={() => setExpanded((open) => !open)}
            controlsId={timelineId}
            loopId={loopId}
            restPhase={outcome}
          />
          {wasLive ? (
            <div
              ref={peekRef}
              className="run-collapse"
              data-open={peekOpen ? "true" : "false"}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && event.propertyName === "grid-template-rows") setCollapsing(false);
              }}
            >
              <div className="run-collapse__inner" inert={!peekOpen}>
                {peek !== "closed" ? <RunPeek view={view} liveCommentary={liveCommentary} /> : null}
              </div>
            </div>
          ) : null}
          {slots.map((item) => (
            <ApprovalSlot key={item.key} item={item} approval={item.call.approval ? approvalsById.get(item.call.approval.id) : undefined} />
          ))}
          <Collapse open={expanded}>
            <RunTimelineInline id={timelineId} view={view} onOpenPanel={onOpenPanel} className="mb-2" />
          </Collapse>
          {!expanded ? <RunCommentary items={commentary} className="mt-1" /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised, and its view is rebuilt from the activity, the reasoning and the
 * sources only, never `content`: an answer token does not rebuild the run
 * (U5), and only the line re-renders on a phase change (it reads the store).
 */
export const RunBlock = React.memo(RunBlockImpl);
