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
 *  them, which is the only order this app can honestly claim. */
export function toSourcesMarkdown(run: RunModel): string {
  return run.sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
}
