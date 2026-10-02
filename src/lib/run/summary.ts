/**
 * What the run line says: the live phase label, the captions inside the line,
 * the summary it settles into, its accessible name, and what the announcer
 * speaks (SPEC §7.3, §7.6.2, §7.10, §7.12).
 *
 * Grammar, not sentences: a line is complete phrases joined by the design
 * separator " · " ("Thought for 12s · 5 sources · ran code"), each phrase a
 * `RUN_COPY` literal with its values beside it as argument nodes. The summary
 * leads with "Thought for" whenever the run reasoned or ran any call
 * (DECISIONS wins over the motion audit's "Worked for"); "Answered in" only
 * when neither happened and the block must still render.
 *
 * Pure. The locale reaches the plain-text builders as an argument; nothing here
 * reads the DOM.
 */

import { phraseText } from "@/lib/i18n-phrase";
import { toolLine, count, only, spec, RUN_COPY } from "@/lib/run/presentation";
import { headlineOf } from "@/lib/run/timeline";
import type { PhaseState, PhraseLine, PhraseSpec, RunItem, RunPhase, RunView } from "@/lib/run/types";

/** How a run ended, for the settled line. */
export type RunOutcome = "done" | "stopped" | "failed";

const WORKING: ReadonlySet<RunPhase> = new Set(["queued", "thinking", "searching", "reading", "tool", "writing"]);

/** A phase in which the run is doing something (waiting on the reader is not working). */
export function isWorkingPhase(phase: RunPhase): boolean {
  return WORKING.has(phase);
}

/** A phase after which the line has settled into the summary. */
export function isSettledPhase(phase: RunPhase): boolean {
  return phase === "answering" || phase === "done" || phase === "stopped" || phase === "failed";
}

/** The run reasoned or ran any call: the one condition for "Thought for". */
export function didWork(view: RunView): boolean {
  return view.hasReasoning || view.tools.length > 0;
}

export function hasWarnings(view: RunView): boolean {
  return view.counts.failedTools + view.counts.warnings > 0;
}

/**
 * The block renders at rest only when there is something to open: reasoning,
 * a call, a source or a warning. A plain answer carries no run line at all.
 */
export function mustRenderAtRest(view: RunView): boolean {
  return (
    view.hasReasoning ||
    view.tools.length > 0 ||
    view.counts.sources > 0 ||
    hasWarnings(view) ||
    view.facts.research !== undefined
  );
}

function duration(ms: number | null, style: "narrow" | "long"): PhraseSpec["parts"][number] | null {
  return ms === null ? null : { kind: "duration", ms, style };
}

/** The lead phrase of the settled line: what the run was, and for how long. */
export function summaryLead(
  view: RunView,
  opts: { workedMs: number | null; outcome: RunOutcome; durationStyle?: "narrow" | "long" },
): PhraseLine {
  const style = opts.durationStyle ?? "narrow";
  const ms = opts.workedMs;
  if (opts.outcome === "stopped") {
    return [ms === null ? only("announceStopped") : spec({ phrase: RUN_COPY.stoppedAfter }, duration(ms, style))];
  }
  if (opts.outcome === "failed") {
    return [only("couldNotFinish"), ...(ms === null ? [] : [spec(duration(ms, style))])];
  }
  const research = view.facts.research;
  if (research?.key === "research") {
    return [spec({ phrase: RUN_COPY.researchedFor }, duration(research.workedMs, style))];
  }
  const key = didWork(view) ? "thoughtFor" : "answeredIn";
  return [spec({ phrase: RUN_COPY[key] }, duration(ms, style))];
}

/**
 * At most two facts, non-zero only, in the order §7.6.2 fixes. Searches count
 * only when no source does (a search that found sources is already counted as
 * its sources).
 */
