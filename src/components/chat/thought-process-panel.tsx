"use client";

import * as React from "react";
import { ChevronRight, X } from "lucide-react";
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
  restingLabel: string;
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

  const restingLabel = ["Thought", searchEvs.length ? plural(searchEvs.length, "search", "searches") : null, sources.length ? plural(sources.length, "source") : null]
    .filter(Boolean)
    .join(" · ");

  return {
    t0,
    phases,
    facts,
    calls,
    sources,
    searches: searchEvs.length,
    sourceCount: sources.length,
    elapsedMs,
    restingLabel,
    note: warnings.length ? warnings[warnings.length - 1].title : null,
  };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
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
 * Reduced motion slows the cadence to 1Hz but never removes the number: a
 * changing number is information, not vestibular motion.
 */
export function useRunClock(events: ClientActivityEvent[], streaming?: boolean) {
  const reduced = usePrefersReducedMotion();
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
    const id = window.setInterval(() => setNow(Date.now()), reduced ? 1000 : 100);
    return () => window.clearInterval(id);
  }, [streaming, reduced]);

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
    <div className="flex items-center gap-3">
      <span className="font-mono text-label uppercase text-muted-foreground/70">{children}</span>
      <span className="h-px flex-1 bg-border/50" aria-hidden="true" />
    </div>
  );
}

/** Shared row geometry. 4.5rem holds "RESEARCH" at caption/0.1em at every width;
 *  the middle truncates; the number is shrink-0 and never truncates. */
