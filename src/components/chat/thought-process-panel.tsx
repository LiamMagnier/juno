"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { AicssCodeBlock } from "@/components/aicss/code-block";
import { ThinkingReasoning } from "@/components/aicss/thinking-reasoning";
import { ThinkingState } from "@/components/aicss/thinking-state";
import type { WebSearchSite } from "@/components/aicss/web-search";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import {
  TOOLS_DESCRIPTION,
  TOOLS_NO_DETAIL_NOTE,
  formatSpan,
  splitCost,
  toRunMarkdown,
  toSourcesMarkdown,
  toolArgsLabel,
  toolArgsNoteText,
  toolResultLabel,
  toolResultNoteText,
} from "@/lib/run-receipt";
import { toReasoningLines } from "@/lib/reasoning-lines";
import { toSteps } from "@/lib/reasoning-parts";
import type { ClientActivityEvent, ClientToolDetail } from "@/types/chat";

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
 *   - things with a real duration  → PHASES, which HAVE a figure column
 *   - things that took no time     → FACTS,  which have NO figure column at all
 *
 * That absence is the design. It becomes structurally impossible to imply that
 * "Selected model" took time, because there is nowhere for that implication to
 * live. It is also forward-compatible: if the producer ever grows a `duration`
 * field, rows migrate from FACTS to PHASES into a column already built.
 *
 * THAT DAY CAME, for exactly one row type. A connector call now carries
 * `tool.durationMs`, measured in mcp.ts around the await on `client.callTool`,
 * and a call that reached the network renders as a PHASE. A call that never
 * reached it — unknown tool, unavailable connector, refused action — has no
 * duration at all and stays a FACT. Both shapes sit in the same list, and the
 * difference between them is a difference in what was measured, not in styling.
 *
 * THE SPLIT IS NOW CARRIED BY THE MARKUP ITSELF. Every list in this panel is one
 * `<dl>` on the same three-column `LEDGER` grid: label · detail · FIGURE. A
 * MEASURED row fills all three columns. A STATED row's `<dd>` spans `2/-1`, so
 * it does not leave an empty figure cell — it HAS no figure cell, in the DOM and
 * in the accessibility tree alike. Putting a duration beside "Selected model"
 * now requires changing that row's grammar, which is exactly the amount of
 * friction the claim deserves. Assistive tech hears what the eye sees: no time
 * for facts.
 *
 * Wall-clock is gone outright, and stays gone for a second reason discovered
 * since. `t0` is `at(events[0]) ?? anchorT0`, and `anchorT0` is the moment
 * ActivityTimeline MOUNTED. For a reasoning-only message, or any persisted
 * message re-rendered on page load, a "Started 14:32:07" footer would print the
 * time the reader opened the page dressed as the time the run began — a flat
 * falsehood with a timestamp on it. `t0` is an internal origin. It is never
 * rendered.
 *
 * AND THERE IS NO BAR. Not a progress bar, not a segmented proportion bar, not a
 * hairline rule under a figure, with or without a track. A proportional graphic
 * whose only content is `ms / max(ms)` says nothing the two adjacent numbers do
 * not already say legibly, in a column built for numbers; its only real function
 * is to make the block LOOK measured, which is the placebic-explanation failure
 * mode this panel exists to avoid.
 * ───────────────────────────────────────────────────────────────────────────── */