export function summaryFacts(view: RunView): PhraseSpec[] {
  const { counts } = view;
  const facts: PhraseSpec[] = [];
  const research = view.facts.research;
  const sources = research?.key === "research" ? research.cited : counts.sources;
  if (sources > 0) facts.push(spec(count(sources, "source", "sources")));
  if (counts.codeRuns === 1) facts.push(only("factRanCode"));
  else if (counts.codeRuns > 1) facts.push(spec(count(counts.codeRuns, "factCodeRun", "factCodeRuns")));
  if (sources === 0 && counts.searches > 0) facts.push(spec(count(counts.searches, "factSearch", "factSearches")));
  if (counts.connectorsUsed.length === 1) {
    facts.push(spec({ phrase: RUN_COPY.factUsed }, { kind: "label", value: counts.connectorsUsed[0] }));
  } else if (counts.connectorsUsed.length > 1) {
    facts.push(spec(count(counts.connectorsUsed.length, "factConnectorUsed", "factConnectorsUsed")));
  }
  if (counts.filesRead.length) facts.push(spec({ phrase: RUN_COPY.factRead }, { kind: "file", value: counts.filesRead[0] }));
  if (counts.filesCreated > 0) facts.push(spec(count(counts.filesCreated, "fileCreated", "filesCreated")));
  return facts.slice(0, 2);
}

/** The settled line: the lead, then the facts. "Thought for 12s · 5 sources · ran code". */
export function summaryLine(view: RunView, opts: { workedMs: number | null; outcome: RunOutcome }): PhraseLine {
  const lead = summaryLead(view, opts);
  // A stopped or failed run's line says only that; what it did is in the timeline.
  return opts.outcome === "done" ? [...lead, ...summaryFacts(view)] : lead;
}

/** The facts shown beside a live label: "· 5 sources" (the line drops them below 28rem). */
export function liveFacts(view: RunView): PhraseSpec[] {
  return view.counts.sources > 0 ? [spec(count(view.counts.sources, "source", "sources"))] : [];
}

function toolItem(view: RunView, key: string | undefined): Extract<RunItem, { kind: "tool" }> | undefined {
  return key ? view.tools.find((item) => item.key === key) : undefined;
}

function reasoningItem(view: RunView, key: string | undefined): Extract<RunItem, { kind: "reasoning" }> | undefined {
  if (!key) return undefined;
  const item = view.items.find((candidate) => candidate.key === key);
  return item?.kind === "reasoning" ? item : undefined;
}

/**
 * The live label for a paced phase (§7.3). The provider headline stands in for
 * "Thinking" only when the reader's language is English (D-5 ii); every other
 * locale shows the localised phase word.
 */
export function phaseLine(
  state: Pick<PhaseState, "phase" | "subjectKey" | "coalesced">,
  view: RunView,
  opts: { locale: string; workedMs: number | null; outcome?: RunOutcome },
): PhraseLine {
  switch (state.phase) {
    case "queued":
    case "thinking":
    case "writing": {
      const headline = isEnglish(opts.locale) ? headlineOf(reasoningItem(view, state.subjectKey)?.text ?? "") : null;
      return headline ? [spec({ kind: "label", value: headline })] : [only("thinking")];
    }
    case "searching":
    case "reading":
    case "tool": {
      if (state.coalesced && state.coalesced > 1 && state.phase !== "tool") {
        return state.phase === "searching"
          ? [spec({ phrase: RUN_COPY.searching }, count(state.coalesced, "query", "queries"))]
          : [spec({ phrase: RUN_COPY.reading }, count(state.coalesced, "source", "sources"))];
      }
      const item = toolItem(view, state.subjectKey) ?? [...view.tools].reverse().find((candidate) => candidate.live);
      return item ? toolLine({ ...item.call, status: "running" }) : [only("thinking")];
    }
    case "waiting":
      return [only("waitingForApproval")];
    case "answering":
    case "done":
      return summaryLine(view, { workedMs: opts.workedMs, outcome: "done" });
    case "stopped":
      return summaryLine(view, { workedMs: opts.workedMs, outcome: "stopped" });
    case "failed":
      return summaryLine(view, { workedMs: opts.workedMs, outcome: "failed" });
  }
}

function isEnglish(locale: string): boolean {
  return /^en(?:-|$)/i.test(locale);
}

