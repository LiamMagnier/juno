import type { ClientToolDetail } from "@/types/chat";
import type { RunModel } from "@/components/chat/thought-process-panel";

/* ─────────────────────────────────────────────────────────────────────────────
 * THE RUN, AS TEXT — the panel's two copy buttons and its one span formatter.
 *
 * These live outside the component for one reason: they are the only parts of
 * the panel that can be reasoned about without a DOM, and the receipt is the
 * part most likely to grow a bug nobody sees (a copied receipt is read once,
 * elsewhere, usually pasted into a bug report). Pure in, string out.
 *
 * THE SAME HONESTY RULES APPLY HERE AS ON SCREEN. A field the run does not have
 * produces NO LINE — never a line with an em-dash, a zero or "unknown" in it.
 * The panel's idiom for "we do not know" is absence, and a receipt that invents
 * a placeholder is worse than the panel that refused to, because it outlives the
 * session and gets quoted.
 *
 * A TRUE LEAF, DELIBERATELY. The only thing this module takes from the panel is
 * the `RunModel` TYPE, on an `import type` that erases at compile time — so
 * there is no import cycle and no runtime edge into a `"use client"` module.
 * That is also why `formatSpan` lives here rather than in the panel and is
 * re-exported from it: the receipt needs it, and a second copy of a duration
 * formatter is the exact bug that made the strip print `2s` beside the panel's
 * `2.7s` for one run.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * The one span formatter, and the one precision policy.
 *
 * PRECISION FOLLOWS THE CLOCK. `useRunClock` samples at 1Hz, so a tenths digit
 * on a live number is an artefact of when the interval happened to start, not a
 * measurement — it would print `2.4s` and mean "somewhere in this second". While
 * live the figure is therefore floored to whole seconds; on settle it gains its
 * tenth from a real end instant, in place.
 *
 * There used to be a second formatter (`formatLiveSpan`, in activity-timeline)
 * with its own rounding, which is why the strip read `2s` while the panel one
 * column away read `2.7s` for the same run. Both now call this, with the same
 * value, and print the identical glyph in both states.
 *
 * Two significant figures, always. Never milliseconds, never `2.74s`. The ms are
 * already in the ISO strings and were merely thrown away by toLocaleTimeString.
 * Unknown stays unknown — the caller renders an em-dash, never a guess, never a
 * zero.
 */
