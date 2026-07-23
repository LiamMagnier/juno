"use client";

import * as React from "react";
import { ChevronRight, X } from "lucide-react";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { cn } from "@/lib/utils";
import { toSteps } from "@/lib/reasoning-parts";
import type { ClientActivityEvent } from "@/types/chat";

/* ─────────────────────────────────────────────────────────────────────────────
 * THE FORM MUST BE INCAPABLE OF LYING.
 *
 * The producer emits its preflight block (context/model/tool/reasoning/search)
 * with zero awaits between the sends, and usage→warning→done likewise. Every
 * event inside each block therefore receives the same Date.now(). A typical run
 * has exactly TWO distinct instants with `write` alone in between — that is
 * guaranteed by the control flow, not an artifact of a fast run.
 *
 * So a rail of ten timestamped rows renders a two-point dataset as though it
 * were a process. The fix is not to restyle the rail; it is to delete the form
 * that lies and split the data by what was actually measured:
 *
 *   - things with a real duration  → PROFILE, which HAS a duration column
 *   - things that took no time     → FACTS,   which has NO time column at all
 *
 * That absence is the design. It becomes structurally impossible to imply that
 * "Selected model" took time, because there is nowhere for that implication to
 * live. It is also forward-compatible: if the producer ever grows a `duration`
 * field, rows migrate from FACTS to PROFILE into a column already built.
 *
 * Wall-clock is gone outright. It was the SERVER's absolute clock answering
 * "what time was it?" — a question nobody asked — from the exact slot where a
 * duration belongs, hiding the only question the panel exists to answer.
 * ───────────────────────────────────────────────────────────────────────────── */

export function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function parseTs(value: string) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** The ms are already in the ISO strings and were merely thrown away by
 *  toLocaleTimeString. Unknown stays unknown — never a guess. */
