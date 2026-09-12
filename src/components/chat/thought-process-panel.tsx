"use client";

import * as React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { ActionIcons, AppIcons, CodeIcons, ComposerIcons, StatusIcons } from "@/lib/app-icons";
import { AicssCodeBlock } from "@/components/aicss/code-block";
import type { WebSearchSite } from "@/components/aicss/web-search";
import { SourceFavicon, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  TOOLS_DESCRIPTION,
  TOOLS_NO_DETAIL_NOTE,
  formatSpan,
  splitCost,
  toRunMarkdown,
  toRunSummary,
  toSourcesMarkdown,
  toStepMarkdown,
  toVisibleStepsMarkdown,
  toolArgsLabel,
  toolArgsNoteText,
  toolResultLabel,
  toolResultNoteText,
} from "@/lib/run-receipt";
import { toSteps } from "@/lib/reasoning-parts";
import type { ClientActivityEvent, ClientMemoryReceipt, ClientSource, ClientToolDetail } from "@/types/chat";

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
 * were a process. That is why NOTHING in this panel prints a per-row timestamp,
 * an offset, a wall clock or a proportional bar. What it prints instead is the
 * ORDER the producer emitted things in — which is real — and a duration only
 * where one was genuinely measured.
 *
 * THE HONESTY RULE NOW LIVES IN ONE PLACE INSTEAD OF THREE. The old panel
 * carried it as markup: a three-column `<dl>` where a MEASURED row filled all
 * three columns and a STATED row's `<dd>` spanned into the figure column so it
 * HAD no figure cell. That worked, and it cost six different row vocabularies
 * in one column — a warning bullet, three ledgers, a link list, a disclosure
 * list and a prose column, all rendered at once under the model's name.
 *
 * There is one row recipe now, and the rule survives intact inside it: a step's
 * figure cell is rendered only when `step.ms !== null`, and `ms` is never
 * zero-as-unknown. A step that never had a clock has no figure, in the DOM and
 * in the accessibility tree alike. Putting a duration beside "Selected model"
 * still requires inventing a measurement that does not exist.
 *
 * Wall-clock is gone outright, and stays gone for a second reason. `t0` is
 * `at(events[0]) ?? anchorT0`, and `anchorT0` is the moment ActivityTimeline
 * MOUNTED. For a reasoning-only message, or any persisted message re-rendered
 * on page load, a "Started 14:32:07" line would print the time the reader
 * opened the page dressed as the time the run began. `t0` is an internal
 * origin. It is never rendered.
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
 * The panel renders its own source rows (they are steps, on the one row
 * recipe) because `WebSearchBlock` re-derives host+path from the URL when
 * `sources[].domain` is already on the model, and because its row lets a long
 * title push the row wider than the dock. Mid-stream, in the transcript, it
 * remains the right renderer and is untouched.
 *
 * EVERY ROW IS `done`, and that is a statement about the data rather than a
 * shortcut. A `visit` event is emitted at the moment a source has been collected
 * or read (see the sends in route.ts and deep-research.ts) — there is no event
 * for "about to fetch this URL", because until the search returns the URL is not
 * yet known. A pending or fetching row here would therefore be a state this app
 * cannot observe, drawn in the shape that says it did.
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

/* ─────────────────────────────────────────────────────────────────────────────
 * ROW COPY THE EXTRACTOR CAN SEE.
 *
 * `scripts/generate-i18n-catalog.mjs` reads a `label:` property only when its
 * value is a literal, so `label: running ? "Thinking" : "Wrote the answer"`
 * silently leaves the translation catalog — the exact trap documented at
 * run-receipt.ts:124-135, in its other form. A `…_LABEL` constant is one of the
 * names the extractor walks in full, so the words live here and the ternaries
 * below only choose between them.
 * ───────────────────────────────────────────────────────────────────────────── */
const STEP_LABEL = {
  waiting: "Waiting for the model",
  researching: "Researching",
  thinking: "Thinking",
  writing: "Writing the answer",
  wrote: "Wrote the answer",
  searched: "Searched the web",
  reasoning: "Reasoning",
  fullTrace: "Full reasoning trace",
} as const;

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
   * not joined, by `tool.durationMs`.
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
   * it just does not open. See TOOLS_NO_DETAIL_NOTE.
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
 * bare, which is the same "mark the exception, not the rule" the NOTICE band
 * uses.
 */
export type SourceAccess = "read" | "listed" | "unknown";

