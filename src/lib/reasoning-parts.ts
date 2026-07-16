/**
 * REASONING ACCUMULATION — one implementation, three consumers.
 *
 * A reasoning delta may or may not carry a part boundary. Whether it does is a
 * property of the PROVIDER, established on the wire and carried through
 * untouched: OpenAI's Responses API announces each summary part before its
 * deltas, so those arrive with an ordinal; Anthropic, Zhipu, Mistral and Google
 * stream one unbroken block and arrive without one.
 *
 * That distinction is the whole honesty argument for the steps UI, so it is
 * preserved rather than re-derived. Nothing here ever INFERS a boundary from
 * the text: `parts` stays empty for a provider that sent no boundaries, and the
 * UI renders no steps for it. The alternative — flattening the parts and then
 * re-splitting the prose on a `**Title**` regex — would put boundaries wherever
 * the text happened to look like a heading, which is a fabricated step wearing
 * the model's voice. Several providers (Zhipu especially) emit bold headings
 * mid-thought that are not step boundaries at all.
 *
 * Lives outside the route so the server and the client cannot drift: the panel
 * must render the same steps mid-stream and after a reload.
 */
export interface ReasoningState {
  /** Flat, complete thinking text. Every provider has this; it is what the
   *  "full thinking" disclosure renders and what persists to Message.reasoning. */
  text: string;
  /** The discrete parts, in order, verbatim. Empty when the provider streamed
   *  unbroken prose — which means "no steps exist", not "steps unknown". */
  parts: string[];
  /** Ordinal of the part the previous delta belonged to, so a boundary can be
   *  detected without re-reading the accumulated text. */
  lastPart: number | null;
}

export const emptyReasoning = (): ReasoningState => ({ text: "", parts: [], lastPart: null });

/**
 * Fold one delta in. Pure: returns fresh state, so React consumers can use it
 * directly in a setState updater.
 */
export function appendReasoningDelta(state: ReasoningState, text: string, part?: number): ReasoningState {
  // No boundary on the wire — the provider has no parts. Flat text only, and
  // `parts` deliberately stays empty.
  if (part == null) return { text: state.text + text, parts: state.parts, lastPart: state.lastPart };

  const parts = state.parts.slice();
  // Tolerates a skipped ordinal rather than trusting the sequence to be dense.
  while (parts.length <= part) parts.push("");
  parts[part] += text;

  // The flat text must not run parts together ("…last word.**Next Title**"), so
  // a blank line goes in AT THE BOUNDARY THE API DECLARED. This is the opposite
  // of guessing: the separator is placed from a known fact, and nothing ever
  // reads it back to recover the structure — `parts` already holds it.
  const sep = part !== state.lastPart && state.text ? "\n\n" : "";
  return { text: state.text + sep + text, parts, lastPart: part };
}

/** A step as the UI shows it: a label to scan, and the part's own prose. */
export interface ReasoningStep {
  /** The model's own title for the part, when it wrote one as a `**Bold**`
   *  first line (OpenAI's summary format). Null when it did not — the UI then
   *  falls back to the part's verbatim opening line rather than inventing one. */
  title: string | null;
  /** The part's text minus the title line. May be empty: title-only parts are
   *  real and common (verified live: gpt-5.3-codex returned a single 34-char
   *  part that was nothing but `**Designing high-traffic caching**`). */
  body: string;
}

/** Matches ONLY a whole first line that is bold and nothing else. */
const TITLE_LINE = /^\*\*([^\n*]+)\*\*\s*$/;

/**
 * Split one part into label + body.
 *
 * This is NOT the boundary parser — the boundaries came from the API and are
 * already fixed by the time we get here. This only decides how to LABEL a part
 * whose extent is already known, so a mislabelled part can never merge, split
 * or invent a step. Worst case the label is the part's first line verbatim,
 * which is still the model's own words.
 */
export function toStep(part: string): ReasoningStep {
  const lines = part.split("\n");
  const first = (lines[0] ?? "").trim();
  const match = TITLE_LINE.exec(first);
  if (match) return { title: match[1].trim(), body: lines.slice(1).join("\n").trim() };
  // No title line: label with the opening line verbatim (the UI truncates it
  // visually) and keep the whole part as the body.
  return { title: null, body: part.trim() };
}

/** Steps for a message, or null when this run has no step structure at all —
 *  an old message, or a provider that never sends parts. Null is a fact. */
export function toSteps(parts?: string[] | null): ReasoningStep[] | null {
  if (!parts || parts.length === 0) return null;
  const steps = parts.filter((p) => p.trim()).map(toStep);
  return steps.length ? steps : null;
}