/**
 * The secondary caption inside the line (§7.10): a stall replaces the
 * escalation tier. The stall's own duration ticks, so the caller renders the
 * phrase and a clock leaf beside it; this names the phrase only.
 */
export function captionKey(state: Pick<PhaseState, "phase" | "stalled" | "escalation">): keyof typeof RUN_COPY | null {
  if (!isWorkingPhase(state.phase)) return null;
  if (state.stalled) return "stalledFor";
  if (state.escalation === 2) return "escalateWorking";
  if (state.escalation === 1) return "escalateThinking";
  return null;
}

/** The phase kind word for the accessible name: stable within a phase, never a query. */
function phaseKindSpec(phase: RunPhase): PhraseSpec {
  switch (phase) {
    case "searching":
      return only("searching");
    case "reading":
      return only("reading");
    case "tool":
      return only("usingTool");
    case "waiting":
      return only("waitingForApproval");
    default:
      return only("thinking");
  }
}

/**
 * The line's accessible name: a stable noun phrase that changes once per
 * phase-kind change (§7.12). Live: "Steps. Searching". At rest: "Steps.
 * Thought for 12 seconds. 5 sources. 1 warning". Built as plain text in the
 * reader's locale, because AutoTranslate matches whole attribute values only.
 */
export function lineAccessibleName(
  view: RunView,
  opts: { phase: RunPhase; workedMs: number | null; locale: string },
): string {
  const head = only("stepsName");
  if (isWorkingPhase(opts.phase) || opts.phase === "waiting") {
    return phraseText([head, phaseKindSpec(opts.phase)], opts.locale);
  }
  const outcome: RunOutcome = opts.phase === "stopped" ? "stopped" : opts.phase === "failed" ? "failed" : "done";
  const warnings = view.counts.failedTools + view.counts.warnings;
  const line: PhraseSpec[] = [
    head,
    ...summaryLead(view, { workedMs: opts.workedMs, outcome, durationStyle: "long" }),
    ...(outcome === "done" ? summaryFacts(view) : []),
    ...(warnings > 0 ? [spec(count(warnings, "warning", "warnings"))] : []),
  ];
  return phraseText(line, opts.locale);
}

/**
 * What the announcer says when a chat run enters a phase (§7.12), or null
 * for a phase it keeps quiet about. Plain text in the reader's locale.
 */
export function announcementFor(
  state: Pick<PhaseState, "phase" | "subjectKey" | "stalled">,
  view: RunView,
  opts: { locale: string; workedMs: number | null; panelCoversChat: boolean; words: number },
): string | null {
  const locale = opts.locale;
  switch (state.phase) {
    case "queued":
    case "thinking":
      return phraseText(only("thinking"), locale);
    case "searching":
      return phraseText(only("announceSearchingWeb"), locale);
    case "reading":
      return phraseText(only("announceReadingSources"), locale);
    case "tool": {
      const item = toolItem(view, state.subjectKey);
      return item ? phraseText(toolLine({ ...item.call, status: "running" }), locale) : null;
    }
    case "waiting":
      return phraseText(
        [only("waitingForApproval"), only(opts.panelCoversChat ? "announceApprovalInPanel" : "announceApprovalBelow")],
        locale,
      );
    case "done":
    case "answering": {
      if (state.phase === "answering") return null;
      const name = lineAccessibleName(view, { phase: "done", workedMs: opts.workedMs, locale });
      return [name, phraseText([only("announceComplete"), spec(count(opts.words, "word", "words"))], locale)].join(". ");
    }
    case "stopped":
      return phraseText(only("announceStopped"), locale);
    case "failed":
      return phraseText(only("couldNotFinish"), locale);
    default:
      return null;
  }
}

/** Words in the answer, for "Response complete. 212 words", counted with the locale's segmenter. */
export function wordCount(text: string, locale: string): number {
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    let n = 0;
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) n += 1;
    return n;
  } catch {
    return text.split(/\s+/).filter(Boolean).length;
  }
}