export function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The AIcss search row's bare display form: host + path, no scheme. */
function searchLabelOf(url: string) {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, "")}${pathname === "/" ? "" : pathname}`;
  } catch {
    return url;
  }
}

/**
 * A run's sources as AIcss search rows — for the LIVE STRIP only.
 *
 * The resting panel renders its own source rows (see SOURCES below) because
 * `WebSearchBlock` re-derives host+path from the URL when `sources[].domain` is
 * already on the model, and because its row lets a long title push the row wider
 * than the dock. Mid-stream, in the transcript, it remains the right renderer
 * and is untouched.
 *
 * EVERY ROW IS `done`, and that is a statement about the data rather than a
 * shortcut. A `visit` event is emitted at the moment a source has been collected
 * or read (see the sends in route.ts and deep-research.ts) — there is no event
 * for "about to fetch this URL", because until the search returns the URL is not
 * yet known. A pending or fetching row here would therefore be a state this app
 * cannot observe, drawn in the shape that says it did. The in-flight state lives
 * where the run genuinely has one: on the label, which shimmers until the search
 * phase it names is over.
 *
 * `pending` and `loading` stay in the component for the callers that can honestly
 * use them — the Code transcript's own search tool reports per-source progress.
 */
export function toSearchSites(sources: RunModel["sources"]): WebSearchSite[] {
  return sources.map((source) => ({
    title: source.title,
    label: searchLabelOf(source.url),
    url: source.url,
    state: "done" as const,
  }));
}

function parseTs(value: string) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/* The one span formatter. It lives in run-receipt.ts — a module with no React in
 * it and no runtime import back into this one — because the copy-run receipt
 * needs it too, and a second duration formatter is precisely the bug that had
 * the strip printing `2s` beside this panel's `2.7s` for the same run. Re-
 * exported here because this is where every caller already looks for it. */
export { formatSpan } from "@/lib/run-receipt";

/**
 * The same duration, SPOKEN.
 *
 * `formatSpan` produces a glyph — `2.7s`, `1m 4s` — which a screen reader either
 * spells out or mangles depending on the engine. The announcer is the one place
 * where the value has to be a sentence, so it gets its own formatter rather than
 * making `formatSpan` serve two audiences and satisfy neither. Same rounding
 * ladder, so the two never disagree about the number itself.
 */
function speakSpan(ms: number) {
  const s = ms / 1000;
  if (s < 60) {
    const value = s < 10 ? s.toFixed(1) : String(Math.round(s));
    return `${value} ${value === "1" ? "second" : "seconds"}`;
  }
  const minutes = Math.floor(s / 60);
  const seconds = Math.round(s % 60);
  const head = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return seconds ? `${head} ${seconds} ${seconds === 1 ? "second" : "seconds"}` : head;
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
  /**
   * Offset from `t0`, carried but DELIBERATELY NOT RENDERED.
   *
   * It is real for a mid-stream `Using X` (route.ts:598) and structurally `0`
   * for every preflight one (route.ts:519) — honest for some rows in a column
   * and degenerate for others, which reads worse than either alone. Superseded,
   * not joined, by `tool.durationMs`: see the TOOLS section below.
   */
  offsetMs: number | null;
  warn: boolean;
  /**
   * What the model asked the connector for and what came back — server-
   * produced, already redacted, already truncated, already budgeted.
   *
   * Present only on a row that stands for one real connector call. It is absent
   * on every message persisted before this shipped and on every run made with
   * tool detail turned off, which is exactly what makes replay degrade to the
   * old name-only row with no version check anywhere: the row still renders,
   * it just does not open. See TOOLS_NO_DETAIL_NOTE, which says so on screen
   * rather than leaving a non-opening row to read as a broken control.
   */
  tool?: ClientToolDetail;
}

/**
 * Whether the run READ a page or merely LISTED it — and the third state, which
 * is the one that matters.
 *
 * `"unknown"` is not a placeholder. The native-search path emits `Visited
 * source` for pages it added as citations and says nothing about depth, so for
 * those rows this app genuinely does not know, and a panel that printed
 * "listed" over them would be inventing the distinction it is trying to report.
 * Only `"listed"` is ever marked on screen; `read` and `unknown` both render
 * bare, which is the same "mark the exception, not the rule" the NOTICE section
 * uses.
 *
 * `Reading source` is deep-research's title TODAY (deep-research.ts:345) and
 * `Read source` / `Listed source` are the pair design §3.1 asks that file to
 * emit once it stops skipping the pages it collected but did not read. Both
 * spellings are accepted so the panel is already correct on the day it changes;
 * until then no row is ever marked, which is the truthful rendering of a
 * producer that cannot yet tell the two apart.
 */
export type SourceAccess = "read" | "listed" | "unknown";

function sourceAccessOf(title: string): SourceAccess {
  if (title === "Listed source") return "listed";
  if (title === "Read source" || title === "Reading source") return "read";
  return "unknown";
}

export interface RunModel {
  t0: number | null;
  phases: Phase[];
  facts: Fact[];
  memoryReceipt: NonNullable<ClientActivityEvent["memoryReceipt"]>;
  calls: Call[];
  /** `title` is the producer's own `detail` for the visit — the page title, or
   *  the host when the page had none (see the `visit` sends in route.ts and
   *  deep-research.ts). Never invented: it falls back to the domain, which is
   *  what the AIcss search row would have shown anyway. */
  sources: { url: string; domain: string; title: string; access: SourceAccess }[];
  searches: number;
  sourceCount: number;
  /** The last query the run actually searched for, verbatim, or null when it
   *  never ran a search. `T_SEARCHING` only — "Preparing web search" is an
   *  intent and carries no query. */
  query: string | null;
  elapsedMs: number | null;
  /** Last warning title, surfaced verbatim. We never editorialise it into a
   *  claim like "Stopped early" — several warnings are non-fatal. */
  note: string | null;
}

/** What the live strip is currently saying. Computed ONCE, by the caller that
 *  owns the events, and handed to the panel — see the `live` prop. */
export interface LiveCopy {
  message: string;
  warning: boolean;
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
  //
  // NOTE the second consequence, which is why nothing renders `t0` as a time of
  // day: on a persisted message this is the mount instant of the row, not the
  // instant the run began. It is an ORIGIN for subtraction and nothing else.
  const t0 = at(events[0]) ?? anchorT0 ?? null;
  const writeEv = events.find((e) => e.kind === "write");
  const usageEv = events.find((e) => e.kind === "usage");
  const modelEv = events.find((e) => e.kind === "model");
  const effortEv = events.find((e) => e.kind === "reasoning" && e.title === T_EFFORT);
  const connectorsEv = events.find((e) => e.kind === "tool" && e.title === T_CONNECTORS);
  const contextEv = events.find((e) => e.kind === "context" && e.title !== T_CORPUS);
  const memoryEv = events.find((e) => e.kind === "context" && e.title === "Remembered about you");
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

  // EVERY page the run reported, in emission order, with no cap and no sample.
  // The only thing dropped is a repeat of a URL already listed, because the same
  // page arriving twice is one page. Whether the list is COMPLETE is a property
  // of the producer, not of this loop: see SourceAccess.
  const sources: RunModel["sources"] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    const domain = domainOf(e.url);
    // The producer already truncated `detail` to 96 and already fell back to the
    // host when the page had no title, so there is nothing left to decide here.
    sources.push({ url: e.url, domain, title: e.detail?.trim() || domain, access: sourceAccessOf(e.title) });
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
        // Carried through untouched — no parsing, no re-formatting, no
        // re-measuring. The server already redacted, pretty-printed, cut and
        // budgeted it, and a second opinion formed here could only disagree
        // with the one the label is describing.
        ...(e.kind === "tool" && e.tool ? { tool: e.tool } : {}),
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
  // Hiding the phases until first token would make the running phase invisible
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
    memoryReceipt: memoryEv?.memoryReceipt ?? [],
    calls,
    sources,
    searches: searchEvs.length,
    sourceCount: sources.length,
    query: searchEvs[searchEvs.length - 1]?.detail?.trim() || null,
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

/* ─────────────────────────────────────────────────────────────────────────────
 * ONE GRID GRAMMAR FOR THE WHOLE PANEL.
 *
 * col 1 = label · col 2 = detail · col 3 = FIGURE.
 *
 * A MEASURED row fills all three. A STATED row's <dd> spans 2/-1, so it does not
 * leave an empty figure cell — it HAS no figure cell. That absence is the
 * PHASES/FACTS split expressed as markup: it is structurally impossible to put a
 * duration next to "Selected model" without changing the row's grammar.
 * ───────────────────────────────────────────────────────────────────────────── */
const LEDGER = "grid grid-cols-[5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2";
const FIG_TOTAL = "font-mono text-[1.375rem] leading-none tracking-[-0.01em] tabular-nums text-foreground";
const FIG = "font-mono text-[0.8125rem] leading-5 tabular-nums text-foreground/70";

/* Sections are separated by a rule and vertical space — no cards, no shadows, no
 * nested backgrounds. The rule is a SEPARATOR, so it is drawn BETWEEN sections
 * and never above the first one: the header already ends in a border, and two
 * hairlines 16px apart at the top of a column read as a mistake rather than as
 * structure. `SECTION_FIRST` is that first-section case. */
const SECTION = "mt-5 border-t border-border/60 pt-5";
const SECTION_FIRST = "";

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="font-mono text-label uppercase text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * THE READING COLUMN — the one renderer for model-generated prose.
 *
 * Splits on the MODEL'S OWN blank lines and nothing else. `toReasoningLines` is
 * deliberately not used here: its `WRAP_AT = 170` is a display chunker for the
 * AIcss 40px slots, and at rest it would insert paragraph breaks the model never
 * wrote — structure invented by a layout constant.
 *
 * No clamp, no ellipsis, no max-height, no inner scroller. The old panel routed
 * this text through `.aicss-tr-sentence` (height 40px, -webkit-line-clamp 2),
 * which truncated every paragraph mid-sentence: correct for a live trace that
 * must not reflow the transcript, wrong in a panel opened specifically to READ.
 * The panel's own scroller bounds this; a scrollbar inside a scrollbar is the
 * thing edge fades are usually papering over.
 *
 * `content-visibility` because a deep-research trace can run to thousands of
 * words and the browser should not lay out what is not on screen.
 */
function Prose({ text, className }: { text: string; className?: string }) {
  const paras = React.useMemo(
    () =>
      text
        .trim()
        .split(/\n\s*\n+/)
        .map((p) => p.trim())
        .filter(Boolean),
    [text],
  );
  return (
    <div className={cn("space-y-3", className)}>
      {paras.map((p, i) => (
        // Keyed by position: a trace can and does repeat a paragraph verbatim.
        <p
          key={i}
          style={{ contentVisibility: "auto", containIntrinsicSize: "0 96px" }}
          className="whitespace-pre-wrap break-words font-serif text-[0.9375rem] leading-[1.72] text-foreground/80"
        >
          {p}
        </p>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * SUMMARY OR FULL — a choice, and only where there is genuinely one to make.
 *
 * The panel used to answer this for the reader in two places at once: the steps
 * list showed the provider's part TITLES and silently discarded their bodies,
 * while the prose behind "Full thinking" was the flat trace with the structure
 * flattened out of it. So the summary was never readable as a summary — it was
 * a table of contents — and the only way to read what the model actually said
 * at a step was to open the wall of text and find it again by eye.
 *
 * Both halves already exist in the data. `reasoning-parts.ts` keeps the
 * provider's own parts verbatim alongside the flat text, and a part carries a
 * title and a body. This turns that into the two views it always was.
 *
 * WHERE THERE IS NO CHOICE, THERE IS NO CONTROL. `toSteps` returns null for
 * every provider that streamed unbroken prose — Anthropic, Zhipu, Mistral,
 * Google — and for every message persisted before parts were carried. Those
 * runs render one flat column of prose and say so, in a caption. A two-option
 * switch with one honest option would be an invitation to a summary this app
 * would then have to invent, which is precisely what reasoning-parts.ts exists
 * to prevent.
 *
 * The switch is also hidden WHILE STREAMING, for the same reason: mid-run the
 * reasoning column is the AIcss live viewport, so neither view is on screen and
 * neither button would do anything. A control that visibly does nothing is the
 * same lie in a smaller box.
 * ───────────────────────────────────────────────────────────────────────────── */

type ReasoningView = "summary" | "full";

const VIEW_KEY = "juno.reasoning-view";

/**
 * The reader's standing preference, not a per-message toggle.
 *
 * Someone who wants the raw trace wants it on the next message too; making them
 * re-choose on every run is the same as not offering the choice. Read lazily on
 * mount rather than during render so the server-rendered markup and the first
 * client paint agree — reading `localStorage` in the initial state is a
 * hydration mismatch waiting to happen.
 */
function useReasoningView(): [ReasoningView, (next: ReasoningView) => void] {
  const [view, setView] = React.useState<ReasoningView>("summary");

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_KEY);
      if (stored === "summary" || stored === "full") setView(stored);
    } catch {
      // Private mode, or storage disabled. The default stands; a preference we
      // cannot persist is not a reason to fail to render the panel.
    }
  }, []);

  const choose = React.useCallback((next: ReasoningView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* as above */
    }
  }, []);

  return [view, choose];
}

/**
 * Summary ⇄ Full. This used to be a locally-built radiogroup — well track,
 * roving tabindex, arrow-key handler, raised selected segment — i.e. a second
 * copy of <SegmentedControl>, which already ships all of it plus the gliding
 * thumb, the press dip and the travel stretch. The copy also chose `rounded-full`
 * for both track and segments where the primitive is menu 14 / control 10, so
 * the two segmented controls a reader meets in one session (this one and the
 * artifact card's Preview/Code) looked like two different widgets.
 */
const VIEW_OPTIONS: (SegmentedOption<ReasoningView> & { hint: string })[] = [
  { value: "summary", label: "Summary", hint: "The model’s own summary steps." },
  { value: "full", label: "Full", hint: "The complete reasoning trace." },
];

/** A figure that was MEASURED. The sr-only prefix is what tells a screen reader
 *  that the bare number in column three is a duration — the visual column header
 *  it would otherwise be reading from does not exist for it. */
function Figure({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <dd className={className}>
      <span className="sr-only">duration </span>
      {children}
    </dd>
  );
}

const COPY_REVERT_MS = 1400;

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
 *
 * STREAMING AND COMPLETE ARE THE SAME CHASSIS. Nothing reflows on settle: the
 * eyebrow crossfades to COMPLETE, the live line unmounts, the elapsed figure
 * gains its tenth in place, and COST appends BELOW the elapsed block so nothing
 * above it moves. There is no auto-close — auto-close belongs to an in-transcript
 * disclosure, not to a docked column the reader opened deliberately.
 */
export function ThoughtProcessPanel({
  id,
  onClose,
  run,
  reasoning,
  reasoningParts,
  streaming,
  live,
  finishNote,
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
  /** The strip's current sentence, computed by `liveCopy` in ActivityTimeline
   *  and handed down for exactly the reason `run` is: one value, one call site,
   *  so the strip and the panel CANNOT drift. The panel has no events of its
   *  own to derive it from and is not given any. */
  live?: LiveCopy;
  /** The finish-reason sentence, already resolved by message-item. Threaded
   *  down rather than re-derived: `finishReason` lives on the message, not in
   *  the run's event stream, and there must be exactly one wording of it. */
  finishNote?: string | null;
}) {
  const hasReasoning = !!reasoning?.trim();
  const rootRef = React.useRef<HTMLElement>(null);
  const [view, setView] = useReasoningView();
  const [copied, setCopied] = React.useState<"run" | "sources" | null>(null);
  const copyTimer = React.useRef<number | null>(null);

  /**
   * WHICH TOOL ROWS ARE OPEN — per row, local, and deliberately not persisted.
   *
   * Unlike Summary/Full, which is a standing reading preference and lives in
   * localStorage, "which call did I want to look inside" is a question about
   * one run and one moment. Persisting it would reopen a stranger's payload on
   * the next message that happened to reuse a row id.
   *
   * All closed by default, all of them. A run with six calls expanded is six
   * code blocks and several thousand lines standing between the reader and the
   * reasoning section, and the panel's default state has to be readable at a
   * glance or the disclosure is not buying anything.
   */
  const [openTools, setOpenTools] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleTool = React.useCallback((rowId: string) => {
    setOpenTools((prev) => {
      const next = new Set(prev);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }, []);

  // A receipt is not only an explanation — it is a direct control surface for
  // the exact facts this turn used. Forgetting writes the durable suppression
  // through the same authenticated memory route as the Memory page, then hides
  // only the local receipt row; the persisted chat remains an honest historical
  // record of what the model saw.
  const [forgottenMemories, setForgottenMemories] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [forgettingMemory, setForgettingMemory] = React.useState<string | null>(null);
  const [memoryError, setMemoryError] = React.useState<string | null>(null);
  const forgetMemory = React.useCallback(async (memoryId: string) => {
    setForgettingMemory(memoryId);
    setMemoryError(null);
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forget: true }),
      });
      if (!response.ok) throw new Error("Could not forget that memory.");
      setForgottenMemories((previous) => new Set([...previous, memoryId]));
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Could not forget that memory.");
    } finally {
      setForgettingMemory(null);
    }
  }, []);

  /**
   * STEPS — the model's own words, or nothing.
   *
   * `toSteps` returns null unless the provider actually delivered parts, so
   * this is null for Anthropic, Zhipu, Mistral, Google and for every message
   * persisted before parts were carried. Nothing here inspects `reasoning` to
   * look for structure: the only boundaries that exist are the ones the
   * provider sent.
   */
  const steps = React.useMemo(() => toSteps(reasoningParts), [reasoningParts]);

  /**
   * The lines the AIcss viewport shows WHILE STREAMING, and only then.
   *
   * The old panel refused to render this at all, on the grounds that "the strip
   * is showing this exact stream a column away". That is false below `lg`, where
   * chat-view puts the chat column in `hidden lg:flex` — the strip is
   * `display:none` and the panel was the only surface left, showing nothing. So
   * the live trace mounts here too, in the container built for it: 40px slots,
   * a 180px cap, and the newest line translated into view rather than scrolled
   * to, which is what stops a growing trace reflowing under the reader.
   */
  const liveLines = React.useMemo(
    () => (streaming ? toReasoningLines(reasoning, reasoningParts) : []),
    [streaming, reasoning, reasoningParts],
  );

  // Focus moves in on open — the user pressed a control to get here, so the
  // caret follows. Nothing holds it: Tab leaves the panel normally, and
  // ActivityTimeline hands focus back to the trigger on close. preventScroll
  // stops the dock stealing the chat's scroll position on the way in.
  React.useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = React.useCallback(async (what: "run" | "sources", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard permission, or an insecure origin. Saying "Copied" when
      // nothing was copied is the smallest lie in the panel and still a lie.
      return;
    }
    setCopied(what);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), COPY_REVERT_MS);
  }, []);

  const factOf = (label: string) => run.facts.find((f) => f.label === label)?.value ?? null;
  const modelName = factOf("Model");
  const costValue = factOf("Cost");

  /**
   * THE COST FIGURE, AND ITS ONE FAILURE MODE.
   *
   * `chat-usage.ts` joins the whole usage breakdown into one prose string and
   * throws the structure away, so the money has to be read back out of it. The
   * rule is: lift the currency token with one anchored match and degrade to a
   * STATED row — the producer's whole string, verbatim, inside SETUP — never to
   * a partial or reconstructed number. See `splitCost`.
   */
  const { money, billed } = splitCost(costValue);

  const warnings = run.calls.filter((c) => c.warn);
  const tools = run.calls.filter((c) => !c.warn);
  const setupFacts = run.facts.filter((f) => f.label !== "Model" && f.label !== "Cost");
  // When the money could not be lifted, the whole usage string joins SETUP as
  // one more stated row rather than vanishing.
  const setupRows = money === null && costValue ? [...setupFacts, { label: "Cost", value: costValue }] : setupFacts;

  const domainCount = new Set(run.sources.map((s) => s.domain)).size;
  const countLine =
    [
      run.sourceCount ? plural(run.sourceCount, "source") : null,
      domainCount ? plural(domainCount, "domain") : null,
      run.searches ? plural(run.searches, "search", "searches") : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  const activeKey = run.phases.find((p) => p.active)?.key;
  const statusEyebrow = !streaming
    ? "COMPLETE"
    : activeKey === "research"
      ? "RESEARCHING"
      : activeKey === "write"
        ? "WRITING"
        : "THINKING";

  const showNotice = warnings.length > 0 || !!finishNote;
  const showElapsed = run.elapsedMs !== null;
  // COST DOES NOT RENDER UNTIL `usage` LANDS. A dash at 22px for the length of a
  // 90-second run is a large, prominent nothing; absence is already this panel's
  // idiom for unknown, so it is used here rather than a placeholder with a
  // "pending" caption beside it.
  const showCost = money !== null && !streaming;
  const visibleMemoryReceipt = run.memoryReceipt.filter((memory) => !forgottenMemories.has(memory.id));
  const showMemoryReceipt = visibleMemoryReceipt.length > 0;
  const showSetup = setupRows.length > 0 || showMemoryReceipt;
  // WIDENED GATE. A search that returned nothing used to show no query, no
  // search line and no evidence a search had happened at all — the run's most
  // interesting outcome rendered as a gap.
  const showSources = !!run.query || run.sources.length > 0;
  const showTools = tools.length > 0;
  const showReasoning = hasReasoning || (streaming && liveLines.length > 0);

  // Which ruled section is first, so the rule can be a separator rather than a
  // second header border. Nothing above the ledger (no notice, not streaming)
  // means the first ledger section draws no rule of its own.
  const ruledOrder = [
    showElapsed && "elapsed",
    showCost && "cost",
    showSetup && "setup",
    showSources && "sources",
    showTools && "tools",
    showReasoning && "reasoning",
    "footer",
  ].filter(Boolean) as string[];
  const firstRuled = showNotice || streaming ? null : ruledOrder[0];
  const rule = (key: string) => (key === firstRuled ? SECTION_FIRST : SECTION);

  /**
   * ONE ANNOUNCER, PHASE-LEVEL ONLY.
   *
   * The scroller is `aria-live="off"` and every mutating row inside it is
   * therefore silent, because this panel is portalled into chat-view's dock —
   * outside message-item's polite region — and its figures rewrite once a
   * second. What a screen reader actually needs from a run is three or four
   * events, not three hundred: which phase it is in, and how it ended.
   *
   * Debounced, because a fast run can cross two phases inside 500ms and a
   * queued pair of announcements would be read after the run had already
   * finished. Spoken duration uses `speakSpan`, not `formatSpan`'s glyph.
   */
  const announceTarget = streaming
    ? statusEyebrow.charAt(0) + statusEyebrow.slice(1).toLowerCase()
    : [
        run.elapsedMs === null ? "Complete." : `Complete in ${speakSpan(run.elapsedMs)}.`,
        money ? `Cost ${money}.` : null,
      ]
        .filter(Boolean)
        .join(" ");
  const [announcement, setAnnouncement] = React.useState("");
  React.useEffect(() => {
    const t = window.setTimeout(() => setAnnouncement(announceTarget), 500);
    return () => window.clearTimeout(t);
  }, [announceTarget]);

  const hintId = `${id}-view-hint`;
  const showToggle = !streaming && !!steps;

  return (
    <aside
      id={id}
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      className="flex size-full flex-col bg-card focus:outline-none"
    >
      <header className="flex shrink-0 items-start gap-4 border-b border-border/55 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {streaming && <ThinkingDots className="origin-left scale-75 text-muted-foreground/55" />}
            <span
              key={statusEyebrow}
              className={cn(
                "font-mono text-label uppercase motion-safe:animate-fade-in",
                streaming ? "text-primary" : "text-muted-foreground",
              )}
            >
              {statusEyebrow}
            </span>
          </div>
          {/* Archivo, not Newsreader: inside this panel serif is reserved for
              text the MODEL generated. A model NAME is Juno's chrome. This is a
              deliberate local override of the house "serif carries headings"
              rule, recorded here so it does not read as an inconsistency and
              get "fixed" back. */}
          <h2
            id={`${id}-title`}
            className="mt-1 truncate font-sans text-heading text-foreground"
            title={modelName ?? undefined}
          >
            {modelName ?? "Thought process"}
          </h2>
        </div>

        {/* A hand-rolled copy of `kind="icon" size="lg"`, down to the 36/44
            ladder. Also the largest of the eight controls in this file that each
            set `outline-none` and drew their own focus ring — all of them now
            defer to the global `:focus-visible` rule, which is the authority. */}
        <Pressable kind="icon" size="lg" onClick={onClose} className="shrink-0">
          <ActionIcons.dismiss className="size-4" aria-hidden="true" />
          <span className="sr-only">Close thought process</span>
        </Pressable>
      </header>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div aria-live="off" className="flex-1 overflow-y-auto px-5 pb-6 pt-4">
        {/* NOTICE — first, conditional, and ABSENT when the run was clean. There
            is no "no warnings" state: its absence is the signal.

            The text is the producer's own `[title, detail].join(" · ")`,
            verbatim. It is deliberately NOT re-phrased into blame ("The Linear
            connector did not respond"): the only exact signal on the wire is
            `kind === "warning"`, and naming a failing component from a warning
            title is inference dressed as fact. `RunModel.note` says so in its
            own contract. Blame-splitting waits for a `source` field. */}
        {showNotice && (
          <section
            aria-labelledby={`${id}-notice`}
            /* The dark tint is separated out. --warning is a 58%-lightness fill in
               dark, so 5% of it over the --card panel is a 2.6-point step — the
               one block in the panel that has to be noticed was the quietest
               thing in it. 5% is still right over light paper. */
            className="-mx-5 border-l-2 border-warning/35 bg-warning/5 px-5 py-3 motion-safe:animate-fade-in-up dark:bg-warning/10"
          >
            <h3 id={`${id}-notice`} className="font-mono text-label uppercase text-warning">
              Notice
            </h3>
            <ul className="mt-1.5 space-y-1">
              {warnings.map((c) => (
                <li key={c.id} className="break-words text-body text-warning">
                  {c.object}
                </li>
              ))}
              {finishNote && <li className="break-words text-body text-warning">{finishNote}</li>}
            </ul>
          </section>
        )}

        {/* THE LIVE LINE — honest about NOW, and destroyed on settle. No log of
            it survives, because a record of per-step narration would be a
            fabrication: the events it is derived from nearly all share one
            timestamp. */}
        {streaming && live && (
          <p className="mt-3">
            {live.warning ? (
              <span className="text-body-lg leading-6 text-warning">{live.message}</span>
            ) : (
              <ThinkingState className="text-body-lg leading-6" tone="strong">
                {live.message}
              </ThinkingState>
            )}
          </p>
        )}

        {/* ELAPSED — the first ledger, and the only block with real figures.
            The <dt> spans columns 1–2 so the total lands in column 3 with its
            constituents directly beneath it, on one axis: total = sum of parts
            is arithmetic here (buildRun subtracts the research sub-interval out
            of THINK precisely so that it is), and now it is visibly so. */}
        {showElapsed && (
          <section aria-labelledby={`${id}-elapsed`} className={cn(rule("elapsed"), "motion-safe:animate-fade-in-up")}>
            <dl className={LEDGER}>
              <dt id={`${id}-elapsed`} className="col-span-2 font-mono text-label uppercase text-muted-foreground">
                Elapsed
              </dt>
              <Figure className={FIG_TOTAL}>{formatSpan(run.elapsedMs as number, { live: streaming })}</Figure>

              {/* Constituents only when there are at least two of them. One
                  phase whose ms equals the total, printed twice, is noise
                  wearing the shape of a breakdown. */}
              {run.phases.length >= 2 &&
                run.phases.map((p) => (
                  <React.Fragment key={p.key}>
                    <dt className={cn("text-body", p.active ? "text-primary" : "text-muted-foreground")}>{p.label}</dt>
                    <dd className="min-w-0 truncate text-body text-foreground/70">
                      {/* Effort is an INPUT. It appears exactly once, in SETUP —
                          not here, where it would read as something Think did. */}
                      {p.key === "think" ? "" : p.object}
                    </dd>
                    {/* The active row goes coral. The figure carries no shine:
                        shine belongs on prose, not on a number that is already
                        changing once a second of its own accord. */}
                    <Figure className={cn(FIG, p.active && "text-primary")}>
                      {p.ms === null ? "—" : formatSpan(p.ms, { live: streaming && p.active })}
                    </Figure>
                  </React.Fragment>
                ))}
            </dl>
          </section>
        )}

        {/* COST — appended below ELAPSED so its arrival on settle moves nothing
            above it. `Billed` is a STATED row: the <dd> spans into the figure
            column's territory rather than leaving a hole, so it HAS no figure
            cell. There is no expand-on-click breakdown, because the one string
            the producer sends IS the breakdown. */}
        {showCost && (
          <section aria-labelledby={`${id}-cost`} className={cn(rule("cost"), "motion-safe:animate-fade-in-up")}>
            <dl className={LEDGER}>
              <dt id={`${id}-cost`} className="col-span-2 font-mono text-label uppercase text-muted-foreground">
                Cost
              </dt>
              <dd className={FIG_TOTAL}>{money}</dd>
              {billed && (
                <>
                  <dt className="text-body text-muted-foreground">Billed</dt>
                  <dd className="col-span-2 min-w-0 break-words text-body text-foreground/80">{billed}</dd>
                </>
              )}
            </dl>
          </section>
        )}

        {/* SETUP — configuration, and every row STATED. The missing figure
            column is the whole point. */}
        {showSetup && (
          <section aria-labelledby={`${id}-setup`} className={cn(rule("setup"), "motion-safe:animate-fade-in-up")}>
            <SectionHeading id={`${id}-setup`}>Setup</SectionHeading>
            <dl className={cn(LEDGER, "mt-3")}>
              {setupRows.map((f) => (
                <React.Fragment key={f.label}>
                  <dt className="text-body text-muted-foreground">{f.label}</dt>
                  <dd className="col-span-2 min-w-0 break-words text-body text-foreground/80">{f.value}</dd>
                </React.Fragment>
              ))}
            </dl>
            {showMemoryReceipt && (
              <div className="mt-5 border-t border-border/45 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="font-mono text-label uppercase text-muted-foreground">Memory used</h4>
                  <a
                    href="/memory"
                    className="text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Manage all
                  </a>
                </div>
                <ul className="mt-2.5 space-y-2">
                  {visibleMemoryReceipt.map((memory) => {
                    const sourceHref =
                      memory.sourceRef && !["manual", "edit", "forget"].includes(memory.sourceRef)
                        ? `/chat/${memory.sourceRef}`
                        : null;
                    return (
                      <li key={memory.id} className="rounded-control border border-border/45 bg-secondary px-3 py-2">
                        <p className="break-words text-body text-foreground/85">{memory.content}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
                          {sourceHref && (
                            <a
                              href={sourceHref}
                              className="underline-offset-4 hover:text-foreground hover:underline"
                            >
                              Open source chat
                            </a>
                          )}
                          <button
                            type="button"
                            disabled={forgettingMemory === memory.id}
                            onClick={() => void forgetMemory(memory.id)}
                            className="underline-offset-4 hover:text-destructive hover:underline disabled:cursor-wait disabled:opacity-60"
                          >
                            {forgettingMemory === memory.id ? "Forgetting…" : "Forget this"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {memoryError && <p className="mt-2 text-caption text-destructive">{memoryError}</p>}
              </div>
            )}
          </section>
        )}

        {/* SOURCES — the durable asset. Survives the stream, addressable,
            auditable. Rendered here rather than through WebSearchBlock: the
            model already carries `domain`, so nothing needs re-deriving from the
            URL, and `overflow-hidden` + `truncate` keeps a long title from
            pushing the dock into a horizontal scrollbar. */}
        {showSources && (
          <section aria-labelledby={`${id}-sources`} className={cn(rule("sources"), "motion-safe:animate-fade-in-up")}>
            <SectionHeading id={`${id}-sources`}>Sources</SectionHeading>

            {/* Newsreader italic: the query is text the model wrote. */}
            {run.query && <p className="mt-3 font-serif text-body italic text-muted-foreground">“{run.query}”</p>}
            {countLine && <p className="mt-1 font-mono text-caption text-muted-foreground">{countLine}</p>}

            {run.sources.length > 0 ? (
              <ul className="-mx-2 mt-2.5">
                {run.sources.map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-baseline gap-3 overflow-hidden rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
                    >
                      <span className="min-w-0 flex-1 truncate text-body text-foreground/85">{s.title}</span>
                      {/* Only the exception is marked. A read page and a page
                          whose producer never said carry no tag at all, which
                          is the panel's idiom everywhere else: absence is the
                          default state, and a badge on every row would say
                          nothing while looking like it did. */}
                      {s.access === "listed" && (
                        <span className="shrink-0 font-mono text-caption text-muted-foreground">listed</span>
                      )}
                      <span className="shrink-0 font-mono text-caption text-source">{s.domain}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2.5 text-body text-muted-foreground">The search returned no sources.</p>
            )}
          </section>
        )}

        {/* ── TOOLS ────────────────────────────────────────────────────────
            Every connector call the run made, in order, each one openable onto
            what was sent and what came back.

            THE FIGURE COLUMN IS BACK, FOR EXACTLY ONE FIGURE. `tool.durationMs`
            is measured in mcp.ts around `client.callTool` — a real interval on
            a real await, on one call, not a block of sends sharing one
            Date.now(). It is the first per-item number this panel has ever been
            able to print honestly, and it is the only one printed. It also
            EXCLUDES the approval wait, which happens before that clock starts:
            attributing a person's 90-second pause to Linear's API would be a
            new lie in a panel built to end them.

            And it is ABSENT, never zero, for the four calls that never reached
            the network — an unknown tool name, an unavailable connector, a
            refused action, anything that failed before dispatch. Those rows
            keep the STATED shape: the <dd> spans 2/-1 and there is NO figure
            cell, in the DOM and in the accessibility tree alike. Both grammars
            appear in this one list, which is precisely the migration the header
            comment anticipated.

            NOT A <details>. The disclosure is a button plus aria-expanded
            because `<details>` is not permitted inside a <dl>, and the <dl> is
            what carries the PHASES/FACTS split as markup. Given a choice
            between the element with free behaviour and the grammar the whole
            panel's honesty claim rests on, the grammar wins and the behaviour
            is re-supplied in six lines.

            A FAILED CALL STAYS ON ITS ROW. It is not promoted into NOTICE:
            NOTICE renders `kind: "warning"`, which is run-level, and a
            connector hiccup reported there would double-report and would make
            a recoverable failure look like a failed run. */}
        {showTools && (
          <section aria-labelledby={`${id}-tools`} className={cn(rule("tools"), "motion-safe:animate-fade-in-up")}>
            <SectionHeading id={`${id}-tools`}>Tools</SectionHeading>

            {/* PERMANENT, and body-sized, like REASONING's. It states the
                redaction AND its limit: a result may contain anything the
                connector returned, and a reader who assumes it was sanitised of
                their own data would be wrong. */}
            <p className="mt-2.5 text-body text-muted-foreground">{TOOLS_DESCRIPTION}</p>
            {tools.some((c) => !c.tool) && (
              <p className="mt-1 text-caption text-muted-foreground">{TOOLS_NO_DETAIL_NOTE}</p>
            )}

            <dl className={cn(LEDGER, "mt-3")}>
              {tools.map((c) => {
                const t = c.tool;
                const failed = t?.status === "failed";
                const durationMs = t && typeof t.durationMs === "number" ? t.durationMs : null;
                const expanded = openTools.has(c.id);
                const bodyId = `${id}-tool-${c.id}`;
                return (
                  <React.Fragment key={c.id}>
                    <dt className={cn("text-body", failed ? "text-warning" : "text-muted-foreground")}>
                      {failed ? "Failed" : "Tool"}
                    </dt>
                    {/* Spans into the figure column ONLY when there is no
                        figure. This is the one place in the panel where a
                        single list holds both grammars. */}
                    <dd className={cn("min-w-0", durationMs === null && "col-span-2")}>
                      {t ? (
                        <button
                          type="button"
                          onClick={() => toggleTool(c.id)}
                          aria-expanded={expanded}
                          /* Only while the body is in the document — an
                             aria-controls pointing at nothing is worse than
                             none at all. */
                          aria-controls={expanded ? bodyId : undefined}
                          className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-1.5 rounded-control px-1.5 py-0.5 text-left text-body text-foreground/80 transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={cn(
                              "size-3 shrink-0 translate-y-px text-muted-foreground/50 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                              expanded && "rotate-90",
                            )}
                          />
                          <span className="min-w-0 break-words">{c.object}</span>
                        </button>
                      ) : (
                        // No payload behind it, so no control over it. A button
                        // that opens an explanation of its own emptiness is a
                        // click that costs the reader something and returns
                        // nothing; the section note above says it once instead.
                        <span className="block break-words text-body text-foreground/80">{c.object}</span>
                      )}
                    </dd>
                    {durationMs !== null && <Figure className={FIG}>{formatSpan(durationMs)}</Figure>}

                    {t && expanded && (
                      <dd id={bodyId} className="col-[2/-1] min-w-0 self-start pb-2">
                        {/* `code` only, never `lines`: `lines` is for callers
                            that already ran rehype-highlight, and tokenising
                            untrusted connector output to colour it spends real
                            client time for a decorative payoff. The numbered
                            gutter and the monospace column are the whole value.

                            Nothing here parses or re-formats either payload.
                            Arguments arrive pretty-printed; a result arrives
                            pretty-printed only if the server found the WHOLE
                            body to be JSON — which is a judgement only the
                            server can make, because the client holds a possibly
                            truncated head and JSON.parse on a head fails on
                            exactly the large results where formatting matters
                            most. */}
                        {t.args ? (
                          <AicssCodeBlock
                            label={toolArgsLabel(t)}
                            code={t.args}
                            maxBodyHeight={220}
                            // `bg-secondary`, and it is a DELIBERATE override of
                            // `.aicss-cb`'s own fill, not an accident of the
                            // components-vs-utilities order. The class paints
                            // --card, this panel is --card, so the block was the
                            // same colour as the sheet it lies on and only its
                            // 1px ring said otherwise. What was here — `bg-muted/25`
                            // — also won that fight and resolved to ~7.25%, i.e.
                            // it overrode the class in order to change nothing.
                            className="mt-1 bg-secondary"
                          />
                        ) : (
                          // NEVER an empty code block. An empty box implies the
                          // model sent nothing; the four reasons it might be
                          // missing are four different facts and each gets its
                          // own sentence.
                          <p className="mt-1 text-body text-muted-foreground">{toolArgsNoteText(t)}</p>
                        )}

                        {t.result ? (
                          <AicssCodeBlock
                            label={toolResultLabel(t)}
                            code={t.result}
                            maxBodyHeight={320}
                            // Same override as the args block above, same reason.
                            className="mt-3 bg-secondary"
                          />
                        ) : (
                          <p className="mt-3 text-body text-muted-foreground">{toolResultNoteText(t)}</p>
                        )}
                      </dd>
                    )}
                  </React.Fragment>
                );
              })}
            </dl>
          </section>
        )}

        {/* REASONING — the panel's body, and the largest area on screen, because
            it is the only thing here with genuine content.

            Disclosure depth inside this section is ZERO. The old "Full thinking
            ›" button was a second tier over text the reader had already opened a
            panel to read; Summary↔Full is lateral, not nested. */}
        {showReasoning && (
          <section
            aria-labelledby={`${id}-reasoning`}
            className={cn(rule("reasoning"), "motion-safe:animate-fade-in-up")}
          >
            <div className="flex items-center justify-between gap-3">
              <SectionHeading id={`${id}-reasoning`}>Reasoning</SectionHeading>
              {showToggle && (
                <SegmentedControl
                  value={view}
                  onChange={setView}
                  options={VIEW_OPTIONS}
                  ariaLabel="Reasoning detail"
                  className="shrink-0"
                  // The panel's own type scale; everything else is the primitive's.
                  optionClassName="px-2.5 text-caption"
                />
              )}
            </div>

            {/* PERMANENT, and body-sized rather than fine print. A reasoning
                trace is the model's account of itself, not an execution log, and
                a reader who does not know that will read it as one. */}
            <p className="mt-2.5 text-body text-muted-foreground">
              The model’s own account of its reasoning. Not a log of what it computed.
            </p>
            {/* Still visible text in reading order, but no longer wired to the
                switch with aria-describedby: <SegmentedControl> exposes no
                description passthrough. Worth a `describedBy` prop on the
                primitive; not worth keeping a second segmented control to have. */}
            {showToggle && (
              <p id={hintId} className="mt-1 text-caption text-muted-foreground">
                {VIEW_OPTIONS.find((o) => o.value === view)?.hint}
              </p>
            )}

            <div className="mt-4">
              {streaming ? (
                <ThinkingReasoning lines={liveLines} streaming showHeader={false} />
              ) : steps && view === "summary" ? (
                <div className="space-y-5">
                  {steps.map((s, i) => (
                    // Keyed by ARRAY POSITION, never by the provider's index or
                    // the title: OpenAI repeats summary_index within one
                    // response (live: [0…14, 13, 14]) and repeats titles too, so
                    // either would collide two steps into one and drop text.
                    <div key={i}>
                      {/* No ordinal, no numbered token, no connector rail, no
                          ring, no card. The title is a sub-heading and the body
                          is prose; that is all a step is.

                          A PART WITH NO TITLE GETS NO HEADING. `toStep` returns
                          `title: null` when the model did not open the part with
                          a `**Bold**` line, and in that case `body` is the WHOLE
                          part. Promoting its first line to the <h4> and printing
                          nothing else — which is what this did — set 177
                          characters of the model's prose as a semibold Archivo
                          heading and DROPPED the 202 characters behind it, with
                          no ellipsis and no way to tell. That is the same
                          mid-sentence truncation the reading column was rebuilt
                          to end, and it breaks §3 as well: Archivo carries
                          Juno's words, not the model's.

                          So: heading only when the model wrote one. Otherwise
                          the part is prose, entire. Nothing is invented and
                          nothing is lost — the step boundary is still the
                          provider's own, and it is still visible as the gap
                          between blocks. */}
                      {s.title && (
                        <h4 className="font-sans text-body font-semibold text-foreground/85">{s.title}</h4>
                      )}
                      {s.body && <Prose text={s.body} className={s.title ? "mt-1.5" : undefined} />}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <Prose text={reasoning ?? ""} />
                  {/* Says why there is no Summary to switch to, rather than
                      leaving the switch's absence to read as a missing feature. */}
                  {!steps && (
                    <p className="mt-4 text-caption text-muted-foreground">
                      This model streams one unbroken trace.
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {/* FOOTER — two copy buttons and nothing else. No "Started 14:32:07"
            line: `t0` is not reliably a server instant (see the header comment).
            No toast either — the label is the receipt. */}
        <div className={cn(rule("footer"), "flex items-center gap-2")}>
          <button
            type="button"
            onClick={() => void copy("run", toRunMarkdown(run, reasoning, finishNote))}
            className="rounded-control px-2.5 py-1.5 font-mono text-caption uppercase tracking-[0.08em] text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-muted hover:text-foreground active:scale-[0.98] active:duration-press motion-reduce:transition-none"
          >
            {copied === "run" ? "Copied" : "Copy run"}
          </button>
          {run.sources.length > 0 && (
            <button
              type="button"
              onClick={() => void copy("sources", toSourcesMarkdown(run))}
              className="rounded-control px-2.5 py-1.5 font-mono text-caption uppercase tracking-[0.08em] text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-muted hover:text-foreground active:scale-[0.98] active:duration-press motion-reduce:transition-none"
            >
              {copied === "sources" ? "Copied" : "Copy sources"}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