function sourceAccessOf(title: string): SourceAccess {
  if (title === "Listed source") return "listed";
  if (title === "Read source" || title === "Reading source") return "read";
  return "unknown";
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A STEP — the panel's only noun.
 *
 * Six row vocabularies became one. A warning, a phase, a memory receipt, a
 * source, a tool call and a reasoning part are all THIS, and the kind changes
 * the marker glyph and nothing else. That is not a styling decision: the reader
 * of a run has exactly one question — what is it doing now, and what did it
 * just do — and six shapes in one column is six answers to a question nobody
 * asked.
 * ───────────────────────────────────────────────────────────────────────────── */
export type StepKind = "think" | "search" | "source" | "tool" | "memory" | "notice" | "write";

export interface Step {
  /** Event id, or `reason-${i}` for a provider reasoning part. Stable across
   *  ticks, because it keys both the React list and the expanded-body set. */
  id: string;
  kind: StepKind;
  /** Which sticky section it files under. */
  phase: PhaseKey;
  /** Line 1. Never invented — see the table in each branch of `buildSteps`. */
  label: string;
  /** Line 2, or null. Never an empty line: absence is a rendering decision made
   *  here, once, rather than by each row guessing. */
  detail: string | null;
  /** MEASURED only. Never zero-as-unknown — a step with no clock has no
   *  figure cell at all. */
  ms: number | null;
  /** At most one `true` across the whole array. */
  running: boolean;
  failed: boolean;
  body?:
    | { type: "tool"; tool: ClientToolDetail }
    | { type: "prose"; text: string }
    | { type: "memory"; memory: ClientMemoryReceipt };
  source?: { url: string; domain: string; access: SourceAccess; citeIndex: number | null };
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
  /* ── Added for the transcript rewrite. Everything above is untouched, because
   *    activity-timeline reads `calls`/`searches`/`sourceCount`/`query`/`note`/
   *    `elapsedMs` to build the resting strip's nouns and run-receipt reads
   *    `phases`/`facts`/`calls`/`sources`. Deriving those from `steps` instead
   *    would be a second opinion on the same run. ── */
  /** The spine, in emission order, grouped by phase at render time. */
  steps: Step[];
  /** The run reported no `usage` event. Gated on there being events at all: a
   *  reasoning-only message has no event stream to be missing a usage row from,
   *  and calling that "Stopped" would be an accusation with nothing behind it. */
  stopped: boolean;
  /** Output tokens, lifted from the usage string's `N output`, or null. Never
   *  reconstructed from anything else. */
  outputTokens: string | null;
}

/** What the live strip is currently saying. Computed ONCE, by the caller that
 *  owns the events, and handed to the panel — see the `live` prop. */
export interface LiveCopy {
  message: string;
  warning: boolean;
}

/** Everything `buildRun` needs that is not an activity event. Optional in full:
 *  the receipt tests call `buildRun(events, null)` and must keep doing so. */
export interface RunContext {
  /** The message's own source list, for `citeIndex`. See `Step.source`. */
  sources?: ClientSource[] | null;
  /** The flat reasoning trace, for the `full` view's single step. */
  reasoning?: string | null;
  /** The provider's own discrete parts, for the `summary` view's steps. */
  reasoningParts?: string[] | null;
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
export function buildRun(
  events: ClientActivityEvent[],
  nowServer: number | null,
  anchorT0?: number | null,
  context?: RunContext,
): RunModel {
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
  // arrive last. Falling back to `events[last]` mid-stream reads the `write`
  // event itself — so WRITE measured write→write = 0.0s for the entire body
  // stream — or, on a run with native search, the last `visit`, which is "time
  // until the last citation appeared" wearing a WRITE label.
  const tEnd = at(usageEv) ?? nowServer ?? at(events[events.length - 1]);

  // EVERY page the run reported, in emission order, with no cap and no sample.
  // The only thing dropped is a repeat of a URL already listed, because the same
  // page arriving twice is one page.
  const sources: RunModel["sources"] = [];
  const sourceEvents: ClientActivityEvent[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    const domain = domainOf(e.url);
    // The producer already truncated `detail` to 96 and already fell back to the
    // host when the page had no title, so there is nothing left to decide here.
    sources.push({ url: e.url, domain, title: e.detail?.trim() || domain, access: sourceAccessOf(e.title) });
    sourceEvents.push(e);
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
  const outputTokens = outMatch ? outMatch[1] : null;
  if (tWrite !== null) {
    phases.push({
      key: "write",
      label: "Write",
      object: outputTokens ? `${outputTokens} tokens` : "",
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
  const memoryReceipt = memoryEv?.memoryReceipt ?? [];

  const steps = buildSteps({
    events,
    searchEvs,
    sourceEvents,
    sources,
    calls,
    memoryReceipt,
    context,
    tWrite,
    tEnd,
    span,
    outputTokens,
    streaming,
    researchRunning,
    writeRunning,
  });

  return {
    t0,
    phases,
    facts,
    memoryReceipt,
    calls,
    sources,
    searches: searchEvs.length,
    sourceCount: sources.length,
    query: searchEvs[searchEvs.length - 1]?.detail?.trim() || null,
    elapsedMs,
    note: warnings.length ? warnings[warnings.length - 1].title : null,
    steps,
    stopped: events.length > 0 && !usageEv && !streaming,
    outputTokens,
  };
}

/**
 * THE SPINE, in emission order.
 *
 * ORDERING IS THE ONE CLAIM THIS PANEL MAKES ABOUT TIME, and it is a claim the
 * data supports: the producer's sends are ordered even where their timestamps
 * collide. Nothing here sorts by `createdAt` — most of a run's events share one
 * instant, so sorting would shuffle a real order into an arbitrary one.
 *
 * REASONING STEPS ARE NOT INTERLEAVED WITH TOOL CALLS, and that absence is
 * deliberate. A provider's summary parts carry no timestamps at all; placing
 * them between two tool rows would draw a sequence nobody measured. They open
 * the THINK section, the calls follow, and the gap between the two is honest
 * about what is known.
 */
function buildSteps(input: {
  events: ClientActivityEvent[];
  searchEvs: ClientActivityEvent[];
  sourceEvents: ClientActivityEvent[];
  sources: RunModel["sources"];
  calls: Call[];
  memoryReceipt: ClientMemoryReceipt[];
  context?: RunContext;
  tWrite: number | null;
  tEnd: number | null;
  span: (a: number | null, b: number | null) => number | null;
  outputTokens: string | null;
  streaming: boolean;
  researchRunning: boolean;
  writeRunning: boolean;
}): Step[] {
  const {
    events,
    searchEvs,
    sourceEvents,
    sources,
    calls,
    memoryReceipt,
    context,
    tWrite,
    tEnd,
    span,
    outputTokens,
    streaming,
    researchRunning,
    writeRunning,
  } = input;

  const steps: Step[] = [];

  // ── RESEARCH: the searches the run ran, then the pages it came back with ──
  for (const e of searchEvs) {
    const query = e.detail?.trim();
    steps.push({
      id: e.id,
      kind: "search",
      phase: "research",
      // The producer's own query string, in the producer's own quotes. A search
      // with no query recorded says only that a search happened.
      label: query ? `Searched “${query}”` : STEP_LABEL.searched,
      detail: null,
      ms: null,
      running: false,
      failed: false,
    });
  }

  /* `citeIndex` is the 1-based position of this URL in the MESSAGE's `sources`
   * array, and only when that array is a numbered corpus the model was actually
   * shown (`ClientSource.cited`). On every native-search path the model never
   * saw an index, so a bracket in its text means nothing — a chip pointing at
   * an arbitrary source is worse than no chip. Absent on older persisted rows,
   * which degrades to the same null. */
  const cited = context?.sources ?? [];
  const citeIndexOf = (url: string) => {
    const i = cited.findIndex((s) => s.url === url);
    return i >= 0 && cited[i]?.cited === true ? i + 1 : null;
  };

  sourceEvents.forEach((e, i) => {
    const s = sources[i];
    steps.push({
      id: e.id,
      kind: "source",
      phase: "research",
      label: s.title,
      // Only the exception is marked. A read page and a page whose producer
      // never said carry no tag, which is this panel's idiom everywhere.
      detail: s.access === "listed" ? `${s.domain} · listed` : s.domain,
      ms: null,
      running: false,
      failed: false,
      source: { url: s.url, domain: s.domain, access: s.access, citeIndex: citeIndexOf(s.url) },
    });
  });

  // ── THINK: the model's own account, then the calls it made ────────────────
  const parts = toSteps(context?.reasoningParts);
  const trace = context?.reasoning?.trim();
  if (parts) {
    parts.forEach((part, i) => {
      /* A PART WITH NO TITLE GETS NO HEADING. `toStep` returns `title: null`
       * when the model did not open the part with a `**Bold**` line, and in
       * that case `body` is the WHOLE part. Promoting its first line to a
       * heading set 177 characters of the model's prose as a semibold label and
       * dropped the 202 characters behind it, with no ellipsis and no way to
       * tell. So: a label only when the model wrote one; otherwise the part's
       * opening is the DETAIL line and the whole part is the body. */
      const preview = part.body.replace(/\s+/g, " ").trim();
      steps.push({
        id: `reason-${i}`,
        kind: "think",
        phase: "think",
        label: part.title ?? STEP_LABEL.reasoning,
        detail: preview ? preview.slice(0, 90) : null,
        ms: null,
        running: false,
        failed: false,
        ...(part.body ? { body: { type: "prose" as const, text: part.body } } : {}),
      });
    });
  } else if (trace) {
    steps.push({
      id: "reason-full",
      kind: "think",
      phase: "think",
      label: STEP_LABEL.fullTrace,
      detail: "This model streams one unbroken trace.",
      ms: null,
      running: false,
      failed: false,
      body: { type: "prose", text: trace },
    });
  }

  for (const call of calls) {
    if (call.warn) {
      steps.push({
        id: call.id,
        kind: "notice",
        phase: "think",
        // The producer's own `[title, detail].join(" · ")`, verbatim. Never
        // re-phrased into blame ("The Linear connector did not respond"): the
        // only exact signal on the wire is `kind === "warning"`, and naming a
        // failing component from a warning title is inference dressed as fact.
        label: call.object,
        detail: null,
        ms: null,
        running: false,
        failed: true,
      });
      continue;
    }
    const tool = call.tool;
    steps.push({
      id: call.id,
      kind: "tool",
      phase: "think",
      label: call.object,
      detail: null,
      // ABSENT, never zero, for the calls that never reached the network — an
      // unknown tool name, an unavailable connector, a refused action. A zero
      // would read as "the connector answered instantly".
      ms: tool && typeof tool.durationMs === "number" ? tool.durationMs : null,
      running: false,
      failed: tool?.status === "failed",
      ...(tool ? { body: { type: "tool" as const, tool } } : {}),
    });
  }

  // ── MEMORY: an INPUT, not an event. Filed in Details, never in the spine ──
  for (const memory of memoryReceipt) {
    steps.push({
      id: `memory-${memory.id}`,
      kind: "memory",
      phase: "think",
      label: memory.content,
      detail: memory.category ?? null,
      ms: null,
      running: false,
      failed: false,
      body: { type: "memory", memory },
    });
  }

  // ── WRITE ─────────────────────────────────────────────────────────────────
  if (tWrite !== null) {
    steps.push({
      id: "write",
      kind: "write",
      phase: "write",
      label: writeRunning ? STEP_LABEL.writing : STEP_LABEL.wrote,
      detail: outputTokens ? `${outputTokens} tokens` : null,
      // A running step shows no figure at all: absence is this panel's idiom
      // for "not yet measured", and the header clock is the only clock.
      ms: writeRunning ? null : span(tWrite, tEnd),
      running: writeRunning,
      failed: false,
    });
  } else if (streaming) {
    /* THE RUNNING ROW, when the run has not started writing yet.
     *
     * Its label is the PHASE, not an invented action — "Researching", not
     * "Reading nature.com". The specific action is the recap sentence's job and
     * it already has one value to say it with; a second, differently-worded
     * copy of it down here is how a strip and a panel start disagreeing. */
    steps.push({
      id: "running",
      kind: "think",
      phase: researchRunning ? "research" : "think",
      label:
        events.length === 0
          ? STEP_LABEL.waiting
          : researchRunning
            ? STEP_LABEL.researching
            : STEP_LABEL.thinking,
      detail: null,
      ms: null,
      running: true,
      failed: false,
    });
  }

  return steps;
}

/**
 * THE TICK — the one live signal, and the number the whole design stakes its
 * credibility on.
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
 * THE READING COLUMN — the one renderer for model-generated prose.
 *
 * Splits on the MODEL'S OWN blank lines and nothing else. `toReasoningLines` is
 * deliberately not used here: its `WRAP_AT = 170` is a display chunker for the
 * AIcss 40px slots, and at rest it would insert paragraph breaks the model never
 * wrote — structure invented by a layout constant.
 *
 * No clamp, no ellipsis, no max-height, no inner scroller. The panel's own
 * scroller bounds this; a scrollbar inside a scrollbar is the thing edge fades
 * are usually papering over.
 *
 * `content-visibility` because a deep-research trace can run to thousands of
 * words and the browser should not lay out what is not on screen.
 * ───────────────────────────────────────────────────────────────────────────── */
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
          // `text-body` and its own 1.6 leading. The 0.9375rem/1.72 this used to
          // hand-write was `text-body` spelled longhand with a made-up leading,
          // and it was the reason this surface shared a rhythm with nothing.
          className="whitespace-pre-wrap break-words font-sans text-body text-foreground/80"
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
 * `toSteps` returns null for every provider that streamed unbroken prose —
 * Anthropic, Zhipu, Mistral, Google — and for every message persisted before
 * parts were carried. Those runs render one `Full reasoning trace` step and say
 * so in its detail line. A two-option switch with one honest option would be an
 * invitation to a summary this app would then have to invent.
 *
 * The control is no longer a SegmentedControl floating beside a section
 * heading: it is a radio group inside the filter menu, because it is a view
 * preference over the spine rather than a control over one block.
 * ───────────────────────────────────────────────────────────────────────────── */
type ReasoningView = "summary" | "full";

const VIEW_KEY = "juno.reasoning-view";

/**
 * The reader's standing preference, not a per-message toggle.
 *
 * Someone who wants the raw trace wants it on the next message too. Read lazily
 * on mount rather than during render so the server-rendered markup and the
 * first client paint agree — reading `localStorage` in the initial state is a
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

const COPY_REVERT_MS = 1400;

/** How long a collapsing body stays mounted after its row closes — the
 *  grid-rows transition is `--dur-base` (220ms) and the node has to outlive it
 *  or the panel snaps shut instead of closing. */
const COLLAPSE_MS = 240;

/** The kinds the filter menu offers, in menu order, with their labels. `write`
 *  is absent on purpose: a run has exactly one, it is never the thing you are
 *  looking for, and an option that filters a list to one known row is a control
 *  that costs a press and returns nothing. */
const FILTER_KINDS: { kind: StepKind; label: string }[] = [
  { kind: "think", label: "Reasoning" },
  { kind: "tool", label: "Tools" },
  { kind: "source", label: "Sources" },
  { kind: "search", label: "Searches" },
  { kind: "notice", label: "Notices" },
];

/* Sentence case here, `uppercase` in the class list: the extractor should
 * carry words a translator can read, not a shout. */
/** What the row's copy button says it copies. Same extractor rule as
 *  STEP_LABEL: a ternary of literals never reaches the catalog. */
const COPY_TIP_LABEL = {
  tool: "Copy call",
  notice: "Copy notice",
  search: "Copy query",
  step: "Copy step",
} as const;

/** The header's one word. Same extractor rule as STEP_LABEL. */
const HEADER_LABEL = {
  researching: "Researching",
  thinking: "Thinking",
  writing: "Writing",
  done: "Done",
  stopped: "Stopped",
} as const;

const PHASE_LABEL: Record<PhaseKey, string> = {
  research: "Research",
  think: "Think",
  write: "Write",
};

/** The marker glyph for a kind. Monochrome, ALWAYS: the accent is state and
 *  only state (FLAT_UI §2.4), so a search row and a tool row differ by drawing,
 *  never by hue. Running and failed are the two states that colour anything. */
function StepMarker({ step }: { step: Step }) {
  if (step.kind === "source" && step.source) {
    return <SourceFavicon url={step.source.url} variant="cluster" />;
  }
  if (step.kind === "think") {
    return <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />;
  }
  const Glyph =
    step.kind === "search"
      ? ComposerIcons.web
      : step.kind === "tool"
        ? AppIcons.connections
        : step.kind === "memory"
          ? ComposerIcons.memory
          : step.kind === "notice"
            ? CodeIcons.error
            : AppIcons.artifacts;
  return <Glyph className="size-3" aria-hidden="true" />;
}

/** Case-insensitive plain substring — no regex, no fuzzy. A find in a run of
 *  connector output has to mean exactly what it says, or the count beside the
 *  field is a number about something else. */
function matches(step: Step, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  const body =
    step.body?.type === "prose"
      ? step.body.text
      : step.body?.type === "memory"
        ? step.body.memory.content
        : step.body?.type === "tool"
          ? `${step.body.tool.args ?? ""} ${step.body.tool.result ?? ""}`
          : "";
  return `${step.label} ${step.detail ?? ""} ${body}`.toLowerCase().includes(q);
}

/** The matched run of a label, wrapped. Only the visible label is marked — the
 *  body is behind a disclosure, and highlighting text nobody can see is a count
 *  with no referent. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-xs bg-primary/15 px-0.5 text-foreground">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

/**
 * DOCKED, NOT OVERLAID. This was a Radix <Sheet> — a modal dialog with a
 * backdrop that dimmed the chat, trapped focus and locked scroll. The chat is
 * the thing the user is reading; the panel is an annotation on it, so the panel
 * takes a column and the chat narrows beside it, exactly like CanvasPanel.
 *
 * THREE BLOCKS, ONE ROW RECIPE, ONE LIVE SIGNAL.
 *
 *   RECAP    what is happening / what happened — fixed height, never reflows
 *   SPINE    every step, chronological, one recipe — the body
 *   DETAILS  model, effort, context, cost, memory — one disclosure, closed
 *
 * What this replaced was a warning list, three three-column ledgers, a link
 * list, a disclosure list and a prose column, stacked under hairlines with the
 * MODEL'S NAME as the heading — a receipt printed as a form. A person watching
 * an answer being written has one question, and it is answered in time order.
 */
export function ThoughtProcessPanel({
  id,
  messageId,
  onClose,
  run,
  reasoning,
  streaming,
  live,
  finishNote,
}: {
  /** DOM id, so the trigger's aria-controls points at something real. */
  id: string;
  /** The message this run belongs to — the scope for a jump to a citation. */
  messageId: string;
  onClose: () => void;
  /** Built ONCE by the caller, from the caller's clock. The panel deliberately
   *  owns no clock: the collapsed row and the panel opened from it must be
   *  incapable of disagreeing, and the only way to guarantee that is for there
   *  to be one number, not two agreeing ones. See useRunClock. */
  run: RunModel;
  reasoning?: string | null;
  streaming?: boolean;
  /** The strip's current sentence, computed by `liveCopy` in ActivityTimeline
   *  and handed down for exactly the reason `run` is: one value, one call site,
   *  so the strip and the panel CANNOT drift. */
  live?: LiveCopy;
  /** The finish-reason sentence, already resolved by message-item. Threaded
   *  down rather than re-derived: `finishReason` lives on the message, not in
   *  the run's event stream, and there must be exactly one wording of it. */
  finishNote?: string | null;
}) {
  const rootRef = React.useRef<HTMLElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const findRef = React.useRef<HTMLInputElement>(null);
  const panel = useThoughtPanel();
  const seedDraft = panel?.seedDraft;

  const [view, setView] = useReasoningView();
  const [detailsOpen, setDetailsOpen] = React.useState(false);

  /**
   * WHICH ROWS ARE OPEN — per row, local, and deliberately not persisted.
   *
   * Unlike Summary/Full, which is a standing reading preference, "which call
   * did I want to look inside" is a question about one run and one moment.
   * Persisting it would reopen a stranger's payload on the next message that
   * happened to reuse a row id. All closed by default, all of them.
   *
   * `mounted` trails `open` by one transition: the grid-rows collapse needs the
   * node to still exist while it animates to 0fr, and `aria-controls` must
   * point only at something in the document.
   */
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [mounted, setMounted] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const collapseTimers = React.useRef(new Map<string, number>());

  /* Deliberately NOT a side effect inside a setState updater: React invokes an
   * updater twice under StrictMode, which would arm two collapse timers and
   * leave one of them unclearable in the map. The decision is made here, once,
   * from the state we can already see. */
  const toggleStep = React.useCallback(
    (rowId: string) => {
      const pending = collapseTimers.current.get(rowId);
      if (pending) {
        window.clearTimeout(pending);
        collapseTimers.current.delete(rowId);
      }
      if (open.has(rowId)) {
        setOpen((prev) => {
          const next = new Set(prev);
          next.delete(rowId);
          return next;
        });
        const t = window.setTimeout(() => {
          setMounted((m) => {
            const n = new Set(m);
            n.delete(rowId);
            return n;
          });
          collapseTimers.current.delete(rowId);
        }, COLLAPSE_MS);
        collapseTimers.current.set(rowId, t);
        return;
      }
      // Mounted and opened in the SAME commit. The collapse wrapper is always in
      // the DOM at `grid-rows-[0fr]`, so the class flip transitions; mounting
      // the wrapper itself here would give it nothing to animate from.
      setMounted((m) => new Set([...m, rowId]));
      setOpen((prev) => new Set([...prev, rowId]));
    },
    [open],
  );

  React.useEffect(() => {
    const timers = collapseTimers.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  /* Filter and find are PER-RUN AND TRANSIENT, for the same reason `open` is:
   * which slice of one run you wanted is not a standing preference. */
  const [kinds, setKinds] = React.useState<ReadonlySet<StepKind>>(() => new Set<StepKind>());
  const [findOpen, setFindOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const [copied, setCopied] = React.useState<string | null>(null);
  const copyTimer = React.useRef<number | null>(null);

  // A receipt is not only an explanation — it is a direct control surface for
  // the exact facts this turn used. Forgetting writes the durable suppression
  // through the same authenticated memory route as the Memory page, then hides
  // only the local receipt row; the persisted chat remains an honest historical
  // record of what the model saw.
  const [forgotten, setForgotten] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [forgetting, setForgetting] = React.useState<string | null>(null);
  const [memoryError, setMemoryError] = React.useState<Record<string, string>>({});
  const forgetMemory = React.useCallback(async (memoryId: string) => {
    setForgetting(memoryId);
    setMemoryError((prev) => {
      const next = { ...prev };
      delete next[memoryId];
      return next;
    });
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forget: true }),
      });
      if (!response.ok) throw new Error("Couldn’t forget that memory.");
      setForgotten((previous) => new Set([...previous, memoryId]));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn’t forget that memory.";
      setMemoryError((prev) => ({ ...prev, [memoryId]: message }));
    } finally {
      setForgetting(null);
    }
  }, []);

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

  /**
   * ONE GESTURE, ONE BEHAVIOUR, PRODUCT-WIDE.
   *
   * This used to catch and `return` — no toast, no receipt, nothing at all —
   * while `AicssCodeBlock` five hundred lines below it raised a toast for the
   * identical failure. The panel had decided that saying "Copied" falsely was a
   * lie, which is right, and then shipped saying nothing, which is worse. The
   * success receipt is the glyph swap on the button; the failure is the same
   * toast the code block already uses.
   */
  const copy = React.useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error("Couldn’t copy to the clipboard.");
      return;
    }
    setCopied(key);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), COPY_REVERT_MS);
  }, []);

  const factOf = (label: string) => run.facts.find((f) => f.label === label)?.value ?? null;
  const costValue = factOf("Cost");

  /**
   * THE COST FIGURE, AND ITS ONE FAILURE MODE.
   *
   * `chat-usage.ts` joins the whole usage breakdown into one prose string and
   * throws the structure away, so the money has to be read back out of it. The
   * rule is: lift the currency token with one anchored match and degrade to a
   * stated row — the producer's whole string, verbatim, inside Details — never
   * to a partial or reconstructed number. See `splitCost`.
   */
  const { money, billed } = splitCost(costValue);

  const warnings = run.calls.filter((c) => c.warn);

  /* THE SPINE. Memory receipts are steps too — they just live in Details rather
   * than in the spine, because they are INPUTS to the run, not events in it. */
  const allSteps = React.useMemo(() => {
    const steps = run.steps.filter((s) => !(s.kind === "memory"));
    if (view !== "full") return steps;
    /* FULL TRACE. The per-part steps collapse into ONE step holding the flat
     * reasoning string. Not a second list rendered beside the first: the two
     * views are the same information at two grains, and showing both is the
     * "rendered twice" failure this rewrite exists to end. */
    const trace = reasoning?.trim();
    if (!trace) return steps;
    const out: Step[] = [];
    let inserted = false;
    for (const s of steps) {
      if (s.kind !== "think" || s.running) {
        out.push(s);
        continue;
      }
      if (inserted) continue;
      inserted = true;
      out.push({
        id: "reason-full",
        kind: "think",
        phase: "think",
        label: STEP_LABEL.fullTrace,
        detail: null,
        ms: null,
        running: false,
        failed: false,
        body: { type: "prose", text: trace },
      });
    }
    return out;
  }, [run.steps, view, reasoning]);

  const memorySteps = React.useMemo(
    () => run.steps.filter((s) => s.kind === "memory" && !forgotten.has(s.body?.type === "memory" ? s.body.memory.id : "")),
    [run.steps, forgotten],
  );

  const counts = React.useMemo(() => {
    const map = new Map<StepKind, number>();
    for (const s of allSteps) map.set(s.kind, (map.get(s.kind) ?? 0) + 1);
    return map;
  }, [allSteps]);

  const filtering = kinds.size > 0 || query.length > 0;
  const visible = React.useMemo(
    () => allSteps.filter((s) => (kinds.size === 0 || kinds.has(s.kind)) && matches(s, query)),
    [allSteps, kinds, query],
  );

  const sections = React.useMemo(() => {
    const order: PhaseKey[] = ["research", "think", "write"];
    return order
      .map((key) => ({ key, steps: visible.filter((s) => s.phase === key) }))
      .filter((s) => s.steps.length > 0);
  }, [visible]);

  const toolsMissingDetail = allSteps.some((s) => s.kind === "tool" && !s.body);

  /* ── AUTO-FOLLOW ─────────────────────────────────────────────────────────
   * While streaming the scroller sticks to the bottom. Scroll up more than
   * 24px and following stops — the reader is reading something, and yanking
   * them back to the newest row is the panel arguing with them. The Live pill
   * is how they get back. */
  const [following, setFollowing] = React.useState(true);
  const onScroll = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    setFollowing(atBottom);
  }, []);

  const reduced = React.useRef(false);
  React.useEffect(() => {
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  const scrollToBottom = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced.current ? "auto" : "smooth" });
  }, []);

  const stepCount = visible.length;
  React.useEffect(() => {
    if (!streaming || !following) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streaming, following, stepCount]);

  /* ── THE ROW KEYBOARD ────────────────────────────────────────────────────
   * Scoped to the scroller, never to the window: at `lg` the chat stays
   * typeable beside this dock, so a global `j` would eat a letter out of the
   * composer. Bound here it can only fire when focus is already inside the
   * spine, and it stands down for any field that takes text. */
  const onSpineKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    const keys = ["ArrowDown", "ArrowUp", "j", "k", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const rows = Array.from(
      scrollerRef.current?.querySelectorAll<HTMLElement>("[data-step-row]") ?? [],
    );
    if (rows.length === 0) return;
    const current = rows.findIndex((r) => r === target || r.contains(target));
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "ArrowDown" || e.key === "j") next = Math.min(rows.length - 1, current + 1);
    else next = current <= 0 ? 0 : current - 1;
    e.preventDefault();
    rows[next]?.focus();
    rows[next]?.scrollIntoView({ block: "nearest" });
  }, []);

  /* ── JUMP TO SOURCE ──────────────────────────────────────────────────────
   * The chip only exists once the answer has rendered, and the model routinely
   * writes fewer brackets than it was handed sources. Both misses land on the
   * same fallback — open the URL — and neither says anything: a toast reading
   * "that source is not cited" is a lecture about the model's behaviour
   * delivered to the person who clicked. */
  const jumpToCitation = React.useCallback(
    (citeIndex: number, url: string) => {
      const onPhone = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
      const el = document.querySelector<HTMLElement>(
        `[data-juno-message="${CSS.escape(messageId)}"] [data-cite="${citeIndex}"]`,
      );
      if (!el) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // Below lg the dock covers the chat, so a jump has to give it back first.
      if (onPhone) onClose();
      window.requestAnimationFrame(() => {
        el.scrollIntoView({ block: "center", behavior: reduced.current ? "auto" : "smooth" });
        el.classList.add("animate-cite-flash");
        el.addEventListener("animationend", () => el.classList.remove("animate-cite-flash"), { once: true });
      });
    },
    [messageId, onClose],
  );

  /* ── ASK TO RUN AGAIN ────────────────────────────────────────────────────
   * Juno cannot dispatch a connector from the client, so the verb is honest: it
   * seeds the composer and the person presses send. And it is offered ONLY on a
   * call that failed or never returned — re-running a successful `create_issue`
   * files a duplicate ticket, and an action button that does damage on a
   * misclick is worse than a missing feature. */
  const rerunnable = (step: Step) =>
    !!seedDraft &&
    step.body?.type === "tool" &&
    !!step.body.tool.args &&
    (step.body.tool.status === "failed" || step.body.tool.resultNote === "unfinished");

  const askToRunAgain = React.useCallback(
    (tool: ClientToolDetail) => {
      if (!seedDraft) return;
      const fence = "`".repeat(Math.max(3, ...(tool.args?.match(/`+/g) ?? [""]).map((r) => r.length + 1)));
      seedDraft(
        `Run \`${tool.name}\` on ${tool.server} again with the same arguments:\n\n${fence}json\n${tool.args}\n${fence}`,
      );
    },
    [seedDraft],
  );

  /* ── HEADER STATE ────────────────────────────────────────────────────────
   * One word, and the clock beside it. The panel used to be titled with the
   * MODEL'S NAME — a fact that belongs in Details — while the actual state was
   * a 12px mono eyebrow above it. */
  const activeKey = run.phases.find((p) => p.active)?.key;
  const statusWord = streaming
    ? activeKey === "research"
      ? HEADER_LABEL.researching
      : activeKey === "write"
        ? HEADER_LABEL.writing
        : HEADER_LABEL.thinking
    : run.stopped
      ? HEADER_LABEL.stopped
      : HEADER_LABEL.done;

  const summary = React.useMemo(() => toRunSummary(run, finishNote), [run, finishNote]);
  const recapSentence = streaming ? (live?.message ?? "Thinking about your request") : summary;

  const toolCalls = run.calls.filter((c) => !c.warn).length;
  const figureThird = run.sourceCount > 0 || toolCalls === 0
    ? { value: String(run.sourceCount), caption: "Sources" }
    : { value: String(toolCalls), caption: "Tool calls" };

  /**
   * ONE ANNOUNCER, RUN-LEVEL ONLY.
   *
   * The scroller is `aria-live="off"` and every mutating row inside it is
   * therefore silent, because this panel is portalled into chat-view's dock —
   * outside message-item's polite region — and its figures rewrite once a
   * second. What a screen reader needs from a run is three or four events, not
   * three hundred: which phase it is in, and how it ended. Spoken duration uses
   * `speakSpan`, not `formatSpan`'s glyph.
   */
  const announceTarget = streaming
    ? statusWord
    : [summary, run.elapsedMs === null ? null : speakSpan(run.elapsedMs)].filter(Boolean).join(" ");
  const [announcement, setAnnouncement] = React.useState("");
  React.useEffect(() => {
    const t = window.setTimeout(() => setAnnouncement(announceTarget), 500);
    return () => window.clearTimeout(t);
  }, [announceTarget]);

  const detailRows = React.useMemo(() => {
    const rows = run.facts.filter((f) => f.label !== "Cost");
    if (billed) rows.push({ label: "Billed", value: billed });
    // When the money could not be lifted, the producer's whole usage string
    // joins Details verbatim rather than vanishing.
    if (money === null && costValue) rows.push({ label: "Cost", value: costValue });
    return rows;
  }, [run.facts, billed, money, costValue]);

  const setKind = (kind: StepKind, on: boolean) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  return (
    <aside
      id={id}
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      className="flex size-full flex-col bg-card focus:outline-none"
    >
      {/* ── HEADER — one row, 48px, Claude's footer geometry ──────────────── */}
      {/* `min-h-12`, not `h-12`: `pt-safe` pads INTO a fixed height, so on a
          phone where this dock is the topmost surface the notch would have
          eaten the header's content rather than sitting above it. */}
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 pl-3 pr-2 pt-safe">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Below lg this dock covers the chat entirely, so the close control
              has to read as a way BACK rather than as a dismissal. */}
          <Pressable kind="icon" size="md" onClick={onClose} className="-ml-1 lg:hidden">
            <ChevronLeft className="size-4" aria-hidden="true" />
            <span className="sr-only">Back to chat</span>
          </Pressable>

          {/* THE ONE LOOP IN THIS PANEL. Everything else that used to move —
              a shimmering sentence, a crossfading eyebrow, a second 1Hz clock,
              a translating trace viewport — is gone. The resting mark occupies
              the same 16px box so the title never shifts between states. */}
          <span className="hidden w-4 shrink-0 items-center justify-center lg:flex">
            {streaming ? (
              <ThinkingDots className="text-muted-foreground/70" />
            ) : (
              <span className="size-1.5 rounded-full bg-muted-foreground/45" aria-hidden="true" />
            )}
          </span>

          <h2 id={`${id}-title`} className="min-w-0 truncate text-ui font-medium text-foreground">
            <span className="sr-only">Thought process — </span>
            {statusWord}
          </h2>
          {run.elapsedMs !== null && (
            <span className="shrink-0 font-mono text-ui tabular-nums text-muted-foreground">
              · {formatSpan(run.elapsedMs, { live: streaming })}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Pressable kind="icon" size="md" selected={filtering} aria-label="Filter steps">
                    <ActionIcons.filter className="size-4" aria-hidden="true" />
                  </Pressable>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Filter steps</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-[14rem]">
              <DropdownMenuItem
                onSelect={() => {
                  setFindOpen(true);
                  window.setTimeout(() => findRef.current?.focus(), 0);
                }}
              >
                Find in this run
                <AppIcons.search className="ml-auto text-muted-foreground" aria-hidden="true" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={kinds.size === 0} onCheckedChange={() => setKinds(new Set())}>
                All steps
              </DropdownMenuCheckboxItem>
              {/* A kind with no steps is OMITTED, not disabled: a greyed row
                  that can never be pressed is a promise the run did not keep. */}
              {FILTER_KINDS.filter((f) => (counts.get(f.kind) ?? 0) > 0).map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.kind}
                  checked={kinds.has(f.kind)}
                  onCheckedChange={(on) => setKind(f.kind, on === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {f.label}
                  <span className="ml-auto pl-4 font-mono text-micro tabular-nums text-muted-foreground">
                    {counts.get(f.kind)}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
              {!streaming && !!reasoning?.trim() && (counts.get("think") ?? 0) > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={view} onValueChange={(v) => setView(v as ReasoningView)}>
                    <DropdownMenuRadioItem value="summary">Summary</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="full">Full trace</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const openable = visible.filter((s) => s.body);
                  setMounted(new Set(openable.map((s) => s.id)));
                  setOpen(new Set(openable.map((s) => s.id)));
                }}
              >
                Expand all
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setOpen(new Set());
                  window.setTimeout(() => setMounted(new Set()), COLLAPSE_MS);
                }}
              >
                Collapse all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Pressable kind="icon" size="md" aria-label="Copy">
                    <ActionIcons.copy className="size-4" aria-hidden="true" />
                  </Pressable>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={6}>
              <DropdownMenuItem onSelect={() => void copy("summary", summary)}>Copy summary</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy("run", toRunMarkdown(run, reasoning, finishNote))}>
                Copy run
              </DropdownMenuItem>
              {run.sources.length > 0 && (
                <DropdownMenuItem onSelect={() => void copy("sources", toSourcesMarkdown(run))}>
                  Copy sources
                </DropdownMenuItem>
              )}
              {filtering && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void copy("visible", toVisibleStepsMarkdown(visible))}>
                    Copy visible steps
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Pressable kind="icon" size="md" onClick={onClose} className="hidden lg:inline-flex" aria-label="Close">
                <ActionIcons.dismiss className="size-4" aria-hidden="true" />
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {findOpen && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <input
            ref={findRef}
            type="search"
            value={query}
            placeholder="Find in this run"
            aria-label="Find in this run"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              /* Esc clears the field first. A field with text in it is work the
                 reader did; destroying the whole panel on the key they reach
                 for to undo a typo is the panel punishing them for using it.
                 The second press closes the find bar; a third reaches
                 chat-view and closes the dock. */
              e.preventDefault();
              if (query) setQuery("");
              else setFindOpen(false);
            }}
            /* The native search decoration is suppressed, not styled: Chrome
               draws its own blue clear cross, which landed two pixels from this
               bar's own dismiss control — two clear buttons for one field, one
               of them in a colour that appears nowhere else in the product. */
            className="w-full min-w-0 bg-transparent text-ui text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">
            {query ? (visible.length ? `${visible.length} of ${allSteps.length}` : "No matches") : ""}
          </span>
          <Pressable
            kind="icon"
            size="sm"
            className="size-6 shrink-0"
            onClick={() => {
              setQuery("");
              setFindOpen(false);
            }}
            aria-label="Close find"
          >
            <ActionIcons.dismiss className="size-3.5" aria-hidden="true" />
          </Pressable>
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          onKeyDown={onSpineKeyDown}
          aria-live="off"
          className="size-full overflow-y-auto overscroll-contain px-3 pb-8 pt-0"
        >
          {/* ── RECAP — fixed height, no reflow on settle ─────────────────── */}
          <div className="border-b border-border/60 px-0 pb-4 pt-3">
            {/* `min-h` holds two lines at text-body's leading so the box never
                changes height when the sentence does. Keyed on `streaming` so
                the swap is a crossfade rather than a rewrite. */}
            <p
              key={streaming ? "live" : "done"}
              className="min-h-[2.6rem] text-body text-foreground/85 motion-safe:animate-fade-in"
            >
              {recapSentence}
            </p>

            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-body-lg tabular-nums text-foreground">
                  {run.elapsedMs === null ? "—" : formatSpan(run.elapsedMs, { live: streaming })}
                </div>
                <div className="mt-0.5 truncate font-mono text-micro uppercase text-muted-foreground">Elapsed</div>
              </div>
              <div className="min-w-0">
                {/* THE ONE PLACE THIS PANEL PRINTS A PLACEHOLDER, and it is
                    correct here precisely because the box is reserved: the
                    alternative is a figure row that grows a third column when
                    `usage` lands, which is the reflow the old design spent a
                    comment defending. */}
                <div
                  className={cn(
                    "truncate font-mono text-body-lg tabular-nums",
                    money ? "text-foreground" : "text-muted-foreground/60",
                  )}
                >
                  {money ?? "—"}
                </div>
                <div className="mt-0.5 truncate font-mono text-micro uppercase text-muted-foreground">Cost</div>
              </div>
              <div className="min-w-0">
                <div className="truncate font-mono text-body-lg tabular-nums text-foreground">{figureThird.value}</div>
                <div className="mt-0.5 truncate font-mono text-micro uppercase text-muted-foreground">
                  {figureThird.caption}
                </div>
              </div>
            </div>

            {/* NOTICE — absent when the run was clean. There is no "no
                warnings" state: its absence is the signal.

                The dark tint is separated out. --warning is a 58%-lightness
                fill in dark, so 5% of it over the --card panel is a 2.6-point
                step — the one block that has to be noticed was the quietest
                thing in the panel. 5% is still right over light paper. */}
            {(warnings.length > 0 || !!finishNote) && (
              <section
                aria-labelledby={`${id}-notice`}
                className="-mx-3 mt-3 border-l-2 border-warning/35 bg-warning/5 px-3 py-2 dark:bg-warning/10"
              >
                <h3 id={`${id}-notice`} className="font-mono text-micro uppercase text-warning">
                  Notice
                </h3>
                <ul className="mt-1 space-y-1">
                  {warnings.map((c) => (
                    <li key={c.id} className="break-words text-ui text-warning">
                      {c.object}
                    </li>
                  ))}
                  {finishNote && <li className="break-words text-ui text-warning">{finishNote}</li>}
                </ul>
              </section>
            )}
          </div>

          {/* ── SPINE ─────────────────────────────────────────────────────── */}
          {sections.length === 0 ? (
            <EmptyState
              tone="empty"
              size="panel"
              title="No steps of that kind"
              description="Nothing in this run matches the current filter."
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setKinds(new Set());
                    setQuery("");
                  }}
                >
                  Show all steps
                </Button>
              }
              className="mt-6"
            />
          ) : (
            sections.map((section) => (
              <section key={section.key} aria-labelledby={`${id}-phase-${section.key}`}>
                {/* `sticky` gives the reader orientation in a sixty-row list
                    without a second navigation. `text-micro`, not `text-label`:
                    a separator inside a dense list is a waypoint, not an
                    eyebrow. */}
                <h3
                  id={`${id}-phase-${section.key}`}
                  className="sticky top-0 z-10 -mx-3 flex items-baseline justify-between gap-2 bg-card px-3 pb-1.5 pt-4 font-mono text-micro uppercase text-muted-foreground"
                >
                  <span>{PHASE_LABEL[section.key]}</span>
                  <span className="tabular-nums text-muted-foreground/70">
                    {plural(section.steps.length, "step")}
                  </span>
                </h3>
                {section.key === "think" && toolsMissingDetail && (
                  <p className="mb-1 text-caption text-muted-foreground">{TOOLS_NO_DETAIL_NOTE}</p>
                )}
                {/* The hairline spine. 10px is the centre of the 20px marker
                    column, which sits flush with the scroller's px-3. */}
                <ol className="relative before:absolute before:inset-y-1 before:left-[0.625rem] before:w-px before:bg-border before:content-['']">
                  {section.steps.map((step, i) => (
                    <StepRow
                      key={step.id}
                      id={id}
                      step={step}
                      index={i}
                      query={query}
                      streaming={!!streaming}
                      expanded={open.has(step.id)}
                      mounted={mounted.has(step.id)}
                      copied={copied === step.id}
                      onToggle={() => toggleStep(step.id)}
                      onCopy={() => void copy(step.id, toStepMarkdown(step))}
                      onJump={jumpToCitation}
                      rerunnable={rerunnable(step)}
                      onRerun={askToRunAgain}
                    />
                  ))}
                </ol>
              </section>
            ))
          )}

          {/* ── DETAILS — one disclosure, closed ──────────────────────────── */}
          {(detailRows.length > 0 || memorySteps.length > 0) && (
            <div className="mt-6 border-t border-border/60 pt-3">
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? `${id}-details` : undefined}
                className="pressable flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                    detailsOpen && "rotate-90",
                  )}
                />
                Details
              </button>
              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
                  detailsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  {detailsOpen && (
                    <div id={`${id}-details`}>
                      {detailRows.length > 0 && (
                        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-2 pt-2">
                          {detailRows.map((f) => (
                            <React.Fragment key={f.label}>
                              <dt className="text-ui text-muted-foreground">{f.label}</dt>
                              <dd className="min-w-0 break-words text-ui text-foreground/80">{f.value}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      )}
                      {memorySteps.length > 0 && (
                        <>
                          <h4 className="mt-4 px-2 font-mono text-micro uppercase text-muted-foreground">
                            Memory used
                          </h4>
                          <ol className="relative mt-1">
                            {memorySteps.map((step, i) => (
                              <StepRow
                                key={step.id}
                                id={id}
                                step={step}
                                index={i}
                                query=""
                                streaming={!!streaming}
                                expanded={open.has(step.id)}
                                mounted={mounted.has(step.id)}
                                copied={copied === step.id}
                                onToggle={() => toggleStep(step.id)}
                                onCopy={() => void copy(step.id, toStepMarkdown(step))}
                                onJump={jumpToCitation}
                                rerunnable={false}
                                onRerun={askToRunAgain}
                                memory={{
                                  forgetting: forgetting === (step.body?.type === "memory" ? step.body.memory.id : ""),
                                  error:
                                    memoryError[step.body?.type === "memory" ? step.body.memory.id : ""] ?? null,
                                  onForget: forgetMemory,
                                }}
                              />
                            ))}
                          </ol>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* The home indicator's ground, as its own box. `pb-safe` SETS
              padding-bottom rather than adding to it, so putting it on the
              scroller beside `pb-8` would have silently deleted the 32px tail
              on every desktop, where the safe area is 0. */}
          <div className="pb-safe" aria-hidden="true" />
        </div>

        {/* The panel's ONLY floating element besides its two menus — a layer
            that leaves the page, which is the one tier the brief grants a
            throw. It exists because auto-follow has to be escapable AND
            resumable; a scroller that silently stops following is a feature
            the reader cannot get back. */}
        {streaming && !following && (
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 z-popper inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-popover px-3 py-1 text-caption text-foreground shadow-float motion-safe:animate-pop-in"
          >
            <ChevronDown className="size-3" aria-hidden="true" />
            Live
          </button>
        )}
      </div>
    </aside>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE ROW. One recipe, every kind.
 *
 *   col 1  marker   20px, the spine hairline runs through it
 *   col 2  label    text-ui, and an optional detail line at text-caption
 *   col 3  figure   mono tabular-nums — ONLY where a duration was measured
 *   col 4  action   28px, one verb, revealed on hover and on focus-within
 *
 * The kind changes the marker glyph and the verb. It changes nothing else, and
 * that is the whole design: six shapes in one column is why nothing here used
 * to read as a set.
 * ───────────────────────────────────────────────────────────────────────────── */
function StepRow({
  id,
  step,
  index,
  query,
  streaming,
  expanded,
  mounted,
  copied,
  onToggle,
  onCopy,
  onJump,
  rerunnable,
  onRerun,
  memory,
}: {
  id: string;
  step: Step;
  index: number;
  query: string;
  streaming: boolean;
  expanded: boolean;
  mounted: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onJump: (citeIndex: number, url: string) => void;
  rerunnable: boolean;
  onRerun: (tool: ClientToolDetail) => void;
  memory?: { forgetting: boolean; error: string | null; onForget: (id: string) => Promise<void> };
}) {
  const bodyId = `${id}-body-${step.id}`;
  const openable = !!step.body;
  const linkable = step.kind === "source" && !!step.source && isRenderableSourceUrl(step.source.url);

  const row = cn(
    "relative grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_1.75rem] items-start gap-x-2.5",
    "min-h-8 rounded-control px-0 py-1.5 text-left coarse:min-h-11",
    "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
    (openable || linkable) && "pressable motion-reduce:active:scale-100",
    expanded && "bg-secondary hover:bg-secondary",
  );

  const marker = (
    <span
      className={cn(
        "col-start-1 row-start-1 flex size-5 items-center justify-center rounded-full ring-4 ring-card",
        step.running
          ? "text-primary ring-2 ring-primary/35"
          : step.failed
            ? "text-warning"
            : "text-muted-foreground/70",
        expanded && "ring-secondary",
      )}
    >
      <StepMarker step={step} />
    </span>
  );

  const label = (
    <span
      className={cn(
        "col-start-2 row-start-1 flex min-w-0 items-baseline gap-1.5 truncate text-ui",
        step.running ? "font-medium text-foreground" : step.failed ? "text-warning" : "text-foreground/85",
      )}
    >
      {openable && (
        // `ease-in-out`, not `ease-out-soft`: both endpoints of a rotation are
        // on screen, so the curve is symmetric (motion.ts — transition.symmetric).
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 translate-y-px text-muted-foreground/50 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      )}
      <span className="min-w-0 truncate">
        <Highlight text={step.label} query={query} />
      </span>
    </span>
  );

  const detail = step.detail ? (
    <span className="col-start-2 row-start-2 mt-0.5 min-w-0 truncate text-caption text-muted-foreground">
      <Highlight text={step.detail} query={query} />
    </span>
  ) : null;

  /* Column three holds BOTH, in that order, because they answer different
   * questions: `failed` is how the call ended, the figure is how long it took,
   * and a call can have measured 30s and still have failed. Wrapped in one flex
   * cell rather than two grid cells so the pair stays one right-aligned block. */
  const figure = (
    <span className="col-start-3 row-start-1 flex shrink-0 items-baseline gap-2 pt-px">
      {step.failed && step.kind === "tool" && (
        <span className="font-mono text-micro uppercase text-warning/80">failed</span>
      )}
      {step.ms !== null && (
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {/* The bare number in column three is a duration, and the visual
              column header a sighted reader infers it from does not exist for
              anyone else. */}
          <span className="sr-only">took </span>
          {formatSpan(step.ms)}
        </span>
      )}
    </span>
  );

  const inner = (
    <>
      {marker}
      {label}
      {detail}
      {figure}
    </>
  );

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /* ONE VERB PER ROW, chosen by kind. Always in the DOM so nothing reflows when
   * the pointer arrives, and pinned visible for the length of a copy receipt so
   * the confirmation survives the pointer leaving. */
  const action = (() => {
    if (step.kind === "source" && step.source) {
      const { citeIndex, url, domain } = step.source;
      if (citeIndex !== null) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Pressable
                kind="icon"
                size="sm"
                className="size-7"
                onClick={(e) => {
                  stop(e);
                  onJump(citeIndex, url);
                }}
                aria-label={`Jump to citation ${citeIndex}`}
              >
                <span className="flex size-5 items-center justify-center rounded-xs border border-border font-mono text-micro tabular-nums text-muted-foreground">
                  {citeIndex}
                </span>
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="left">Jump to citation {citeIndex}</TooltipContent>
          </Tooltip>
        );
      }
      if (!isRenderableSourceUrl(url)) return null;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Pressable
              kind="icon"
              size="sm"
              className="size-7"
              onClick={(e) => {
                stop(e);
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              aria-label={`Open ${domain}`}
            >
              <ActionIcons.external className="size-3.5" aria-hidden="true" />
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="left">Open {domain}</TooltipContent>
        </Tooltip>
      );
    }

    if (rerunnable && step.body?.type === "tool") {
      const tool = step.body.tool;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Pressable
              kind="icon"
              size="sm"
              className="size-7"
              onClick={(e) => {
                stop(e);
                onRerun(tool);
              }}
              aria-label="Ask to run again"
            >
              <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="left">Ask to run again</TooltipContent>
        </Tooltip>
      );
    }

    const tip = COPY_TIP_LABEL[step.kind === "tool" || step.kind === "notice" || step.kind === "search" ? step.kind : "step"];
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable
            kind="icon"
            size="sm"
            className="size-7"
            onClick={(e) => {
              stop(e);
              onCopy();
            }}
            aria-label={copied ? "Copied" : tip}
          >
            {copied ? (
              <StatusIcons.success className="size-3.5 motion-safe:animate-check-morph" aria-hidden="true" />
            ) : (
              <ActionIcons.copy className="size-3.5" aria-hidden="true" />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="left">{tip}</TooltipContent>
      </Tooltip>
    );
  })();

  return (
    <li
      // `group/step` sits HERE and not on the row, because the action is the
      // row's SIBLING: a group only reaches its descendants, so with the name on
      // the row the hover reveal never fired and the verb was unreachable by
      // pointer or by keyboard.
      //
      // `relative` is load-bearing, not tidiness: the hover action is an
      // absolutely-positioned SIBLING of the row (a button cannot be nested
      // inside a button), so without a containing block here every row's action
      // resolves against the <ol> and all of them stack in one corner.
      //
      // A new step fades up ONCE, on the first paint of its id. A settled panel
      // staggers its rows in on the tight rung; a live one does not, because a
      // row arriving mid-stream is one row, not a list.
      className={cn(
        "group/step relative",
        !streaming && "motion-safe:animate-fade-in-up [animation-fill-mode:backwards]",
      )}
      style={streaming ? undefined : staggerDelay(index, "tight")}
    >
      {openable ? (
        <button
          type="button"
          data-step-row
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={mounted ? bodyId : undefined}
          className={row}
        >
          {inner}
        </button>
      ) : linkable && step.source ? (
        <a
          data-step-row
          href={step.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className={row}
        >
          {inner}
        </a>
      ) : (
        // No payload behind it, so no control over it — and a URL that fails
        // the renderable guard never becomes an anchor. A button that opens an
        // explanation of its own emptiness costs the reader a click and
        // returns nothing.
        <div data-step-row tabIndex={-1} className={cn(row, "cursor-default")}>
          {inner}
        </div>
      )}

      {/* The action column is fixed-width and always present, so revealing it
          moves nothing. `group-focus-within` is not decoration: it is the only
          way a keyboard reaches it. */}
      {action && (
        <div
          className={cn(
            "pointer-events-none absolute right-0 top-0.5 flex w-7 justify-center opacity-0 transition-opacity duration-fast ease-out-soft group-hover/step:pointer-events-auto group-hover/step:opacity-100 group-focus-within/step:pointer-events-auto group-focus-within/step:opacity-100 motion-reduce:transition-none coarse:pointer-events-auto coarse:opacity-100",
            copied && "pointer-events-auto opacity-100",
          )}
        >
          {action}
        </div>
      )}

      <div
        className={cn(
          "col-start-2 grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {mounted && step.body && (
            <div id={bodyId} className="pb-2 pl-[1.875rem] pr-1">
              {step.body.type === "prose" && <Prose text={step.body.text} className="pt-1" />}

              {step.body.type === "tool" && (
                <ToolBody tool={step.body.tool} rerunnable={rerunnable} onRerun={onRerun} onCopy={onCopy} />
              )}

              {step.body.type === "memory" && memory && (
                <MemoryBody memory={step.body.memory} state={memory} />
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ToolBody({
  tool,
  rerunnable,
  onRerun,
  onCopy,
}: {
  tool: ClientToolDetail;
  rerunnable: boolean;
  onRerun: (tool: ClientToolDetail) => void;
  onCopy: () => void;
}) {
  return (
    <>
      {/* `code` only, never `lines`: `lines` is for callers that already ran
          rehype-highlight, and tokenising untrusted connector output to colour
          it spends real client time for a decorative payoff.

          Nothing here parses or re-formats either payload. Arguments arrive
          pretty-printed; a result arrives pretty-printed only if the server
          found the WHOLE body to be JSON — a judgement only the server can
          make, because the client holds a possibly truncated head. */}
      {tool.args ? (
        <AicssCodeBlock
          label={toolArgsLabel(tool)}
          code={tool.args}
          maxBodyHeight={220}
          // A deliberate override of `.aicss-cb`'s own fill: the class paints
          // --card, this panel is --card, so the block was the same colour as
          // the sheet it lies on and only its 1px ring said otherwise.
          className="mt-1.5 bg-secondary"
        />
      ) : (
        // NEVER an empty code block. An empty box implies the model sent
        // nothing; the four reasons it might be missing are four different
        // facts and each gets its own sentence.
        <p className="mt-1.5 text-ui text-muted-foreground">{toolArgsNoteText(tool)}</p>
      )}

      {tool.result ? (
        <AicssCodeBlock
          label={toolResultLabel(tool)}
          code={tool.result}
          maxBodyHeight={320}
          className="mt-2.5 bg-secondary"
        />
      ) : (
        <p className="mt-2.5 text-ui text-muted-foreground">{toolResultNoteText(tool)}</p>
      )}

      {/* The caveat about what you are looking at, WHERE you are looking. It
          used to sit above a section of closed rows, which is an explanation
          for something nobody had opened yet. */}
      <p className="mt-2 text-caption text-muted-foreground">{TOOLS_DESCRIPTION}</p>

      {/* Quiet, because they annotate the payload above them rather than
          competing with it — the same `text-muted-foreground` the panel's old
          footer buttons carried, kept so the two reads as one family. */}
      <div className="mt-2.5 flex gap-1.5">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onCopy}>
          Copy step
        </Button>
        {rerunnable && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onRerun(tool)}>
            Ask to run again
          </Button>
        )}
      </div>
    </>
  );
}

function MemoryBody({
  memory,
  state,
}: {
  memory: ClientMemoryReceipt;
  state: { forgetting: boolean; error: string | null; onForget: (id: string) => Promise<void> };
}) {
  const sourceHref =
    memory.sourceRef && !["manual", "edit", "forget"].includes(memory.sourceRef) ? `/chat/${memory.sourceRef}` : null;
  return (
    <div className="pt-1">
      <p className="break-words text-ui text-foreground/85">{memory.content}</p>
      {state.error ? (
        // The current dead-end error — a bare red caption with no retry — gets
        // a way out. An error a reader cannot act on is a status light.
        <div className="mt-1.5">
          <p className="text-caption text-destructive">{state.error}</p>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => void state.onForget(memory.id)}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-caption text-muted-foreground">
          {sourceHref && (
            <a href={sourceHref} className="underline-offset-4 hover:text-foreground hover:underline">
              Open source chat
            </a>
          )}
          <button
            type="button"
            disabled={state.forgetting}
            onClick={() => void state.onForget(memory.id)}
            className="underline-offset-4 hover:text-destructive hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            {state.forgetting ? "Forgetting…" : "Forget this"}
          </button>
          <a href="/memory" className="underline-offset-4 hover:text-foreground hover:underline">
            Manage all
          </a>
        </div>
      )}
    </div>
  );
}