const ROW = "grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5";

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

  const meta = [
    run.elapsedMs === null ? null : formatSpan(run.elapsedMs),
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

  return (
    <aside
      id={id}
      ref={rootRef}
      tabIndex={-1}
      aria-label="Thought process"
      className="flex h-full w-full flex-col bg-card focus:outline-none"
    >
        <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-heading text-foreground">Thought process</h2>
            {meta && (
              <p className="mt-1 truncate font-mono text-caption uppercase tracking-[0.12em] text-muted-foreground/70">{meta}</p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-[transform,box-shadow,border-color,color] duration-base ease-out-soft hover:border-border hover:text-foreground hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none coarse:size-10"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close thought process</span>
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto bg-muted/15 px-5 py-5">
          {/* NOTICES — success is not news; failure is. Fixed position at the top
              so the panel's structure never reshuffles between runs. */}
          {warnings.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Notices</SectionLabel>
              <ul className="flex flex-col">
                {warnings.map((c) => (
                  <li key={c.id} className={cn(ROW, "motion-safe:animate-fade-in-up")}>
                    <span className="font-mono text-caption uppercase tracking-[0.1em] text-warning">{c.label}</span>
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
              section is just the disclosure, and its absence is the design (same
              rule PROFILE follows at line ~530). */}
          {hasReasoning && (
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Reasoning</SectionLabel>

              {steps && (
                <ol className="flex flex-col">
                  {steps.map((s, i) => {
                    // Only the LAST step can be in flight, and only while the run
                    // is live. Coral is ACTIVE/SELECTED ONLY — same rule as the
                    // Profile rows.
                    const active = !!streaming && i === steps.length - 1;
                    return (
                      // Keyed by ARRAY POSITION, never by the provider's index or
                      // the title: OpenAI repeats summary_index within one
                      // response (live: [0…14, 13, 14]) and repeats titles too,
                      // so either would collide two steps into one and drop text.
                      <li key={i} className={cn(ROW, "motion-safe:animate-fade-in-up")}>
                        <span
                          className={cn(
                            "font-mono text-caption uppercase tracking-[0.1em] tabular-nums transition-colors duration-slow ease-out-soft motion-reduce:transition-none",
                            active ? "text-primary" : "text-muted-foreground/55"
                          )}
                        >
                          {/* An ordinal, not a duration. Steps have no clock —
                              ActivityTimeline owns the only one. */}
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {/* The model's own title when it wrote one; otherwise its
                            own opening line, truncated for width. Either way the
                            words are the model's — we never compose a label. */}
                        <span className="col-span-2 min-w-0 truncate text-body text-foreground/85">
                          {s.title ?? s.body.split("\n")[0]}
                        </span>
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
                  aria-controls={`${id}-reasoning-full`}
                  className="group flex items-center gap-1.5 self-start rounded-md font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground/70 transition-colors duration-base ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                      rawOpen && "rotate-90"
                    )}
                  />
                  {/* Never "raw". No provider here hands over unedited
                      chain-of-thought: OpenAI sends a summary it wrote, and
                      Anthropic summarises server-side too. Calling this the raw
                      thinking would be a small lie in the one panel that exists
                      not to tell them. */}
                  {rawOpen ? "Hide full thinking" : "Show full thinking"}
                </button>

                {/* Frame/scroller split: the 4px inlay gutter keeps the fade mask off
                    the border, and 2xl(16) − p-1(4) = xl(12) keeps it concentric. */}
                {rawOpen && (
                  <div
                    id={`${id}-reasoning-full`}
                    className="field-well rounded-2xl border border-border/50 bg-background/40 p-1 motion-safe:animate-fade-in"
                  >
                    <div
                      ref={reasoningRef}
                      /* Smaller than it was (text-caption, max-h-[32vh]) because it
                         is no longer the headline — but the serif-italic voice is
                         kept exactly as approved. */
                      className="scroll-fade-y max-h-[32vh] overflow-y-auto whitespace-pre-wrap rounded-xl px-3.5 py-3 font-serif text-caption italic leading-relaxed text-muted-foreground/90"
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
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Sources</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {run.sources.map((s) => (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative inline-flex max-w-full items-center rounded-md border border-border/60 bg-background/70 px-2 py-1 font-mono text-caption text-source shadow-pop transition-[transform,box-shadow,border-color] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none"
                  >
                    <span className="truncate">{s.domain}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* PROFILE — the receipt. Right-aligned durations: scan the right edge
              and the slow phase announces itself. Header total = sum of parts.
              Hidden entirely when no span is derivable, so none is claimed. */}
          {run.phases.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Profile</SectionLabel>

              {showBar && (
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
                  {run.phases.map((p) => (
                    <div
                      key={p.key}
                      /* No floor. A span too short to see gets no segment — its
                         row still carries the exact number. A 2% floor would be
                         the form lying about proportion in the one element that
                         claims to show it.
                         flexGrow is rewritten by the 100ms tick, so it carries NO
                         transition: a 220ms transition against a 100ms value lags
                         and fights it into mush. The cadence alone is continuous.
                         Colour is the only transition, and there is no animate-*
                         on this element (rule 4). */
                      style={{ flexGrow: p.ms ?? 0 }}
                      className={cn(
                        "transition-[background-color] duration-slow ease-out-soft motion-reduce:transition-none",
                        p.active
                          ? "bg-primary"
                          : p.key === "research"
                            ? "bg-source/60"
                            : p.key === "think"
                              ? "bg-muted-foreground/35"
                              : "bg-foreground/45"
                      )}
                    />
                  ))}
                </div>
              )}

              <ol className="flex flex-col">
                {run.phases.map((p) => (
                  <li key={p.key} className={ROW}>
                    <span
                      className={cn(
                        "font-mono text-caption uppercase tracking-[0.1em] transition-colors duration-slow ease-out-soft motion-reduce:transition-none",
                        p.active ? "text-primary" : "text-muted-foreground/70"
                      )}
                    >
                      {p.label}
                    </span>
                    {/* May be empty. An empty cell is honest; filler is not. The
                        row earns its place on its duration alone. */}
                    <span className="min-w-0 truncate text-body text-foreground/85">{p.object}</span>
                    <span className="shrink-0 font-mono text-caption tabular-nums text-foreground/70">
                      {p.ms === null ? "—" : formatSpan(p.ms)}
                    </span>
                  </li>
                ))}
              </ol>

              {tools.length > 0 && (
                <ul className="mt-1 flex flex-col border-t border-border/40 pt-1">
                  {tools.map((c) => (
                    <li key={c.id} className={cn(ROW, "motion-safe:animate-fade-in-up")}>
                      <span className="font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground/70">{c.label}</span>
                      <span className="min-w-0 truncate text-body text-foreground/85">{c.object}</span>
                      {/* "+" marks an offset from T0, not a duration and never a
                          wall clock. Tool calls land at genuinely arbitrary
                          moments, which is the one place a stamp means anything. */}
                      <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/55">
                        {c.offsetMs === null ? "—" : `+${formatSpan(c.offsetMs)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* FACTS — five things that were five rows in a fake timeline wearing
              five coloured circles and a fake wall-clock stamp. They are five
              facts. The missing time column is the whole point. */}
          {run.facts.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <SectionLabel>Facts</SectionLabel>
              <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                {run.facts.map((f) => (
                  <React.Fragment key={f.label}>
                    <dt className="font-mono text-caption uppercase tracking-[0.1em] text-muted-foreground/60">{f.label}</dt>
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