export function formatSpan(ms: number, opts?: { live?: boolean }) {
  const s = ms / 1000;
  if (opts?.live) {
    const sec = Math.max(0, Math.floor(s));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export interface CostParts {
  /** The currency token exactly as the producer wrote it, or null. */
  money: string | null;
  /** Everything else in the usage string, verbatim, or null. */
  billed: string | null;
}

/**
 * Lift the money out of the producer's usage prose — or refuse to.
 *
 * `chat-usage.ts` joins `{input, cached, output, searches, cost}` into one
 * human sentence and throws the structure away, so the client has to read it
 * back out. That parse is allowed exactly one anchored match, and it must fail
 * CLOSED: when the shape changes, `money` comes back null and the caller prints
 * the whole string verbatim as a stated row. A partial parse is the one outcome
 * that must never happen, because a wrong number still looks like a number.
 *
 * `<?` is not decoration. `formatUsd` emits `<$0.0001` for a sub-hundredth-of-a-
 * cent run (utils.ts:70); a pattern anchored on `$` alone would lift `$0.0001`
 * out of it and print an exact figure where the producer said "less than".
 */
export function splitCost(value?: string | null): CostParts {
  if (!value) return { money: null, billed: null };
  const money = value.match(/<?\$[\d.,]+/)?.[0] ?? null;
  if (!money) return { money: null, billed: null };
  const billed = value
    .replace(money, "")
    .replace(/·\s*$/, "")
    .replace(/^\s*·\s*/, "")
    .trim();
  return { money, billed: billed || null };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WHAT A TOOL ROW SAYS — one wording, two surfaces.
 *
 * The panel renders these and the receipt prints them, from these constants,
 * for the same reason `formatSpan` lives in this file: a receipt that describes
 * an absent payload differently from the panel is two answers to one question,
 * and the receipt is the copy that outlives the session and gets quoted.
 *
 * THE MAPS ARE EXHAUSTIVE BY TYPE, DELIBERATELY. `Record<NonNullable<…>, string>`
 * means the day the server grows a fifth note value this file stops COMPILING
 * rather than rendering a blank where a sentence belongs — which is precisely
 * how `"unfinished"` would have shipped as an empty paragraph.
 *
 * The four argument reasons are kept apart on purpose. "The provider did not
 * send them", "the connector was called with nothing", "the text was not JSON"
 * and "this run ran out of room" are four different facts about a call, and
 * collapsing them into one polite sentence would make the panel vaguer than the
 * data it is holding.
 * ───────────────────────────────────────────────────────────────────────────── */

export const TOOL_ARGS_NOTE: Record<NonNullable<ClientToolDetail["argsNote"]>, string> = {
  unavailable: "The provider did not send the arguments for this call.",
  empty: "The connector was called with no arguments.",
  unparsable: "The provider sent argument text that is not valid JSON, so it could not be redacted and is not shown.",
  over_budget: "This run reached its limit for recorded call detail before this call.",
};

export const TOOL_RESULT_NOTE: Record<NonNullable<ClientToolDetail["resultNote"]>, string> = {
  pending: "Waiting for the connector to answer.",
  unfinished: "The run ended before this call returned.",
  empty: "The connector returned nothing.",
  over_budget: "This run reached its limit for recorded call detail before this call returned.",
};

/**
 * The section caption. It states the redaction AND its limit, so a reader does
 * not assume a result has been sanitised of their own data — it has not.
 *
 * NAMED `…_DESCRIPTION`, not `…_CAPTION`, and every sentence below is named
 * `…_NOTE` for the same reason: `scripts/generate-i18n-catalog.mjs` finds UI
 * copy either as JSX text or as a variable whose NAME ends in one of a fixed
 * set of suffixes. These sentences reach the screen through an identifier
 * rather than as literal JSX children, so a name outside that set makes them
 * the only permanent copy in this panel that is never offered for translation
 * — silently, and only discoverable by diffing the generated catalog.
 */
export const TOOLS_DESCRIPTION =
  "Exactly what Juno sent each connector and exactly what came back. Credentials are removed and long results are cut; nothing else is edited.";

/** Shown when at least one row carries no payload at all. Two causes, and the
 *  client genuinely cannot tell them apart — so it names both rather than
 *  picking one and sounding certain. */
export const TOOLS_NO_DETAIL_NOTE =
  "Some of these calls carry no recorded detail — they ran before Juno kept it, or with it turned off.";

/**
 * The last-resort sentences, for a payload that is absent with no reason given.
 *
 * The server's contract is that exactly one of `args`/`argsNote` is present, so
 * these are unreachable through it. They exist because a row can also arrive
 * from a LATER build whose note value this build does not know: `readToolDetail`
 * drops the unrecognised value and keeps the event, which would otherwise land
 * on screen as an explanation-shaped hole. "Nothing was recorded" is the one
 * sentence that stays true in that case.
 */
export const TOOL_ARGS_MISSING_NOTE = "No arguments were recorded for this call.";
export const TOOL_RESULT_MISSING_NOTE = "No result was recorded for this call.";

/** The sentence for an absent payload. There is never an empty box. */
export function toolArgsNoteText(tool: ClientToolDetail): string {
  return tool.argsNote ? TOOL_ARGS_NOTE[tool.argsNote] : TOOL_ARGS_MISSING_NOTE;
}

export function toolResultNoteText(tool: ClientToolDetail): string {
  return tool.resultNote ? TOOL_RESULT_NOTE[tool.resultNote] : TOOL_RESULT_MISSING_NOTE;
}

/** The code block's header. `truncated` with no length because nothing measures
 *  the pre-cut length of the arguments — `ClientToolDetail` carries a
 *  `resultChars` and no `argsChars`, and inventing one from the head would be a
 *  number about a string nobody kept. */
export function toolArgsLabel(tool: ClientToolDetail): string {
  return tool.argsTruncated ? "arguments · json · truncated" : "arguments · json";
}

/**
 * The result block's header, and the panel's one quantified claim about a cut.
 *
 * `resultChars` is measured by the server on the SAME text the head was taken
 * from (after any pretty-printing), so "first 4000 of 26318 chars" is a true
 * statement about one string rather than a ratio between two. When the server
 * did not supply it the label degrades to the bare word — never to a computed
 * total, which is how a truncation notice starts lying.
 */
export function toolResultLabel(tool: ClientToolDetail): string {
  const base = tool.status === "failed" ? "error" : "result";
  if (!tool.resultTruncated) return base;
  const shown = tool.result?.length;
  return shown !== undefined && tool.resultChars !== undefined
    ? `${base} · first ${shown} of ${tool.resultChars} chars`
    : `${base} · truncated`;
}

/**
 * A fence long enough to survive the payload.
 *
 * Connector output is arbitrary text and routinely contains Markdown — a GitHub
 * issue body, a Notion page. A three-backtick fence around a result that itself
 * contains three backticks closes early, and the rest of the receipt renders as
 * prose with the run's own headings inside it. So the fence is always one
 * backtick longer than the longest run in the text it wraps.
 */
function fenced(text: string, lang = ""): string[] {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${lang}`, text, fence];
}

/**
 * The whole run as Markdown.
 *
 * Ordered the way the panel is ordered, so someone holding both can check one
 * against the other line by line. The reasoning trace goes in VERBATIM — it is
 * the model's own words and the only thing here that is not Juno's chrome.
 */
export function toRunMarkdown(
  run: RunModel,
  reasoning?: string | null,
  /** The finish-reason sentence message-item already resolved, when there is
   *  one. Not on `RunModel`: it is a property of the message, not of the run's
   *  event stream, and the panel receives it the same way. */
  finishNote?: string | null,
): string {
  const factOf = (label: string) => run.facts.find((f) => f.label === label)?.value ?? null;
  const model = factOf("Model");
  const cost = factOf("Cost");
  const { money, billed } = splitCost(cost);

  const lines: string[] = [model ? `# Run — ${model}` : "# Run"];

  if (run.elapsedMs !== null) {
    // Only the phases that were actually measured, and only when there are at
    // least two of them — one phase equal to the total, printed twice, is the
    // same noise the panel's own `phases.length >= 2` gate exists to suppress.
    const measured = run.phases.filter((p) => p.ms !== null);
    const parenthetical =
      measured.length >= 2
        ? ` (${measured.map((p) => `${p.label.toLowerCase()} ${formatSpan(p.ms as number)}`).join(" · ")})`
        : "";
    lines.push(`Elapsed ${formatSpan(run.elapsedMs)}${parenthetical}`);
  }

  // Same degradation ladder as the COST block: money + breakdown, money alone,
  // or the producer's whole string untouched. Never a reconstructed number.
  if (money) lines.push(billed ? `Cost ${money} — ${billed}` : `Cost ${money}`);
  else if (cost) lines.push(`Cost ${cost}`);

  for (const fact of run.facts) {
    if (fact.label === "Model" || fact.label === "Cost") continue;
    lines.push(`${fact.label}: ${fact.value}`);
  }

  // Verbatim, per the panel's Notice section — never re-phrased into blame.
  const notices = [...run.calls.filter((c) => c.warn).map((c) => c.object), ...(finishNote ? [finishNote] : [])];
  if (notices.length > 0) {
    lines.push("Notices:");
    for (const notice of notices) lines.push(`- ${notice}`);
  }

  if (run.sources.length > 0) {
    lines.push("Sources:");
    lines.push(toSourcesMarkdown(run));
  }

  /* ── TOOLS ────────────────────────────────────────────────────────────────
   * Every call the panel shows, with the same payloads and the same sentences
   * for the ones it has no payload for. A receipt that omitted them while the
   * panel showed them would be the drift `formatSpan` was extracted to prevent
   * — and this is the half people paste into bug reports, so it is the half
   * that has to carry the caption about what was redacted.
   *
   * Rows keep their emission order and their names even when there is no
   * detail behind them, so the receipt is row-for-row checkable against the
   * panel rather than being a filtered subset of it. */
  const toolCalls = run.calls.filter((c) => !c.warn);
  if (toolCalls.length > 0) {
    lines.push("");
    lines.push("## Tools");
    lines.push("");
    lines.push(TOOLS_DESCRIPTION);
    if (toolCalls.some((c) => !c.tool)) lines.push(TOOLS_NO_DETAIL_NOTE);

    for (const call of toolCalls) {
      lines.push("");
      lines.push(`### ${call.object}`);
      const tool = call.tool;
      if (!tool) continue;

      // "Failed" only. A successful call gets no marker, exactly as on screen:
      // absence is this panel's idiom for the ordinary case, and a "Succeeded"
      // line on every row would bury the one that says otherwise.
      if (tool.status === "failed") lines.push("Failed");
      // Absent, never zero, for a call that never reached the network — so the
      // line is simply not written rather than written with a placeholder in it.
      if (typeof tool.durationMs === "number") lines.push(`Duration ${formatSpan(tool.durationMs)}`);

      lines.push("");
      if (tool.args) {
        lines.push(`${toolArgsLabel(tool)}:`);
        lines.push(...fenced(tool.args, "json"));
      } else {
        lines.push(`Arguments: ${toolArgsNoteText(tool)}`);
      }

      lines.push("");
      if (tool.result) {
        lines.push(`${toolResultLabel(tool)}:`);
        // No language tag: a result is JSON only sometimes, and labelling prose
        // as json to get colour would be a claim about the payload's type.
        lines.push(...fenced(tool.result));
      } else {
        lines.push(`Result: ${toolResultNoteText(tool)}`);
      }
    }
  }

  const trace = reasoning?.trim();
  if (trace) {
    lines.push("");
    lines.push("## Reasoning");
    lines.push("");
    lines.push(trace);
  }

  return lines.join("\n");
}

/** `- [title](url)` per source, in emission order — the order the run collected
 *  them, which is the only order this app can honestly claim.
 *
 *  A source the run only LISTED is tagged; one it read, and one whose producer
 *  did not say either way, are not. Marking the exception rather than the rule
 *  is the same choice the panel makes, and it keeps a bibliography pasted
 *  elsewhere from carrying a tag on every line. */
export function toSourcesMarkdown(run: RunModel): string {
  return run.sources
    .map((s) => `- [${s.title}](${s.url})${s.access === "listed" ? " (listed, not read)" : ""}`)
    .join("\n");
}