export function formatSpan(ms: number) {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/* Producer titles we discriminate on. `tool`, `search`, `context` and `reasoning`
 * each cover both a zero-cost preflight send and a real mid-run one; only the
 * title separates them. */
const T_CORPUS = "Research corpus ready";
const T_SEARCHING = "Searching the web";
const T_CONNECTORS = "Connected tools ready";
const T_EFFORT = "Reasoning mode enabled";

type PhaseKey = "research" | "think" | "write";

interface Phase {
  key: PhaseKey;
  label: string;
  object: string;
  ms: number | null;
  active: boolean;
}

interface Fact {
  label: string;
  value: string;
}

interface Call {
  id: string;
  label: string;
  object: string;
  offsetMs: number | null;
  warn: boolean;
}

export interface RunModel {
  t0: number | null;
  phases: Phase[];
  facts: Fact[];
  calls: Call[];
  sources: { url: string; domain: string }[];
  searches: number;
  sourceCount: number;
  elapsedMs: number | null;
  /** Last warning title, surfaced verbatim. We never editorialise it into a
   *  claim like "Stopped early" — several warnings are non-fatal. */
  note: string | null;
}

/**
 * Reclassify every event by what it physically IS, not by its `kind`.
 *
 * Only three genuine spans exist, all derivable from `createdAt` with no
 * backend change:
 *   RESEARCH = corpusReady − search[0]   (the Tavily await; deep research only)
 *   THINK    = (write − t0) − RESEARCH   (time-to-first-token, enclosing all
 *                                         hidden reasoning; research is a real
 *                                         sub-interval of it, so subtracting
 *                                         keeps total = sum of parts)
 *   WRITE    = end − write               (body streaming)
 *
 * `nowServer` is non-null only while streaming, and is the CLIENT clock already
 * corrected into the server's frame (see useRunClock). Passing it in is what
 * lets the running phase be open-ended instead of missing.
 */
export function buildRun(events: ClientActivityEvent[], nowServer: number | null, anchorT0?: number | null): RunModel {
  const streaming = nowServer !== null;
  const at = (e?: ClientActivityEvent) => (e ? parseTs(e.createdAt) : null);

  // Before the first event lands there is no server anchor, so we measure from
  // when this line appeared. That is a client-frame number — but with no events
  // the skew is uncalibrated and therefore zero, so `nowServer` is client-frame
  // too. The two ends always sit in the same frame; we never mix them.
  const t0 = at(events[0]) ?? anchorT0 ?? null;
  const writeEv = events.find((e) => e.kind === "write");
  const usageEv = events.find((e) => e.kind === "usage");
  const modelEv = events.find((e) => e.kind === "model");
  const effortEv = events.find((e) => e.kind === "reasoning" && e.title === T_EFFORT);
  const connectorsEv = events.find((e) => e.kind === "tool" && e.title === T_CONNECTORS);
  const contextEv = events.find((e) => e.kind === "context" && e.title !== T_CORPUS);
  const corpusEv = events.find((e) => e.kind === "context" && e.title === T_CORPUS);
  // Only deep research's per-query sends are real searches. "Preparing web
  // search" is an INTENT, not work — counting it would inflate the noun.
  const searchEvs = events.filter((e) => e.kind === "search" && e.title === T_SEARCHING);

  const tWrite = at(writeEv);
  const tSearch0 = at(searchEvs[0]);
  const tCorpus = at(corpusEv);

  // THE RUN'S TERMINATOR. `usage` is emitted only after the producer's stream
  // loop has exited, so while streaming it has not landed and the run is
  // genuinely open-ended: it ends at NOW, not at whichever event happened to
  // arrive last. This ordering is load-bearing and was got wrong once. Falling
  // back to `events[last]` mid-stream reads the `write` event itself — so WRITE
  // measured write→write = 0.0s for the entire body stream — or, on a run with
  // native search, the last `visit`, which is "time until the last citation
  // appeared" wearing a WRITE label. Both are the form lying.
  //
  // `nowServer` is non-null exactly when streaming, so this chain says: real end
  // if we have one, else now if live, else the last thing we saw (an aborted run
  // that never reported usage).
  const tEnd = at(usageEv) ?? nowServer ?? at(events[events.length - 1]);

  const sources: { url: string; domain: string }[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    sources.push({ url: e.url, domain: domainOf(e.url) });
  }

  const warnings = events.filter((e) => e.kind === "warning");
  const calls: Call[] = events
    .filter((e) => e.kind === "warning" || (e.kind === "tool" && e.title.startsWith("Using ")))
    .map((e) => {
      const ts = at(e);
      return {
        id: e.id,
        label: e.kind === "warning" ? "Warning" : "Tool",
        object:
          e.kind === "warning"
            ? [e.title, e.detail].filter(Boolean).join(" · ")
            : [e.title.slice("Using ".length), e.detail].filter(Boolean).join(" · "),
        offsetMs: ts !== null && t0 !== null && ts >= t0 ? ts - t0 : null,
        warn: e.kind === "warning",
      };
    });

  // ── PHASES ────────────────────────────────────────────────────────────────
  const phases: Phase[] = [];
  const span = (a: number | null, b: number | null) => (a !== null && b !== null && b >= a ? b - a : null);

  // Research is open-ended while its await is still in flight.
  const researchMs = tSearch0 === null ? null : span(tSearch0, tCorpus ?? nowServer);
  const researchRunning = streaming && tSearch0 !== null && tCorpus === null && tWrite === null;
  const writeRunning = streaming && tWrite !== null;
  const thinkRunning = streaming && tWrite === null && !researchRunning;

  if (tSearch0 !== null) {
    phases.push({
      key: "research",
      label: "Research",
      object: [
        searchEvs.length ? plural(searchEvs.length, "search", "searches") : null,
        sources.length ? plural(sources.length, "source") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ms: researchMs,
      active: researchRunning,
    });
  }

  // THINK is time-to-first-token minus the research sub-interval. While
  // streaming with no `write` yet it is open-ended — which is precisely the
  // longest window, and the one a user is most likely to open the panel during.
  // Hiding the profile until first token would make the running phase invisible
  // for the whole of it, so it stays and simply has no end yet.
  const thinkEnd = tWrite ?? tEnd;
  const thinkTotal = span(t0, thinkEnd);
  const thinkMs = thinkTotal === null ? null : Math.max(0, thinkTotal - (researchMs ?? 0));
  if (tWrite !== null || streaming) {
    phases.push({
      key: "think",
      label: "Think",
      object: effortEv?.detail ?? "",
      ms: thinkMs,
      active: thinkRunning,
    });
  }

  const outMatch = usageEv?.detail?.match(/(\d[\d,]*)\s*output/);
  if (tWrite !== null) {
    phases.push({
      key: "write",
      label: "Write",
      object: outMatch ? `${outMatch[1]} tokens` : "",
      ms: span(tWrite, tEnd),
      active: writeRunning,
    });
  }

  // ── FACTS: zero-duration truths, and nowhere for a number to live ─────────
  const facts: Fact[] = [];
  if (modelEv?.detail) facts.push({ label: "Model", value: modelEv.detail });
  if (effortEv?.detail) facts.push({ label: "Effort", value: effortEv.detail.replace(/\s+effort$/i, "") });
  if (contextEv?.detail) facts.push({ label: "Context", value: contextEv.detail });
  if (connectorsEv?.detail) facts.push({ label: "Tools", value: connectorsEv.detail });
  if (usageEv?.detail) facts.push({ label: "Cost", value: usageEv.detail });

  // One end for the header and for the last phase, so "total = sum of parts" is
  // arithmetic rather than aspiration.
  const elapsedMs = span(t0, tEnd);

  return {
    t0,
    phases,
    facts,
    calls,
    sources,
    searches: searchEvs.length,
    sourceCount: sources.length,
    elapsedMs,
    note: warnings.length ? warnings[warnings.length - 1].title : null,
  };
}

/**
 * THE TICK — the one live signal, and the number the whole design stakes its
 * credibility on. It replaces the ring, the breathe and the shimmer combined,
 * and unlike all three it is different at every instant because it is measuring
 * something.
 *
 * CLOCK FRAME (load-bearing): `createdAt` is minted on the SERVER; Date.now()
 * is the browser's. Subtracting one from the other measures skew as much as
 * elapsed time — on a skewed machine the headline reads wrong, or negative. So
 * we capture the offset ONCE, from the first event we see while live, and tick
 * in the server's frame thereafter. Every span buildRun derives is server−server
 * and needs no correction; only this tick crosses the boundary.
 *
 * CALIBRATE ONCE, AT THE TOP, AND NEVER GATE IT. `skew` is captured on the first
 * render where `streaming` is true, so it is only skew if that render is also
 * when the first event arrived. Hand this hook a gate that turns on LATER — say
 * `streaming && open` — and it silently absorbs the run's entire age into skew:
 * `nowServer` collapses to exactly t0 and the clock restarts from 0.0s. That is
 * why there is exactly ONE caller (ActivityTimeline, which mounts with the run)
 * and why the panel is handed the finished RunModel instead of building its own.
 * A second instance is not a second opinion; it is a second, wrong answer.
 *
 * The visible clock is whole seconds, so it ticks at 1Hz. Reduced motion never
 * removes the number: a changing number is information, not vestibular motion.
 */
export function useRunClock(events: ClientActivityEvent[], streaming?: boolean) {
  const mountRef = React.useRef(Date.now());
  const skewRef = React.useRef<number | null>(null);
  const firstIso = events[0]?.createdAt;

  // Only ever calibrate against a live run. A persisted message's first event is
  // hours old; that difference is history, not skew — and resting runs are
  // measured server−server anyway, so they never consult this.
  if (streaming && skewRef.current === null && firstIso) {
    const t = parseTs(firstIso);
    if (t !== null) skewRef.current = Date.now() - t;
  }

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  // Zero-event runs (reasoning only) have no server anchor, so skew stays 0 and
  // both ends of the measurement sit in the client's own frame. Consistent
  // either way — we never mix frames.
  return {
    nowServer: streaming ? now - (skewRef.current ?? 0) : null,
    /** Synthetic T0 for the window before the first event lands. */
    anchorT0: mountRef.current,
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] font-medium text-muted-foreground/65">{children}</span>
  );
}

/** Shared receipt geometry. The label stays scannable while the value owns the
 *  flexible measure and the time remains right-aligned. */
const ROW = "grid grid-cols-[4rem_minmax(0,1fr)_auto] items-baseline gap-3 py-2";

/**
 * DOCKED, NOT OVERLAID. This was a Radix <Sheet> — a modal dialog with a
 * backdrop that dimmed the chat, trapped focus and locked scroll. The chat is
 * the thing the user is reading; the panel is an annotation on it, so the panel
 * now takes a column and the chat narrows beside it, exactly like CanvasPanel.
 *
 * Everything the Sheet gave us that we still want is re-supplied deliberately
 * and nothing else: an accessible name, focus moved in on open, Esc-to-close
 * (owned by chat-view, which owns the open state), and a visible close control.
 * The behaviours we shed — backdrop, dimming, focus trap, scroll lock,
 * inert-ing the page — are shed on purpose: the chat MUST stay readable,
 * scrollable and typeable while this is open.
 *
 * The panel mounts only while open, so there is no `open` prop to thread.
 */
export function ThoughtProcessPanel({
  id,
  onClose,
  run,
  reasoning,
  reasoningParts,
  streaming,
}: {
  /** DOM id, so the trigger's aria-controls points at something real. */
  id: string;
  onClose: () => void;
  /** Built ONCE by the caller, from the caller's clock. The panel deliberately
   *  owns no clock: the collapsed row and the panel opened from it must be
   *  incapable of disagreeing, and the only way to guarantee that is for there
   *  to be one number, not two agreeing ones. See useRunClock. */
  run: RunModel;
  reasoning?: string | null;
  /** The provider's OWN discrete summary parts, or absent when it sent none.
   *  Absence is a fact carried from the wire, never a gap to fill in. */
  reasoningParts?: string[] | null;
  streaming?: boolean;
}) {
  const hasReasoning = !!reasoning?.trim();
  const reasoningRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLElement>(null);
  // COLLAPSED BY DEFAULT. The prose was the loudest thing in the panel; it is
  // evidence, not the headline. It stays mounted-on-demand: when closed the
  // scroller is unmounted, which the autoscroll effect below already tolerates.
  const [rawOpen, setRawOpen] = React.useState(false);

  /**
   * STEPS — the model's own words, or nothing.
   *
   * `toSteps` returns null unless the provider actually delivered parts, so
   * this is null for Anthropic, Zhipu, Mistral, Google and for every message
   * persisted before parts were carried. Those runs render the disclosure
   * alone. Nothing here inspects `reasoning` to look for structure: the only
   * boundaries that exist are the ones the provider sent.
   */
  const steps = React.useMemo(() => toSteps(reasoningParts), [reasoningParts]);

  // Focus moves in on open — the user pressed a control to get here, so the
  // caret follows. Nothing holds it: Tab leaves the panel normally, and
  // ActivityTimeline hands focus back to the trigger on close. preventScroll
  // stops the dock stealing the chat's scroll position on the way in.
  React.useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Keep the live thinking pinned to the latest token while it streams.
  //
  // The null check is now load-bearing rather than defensive: while collapsed
  // the scroller is UNMOUNTED, so this no-ops for the whole time the disclosure
  // is shut. `rawOpen` is in the deps because opening mid-stream must pin to the
  // tail immediately — without it the effect would not run again until the next
  // delta, and a paused stream would open scrolled to the top.
  React.useEffect(() => {
    if (streaming && reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [reasoning, streaming, rawOpen]);

  // Soft edge on the newest reasoning text so the stream reads as live. The
  // boundary sits on whitespace so the dimmed tail never splits a word; on
  // settle the tail span transitions to full opacity instead of snapping.
  const tailFrom = React.useMemo(() => {
    const text = reasoning ?? "";
    const window = 140;
    if (text.length <= window) return 0;
    const cut = text.length - window;
    const newline = text.lastIndexOf("\n");
    if (newline >= cut) return newline + 1;
    const space = text.indexOf(" ", cut);
    return space === -1 ? cut : space + 1;
  }, [reasoning]);

  const scopeMeta = [
    run.searches ? plural(run.searches, "search", "searches") : null,
    run.sourceCount ? plural(run.sourceCount, "source") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const warnings = run.calls.filter((c) => c.warn);
  const tools = run.calls.filter((c) => !c.warn);
  const totalMs = run.phases.reduce((sum, p) => sum + (p.ms ?? 0), 0);
  // A one-segment bar is a rectangle carrying zero bits — the exact ornament
  // this redesign exists to delete. It appears only once it encodes a real
  // proportion between at least two measured spans.
  const showBar = run.phases.length >= 2 && totalMs > 0;
  const activePhase = run.phases.find((phase) => phase.active);
  const thinkMs = run.elapsedMs ?? 0;
  const overviewTitle = streaming
    ? activePhase?.key === "research"
      ? "Finding and checking sources"
      : activePhase?.key === "write"
        ? "Writing the response"
        : thinkMs >= 10 * 60_000
          ? "Still thinking deeply — safe to leave and come back"
          : thinkMs >= 2 * 60_000
            ? "Still thinking — working in the background"
            : "Thinking about your request"
    : "Response complete";
  const overviewLabel = streaming
    ? activePhase?.key === "research"
      ? "Researching"
      : activePhase?.key === "write"
        ? "Writing"
        : "Thinking"
    : "Complete";

  return (
    <aside
      id={id}
      ref={rootRef}
      tabIndex={-1}
      aria-label="Thought process"
      className="flex h-full w-full flex-col bg-card focus:outline-none"
    >
        <header className="flex shrink-0 items-center gap-4 border-b border-border/55 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {streaming && <ThinkingDots className="origin-left scale-75 text-muted-foreground/55" />}
              <span className={cn("font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em]", streaming ? "text-muted-foreground/80" : "text-muted-foreground/60")}>{streaming ? "Live process" : "Run summary"}</span>
            </div>
            <h2 className="mt-0.5 truncate font-serif text-heading text-foreground">Thought process</h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base ease-out-soft hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none coarse:size-11"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close thought process</span>
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-7 overflow-y-auto bg-muted/10 px-5 py-5">
          {/* RUN OVERVIEW — the answer to "what is it doing?" lives at the top,
              where a live process belongs. Durations remain measurements; the
              step rail only connects phases that actually exist in the data. */}
          <section aria-label="Run progress" className="rounded-2xl border border-border/55 bg-background/55 p-4 shadow-soft">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em] text-muted-foreground/65">{overviewLabel}</span>
                <p key={overviewTitle} className={cn("mt-0.5 truncate font-serif text-heading text-foreground/90 motion-safe:animate-fade-in", streaming && "motion-safe:animate-status-glow")}>{overviewTitle}</p>
                {scopeMeta && <p className="mt-1 font-mono text-caption text-muted-foreground/65">{scopeMeta}</p>}
              </div>
              {run.elapsedMs !== null && (
                <span className={cn("shrink-0 rounded-full px-2.5 py-1 font-mono text-caption tabular-nums", streaming ? "bg-primary/8 text-primary" : "bg-muted text-muted-foreground")}>{formatSpan(run.elapsedMs)}</span>
              )}
            </div>

            {showBar && (
              <div className="mt-4 flex h-1 w-full overflow-hidden rounded-full bg-muted/60" aria-hidden="true">
                {run.phases.map((phase) => (
                  <span
                    key={phase.key}
                    style={{ flexGrow: phase.ms ?? 0 }}
                    className={cn(
                      "transition-colors duration-slow ease-out-soft motion-reduce:transition-none",
                      phase.active
                        ? "bg-primary"
                        : phase.key === "research"
                          ? "bg-source/55"
                          : phase.key === "think"
                            ? "bg-muted-foreground/35"
                            : "bg-foreground/45"
                    )}
                  />
                ))}
              </div>
            )}

            {run.phases.length > 0 && (
              <ol className="mt-3">
                {run.phases.map((phase, index) => (
                  <li key={phase.key} className="relative grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-3 py-2 motion-safe:animate-fade-in">
                    {index < run.phases.length - 1 && <span aria-hidden="true" className="absolute bottom-[-0.5rem] left-[0.21875rem] top-[1.15rem] w-px bg-border/75" />}
                    <span aria-hidden="true" className="relative mt-[0.3rem] flex h-2 w-2 items-center justify-center rounded-full">
                      <span className={cn("h-2 w-2 rounded-full transition-[background-color,box-shadow] duration-slow ease-out-soft motion-reduce:transition-none", phase.active ? "bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.10)]" : "bg-muted-foreground/35")} />
                    </span>
                    <span className="min-w-0">
                      <span className={cn("block font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em]", phase.active ? "text-primary" : "text-muted-foreground/70")}>{phase.label}</span>
                      {phase.object && <span className="mt-0.5 block truncate text-body leading-5 text-foreground/72">{phase.object}</span>}
                    </span>
                    <span className="font-mono text-caption tabular-nums text-muted-foreground/70">{phase.ms === null ? "—" : formatSpan(phase.ms)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* NOTICES — success is not news; failure is. Fixed position at the top
              so the panel's structure never reshuffles between runs. */}
          {warnings.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Notices</SectionLabel>
              <ul className="flex flex-col rounded-xl border border-warning/20 bg-warning/5 px-3">
                {warnings.map((c) => (
                  <li key={c.id} className={cn(ROW, "motion-safe:animate-fade-in-up")}>
                    <span className="font-mono text-caption text-warning">{c.label}</span>
                    <span className="min-w-0 break-words text-body text-warning">{c.object}</span>
                    <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/55">
                      {c.offsetMs === null ? "—" : `+${formatSpan(c.offsetMs)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* REASONING — steps lead, prose is the evidence behind them.
              The question that made the user open the panel is "what did it
              do?", and a wall of streaming prose answers it worse than the
              model's own titles do. So the titles are the headline and the full
              text moved behind a disclosure.

              The steps are NOT a summary we wrote. They are the parts the
              provider emitted, in order, verbatim — which is why they appear for
              OpenAI's Responses models and for nobody else. When no provider
              parts exist there is no Steps list and no placeholder for one: the
              section is just the disclosure, and its absence is the design. */}
          {hasReasoning && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Reasoning</SectionLabel>

              {steps && (
                <ol className="flex flex-col rounded-2xl border border-border/45 bg-card/65 px-3.5 py-2.5">
                  {steps.map((s, i) => {
                    // Only the LAST step can be in flight, and only while the run
                    // is live. Coral is ACTIVE/SELECTED ONLY — the same rule as
                    // the run overview.
                    const active = !!streaming && i === steps.length - 1;
                    return (
                      // Keyed by ARRAY POSITION, never by the provider's index or
                      // the title: OpenAI repeats summary_index within one
                      // response (live: [0…14, 13, 14]) and repeats titles too,
                      // so either would collide two steps into one and drop text.
                      <li key={i} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-2.5 motion-safe:animate-fade-in">
                        {i < steps.length - 1 && <span aria-hidden="true" className="absolute bottom-[-0.65rem] left-[0.71875rem] top-[2rem] w-px bg-border/65" />}
                        <span className={cn("relative z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-background font-mono text-[9px] tabular-nums transition-[border-color,color,box-shadow] duration-slow ease-out-soft motion-reduce:transition-none", active ? "border-primary/45 text-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.08)]" : "border-border/70 text-muted-foreground/60")}>{String(i + 1).padStart(2, "0")}</span>
                        <span className="min-w-0 self-center truncate text-body text-foreground/82">{s.title ?? s.body.split("\n")[0]}</span>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => setRawOpen((v) => !v)}
                  aria-expanded={rawOpen}
                  aria-controls={rawOpen ? `${id}-reasoning-full` : undefined}
                  className="group flex min-h-11 w-full items-center gap-3 rounded-xl border border-border/45 bg-card/60 px-3 text-left transition-[background-color,border-color] duration-base ease-out-soft hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body leading-5 text-foreground/82">Full thinking</span>
                    <span className="block font-mono text-[9px] text-muted-foreground/55">Model-provided reasoning</span>
                  </span>
                  <ChevronRight aria-hidden="true" className={cn("size-3.5 text-muted-foreground/55 transition-transform duration-base ease-out-soft motion-reduce:transition-none", rawOpen && "rotate-90")} />
                </button>

                {/* Frame/scroller split: the 4px inlay gutter keeps the fade mask off
                    the border, and 2xl(16) − p-1(4) = xl(12) keeps it concentric. */}
                {rawOpen && (
                  <div
                    id={`${id}-reasoning-full`}
                    className="rounded-2xl border border-border/50 bg-background/55 p-1 duration-base ease-out-soft motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1"
                  >
                    <div
                      ref={reasoningRef}
                      className="max-h-[42vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl px-3.5 py-3 font-serif text-[0.875rem] leading-6 text-foreground/72"
                    >
                      {reasoning!.slice(0, tailFrom)}
                      <span
                        className={cn(
                          "transition-opacity duration-slow ease-out-soft motion-reduce:transition-none",
                          streaming ? "opacity-60" : "opacity-100"
                        )}
                      >
                        {reasoning!.slice(tailFrom)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* SOURCES — the durable asset. Survives the stream, addressable,
              auditable. No Globe glyph: "nytimes.com" already says it is a site. */}
          {run.sources.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Sources</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {run.sources.map((s) => (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative inline-flex min-h-8 max-w-full items-center rounded-full border border-border/60 bg-card/70 px-2.5 py-1 font-mono text-caption text-source transition-[background-color,border-color] duration-base ease-out-soft hover:border-source/30 hover:bg-source/5 motion-reduce:transition-none"
                  >
                    <span className="truncate">{s.domain}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {tools.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Tools</SectionLabel>
              <ul className="flex flex-col rounded-xl border border-border/45 bg-card/60 px-3">
                {tools.map((call) => (
                  <li key={call.id} className={cn(ROW, "motion-safe:animate-fade-in")}>
                    <span className="font-mono text-caption text-muted-foreground/65">{call.label}</span>
                    <span className="min-w-0 truncate text-body text-foreground/80">{call.object}</span>
                    <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/55">{call.offsetMs === null ? "—" : `+${formatSpan(call.offsetMs)}`}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* RUN DETAILS — configuration and usage are facts, not phases. The
              missing time column is the whole point. */}
          {run.facts.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Run details</SectionLabel>
              <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-border/45 bg-card/60 px-3 py-3">
                {run.facts.map((f) => (
                  <React.Fragment key={f.label}>
                    <dt className="font-mono text-caption text-muted-foreground/60">{f.label}</dt>
                    <dd className="min-w-0 break-words text-body text-foreground/80">{f.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          )}
        </div>
    </aside>
  );
}
