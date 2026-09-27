"use client";

/**
 * THE RUN MODEL — what a turn did, as data.
 *
 * Split from the panel that draws it, and the split is a load-time decision
 * rather than a tidiness one. `ActivityTimeline` renders on every turn and
 * needs `buildRun` and `useRunClock` from here; `ThoughtProcessPanel` renders
 * only when a reader opens the dock. While both lived in one module the strip's
 * static import dragged 64 kB of panel into the first load of every
 * conversation, and making the panel a dynamic import bought nothing, because
 * the module was already in the chunk.
 *
 * The rule this file leaves behind: anything ActivityTimeline needs lives here;
 * anything only the open panel needs lives in thought-process-panel.tsx. If a
 * helper migrates back across that line, the split silently stops working —
 * check the chunk, not the diff.
 */

import * as React from "react";
import type { WebSearchSite } from "@/components/aicss/web-search";
import { toSteps } from "@/lib/reasoning-parts";
import type { ClientActivityEvent, ClientMemoryReceipt, ClientSource, ClientToolDetail } from "@/types/chat";

/* ─────────────────────────────────────────────────────────────────────────────
 * THE FORM MUST BE INCAPABLE OF LYING.
 *
 * (This rule governs the panel in thought-process-panel.tsx, and it lives here
 * because it is enforced by the model below rather than by the markup: a step
 * with no measured clock is given no figure to print. Splitting the two files
 * did not split the rule.)
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
export function speakSpan(ms: number) {
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

export function plural(n: number, one: string, many = `${one}s`) {
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
export const STEP_LABEL = {
  waiting: "Waiting for the model",
  researching: "Researching",
  thinking: "Thinking",
  writing: "Writing the answer",
  wrote: "Wrote the answer",
  searched: "Searched the web",
  reasoning: "Reasoning",
  fullTrace: "Full reasoning trace",
} as const;

export type PhaseKey = "research" | "think" | "write";

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
  // Prefix matches `SKILL_USED_ACTIVITY_PREFIX` in `@/lib/chat/skills`, kept as
  // a literal so this panel does not pull the skill permission module.
  const skillEvs = events.filter((e) => e.kind === "tool" && e.title.startsWith("Used skill"));

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
  // One fact and one spine row: progressive disclosure has to be readable
  // after the run, not only while it streams.
  if (skillEvs[0]) {
    const skill = skillEvs[0];
    facts.push({
      label: "Skill",
      value: [skill.title.replace(/^Used skill · /, ""), skill.detail].filter(Boolean).join(" · "),
    });
  }
  if (usageEv?.detail) facts.push({ label: "Cost", value: usageEv.detail });

  // One end for the header and for the last phase, so "total = sum of parts" is
  // arithmetic rather than aspiration.
  const elapsedMs = span(t0, tEnd);
  const memoryReceipt = memoryEv?.memoryReceipt ?? [];

  const steps = buildSteps({
    events,
    searchEvs,
    skillEvs,
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
  skillEvs: ClientActivityEvent[];
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
    skillEvs,
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

  // ── SKILL: which instructions shaped this turn, before any of its work ────
  for (const e of skillEvs) {
    steps.push({
      id: e.id,
      kind: "tool",
      phase: "think",
      label: e.title,
      detail: e.detail ?? null,
      ms: null,
      running: false,
      failed: false,
    });
  }

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
