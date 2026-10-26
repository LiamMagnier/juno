/**
 * What the composer's model chip prints when the row is short of room.
 *
 * The chip sits between the + and task controls on its left and the mic and
 * send on its right, and on a 360px phone it gets about 130px. A long name
 * ("Muse Spark 1.3 Contributor") or a short one with an effort after it
 * ("GPT-6.1 Sol Max") does not always fit there. Letting CSS cut it gave
 * "GPT-6.1 S…" and swallowed the effort word, and before the row was fixed
 * the chip simply spilled under the mic.
 *
 * So the chip steps down a ladder of whole labels, roomiest first, and prints
 * the first that fits (model-selector.tsx measures). The rungs:
 *
 *   1. The lab mark, the name the screen width asks for (the full name on a
 *      wide screen, the short one, "Opus 5.5", on a phone, where the mark
 *      already says "Claude") and the effort when it is not the default.
 *   2. On a wide screen, the same with the short name.
 *   3. Without the mark: "Opus 5.5 Max", the label Claude's own phone chip
 *      prints. Sixteen pixels of mark and its gap is usually all a 360px row
 *      is short of.
 *   4. Without the effort word. The model is what the chip is for; the
 *      effort is one tap away in the panel, and stays in the accessible
 *      name. A name cut down to make room for "Extra high" ("GPT-6…") no
 *      longer says which model it is.
 *   5. The mark back, and the name without the prefix the mark already
 *      says ("GPT-5.6 Sol" → the OpenAI mark and "5.6 Sol"): the whole name
 *      still tells Sol from Terra and Luna, a dozen pixels narrower. Before
 *      the effort goes, and again after.
 *   6. Whole words off the end of the name, the ellipsis set tight against
 *      the last word kept ("Muse Spark 1.3…"): never mid-word, never after a
 *      space. A trim that leaves only a number ("3.5…") says nothing and is
 *      skipped.
 *
 * The paid modes (Pro, the speed bolt) are not on the ladder: they multiply
 * the price of every turn, so they stay on every rung. A word after a cut
 * name reads as part of the name ("GPT-5.6… Pro" looked like a model called
 * "GPT-5.6-something Pro"), so with Pro on (`suffix`) the name is never
 * trimmed: past the whole names the chip is the lab mark alone with Pro
 * beside it (the label the chip already prints under 360px), and the name
 * stays in its accessible name and the panel.
 */

export type ChipLabel = {
  /** Whether the lab mark leads the label. */
  mark: boolean;
  /** The name as printed. */
  text: string;
  /** Whether the effort word follows the name. */
  effort: boolean;
};

/**
 * The name a phone-width chip prints beside a lab mark: the family word the
 * mark already says is dropped ("Claude Opus 5.5" → "Opus 5.5", "Gemini 3.1
 * Pro" → "3.1 Pro"), so the room goes to the part that tells two models of
 * one lab apart. "GPT-…" stays whole: the prefix IS the model's name there.
 */
export function chipShortName(name: string): string {
  return name.replace(/^(?:Claude|Gemini)\s+/, "");
}

/**
 * The name with every prefix its lab mark already says, for a rung that
 * keeps the mark: the short name, then "GPT-" before a version ("GPT-5.6
 * Sol" → "5.6 Sol"). Never alone: without the mark "5.6 Sol" names nothing.
 */
export function chipMarkedName(name: string): string {
  return chipShortName(name).replace(/^GPT-(?=\d)/, "");
}

/**
 * The whole-word trims of a name, longest first, each closed by a tight
 * ellipsis: "Muse Spark 1.3 Contributor" → "Muse Spark 1.3…", "Muse Spark…",
 * "Muse…". Punctuation left dangling at the cut ("Grok 4.20 (Reasoning)" →
 * "Grok 4.20…", not "Grok 4.20 (…") goes with the word it belonged to. A
 * trim with no letter left in it is dropped.
 */
export function wordTrims(name: string): string[] {
  const words = name.trim().split(/\s+/);
  const out: string[] = [];
  for (let keep = words.length - 1; keep >= 1; keep--) {
    const kept = words
      .slice(0, keep)
      .join(" ")
      .replace(/[\s\-–—(·,:/]+$/u, "");
    if (!kept || !/\p{L}/u.test(kept)) continue;
    const text = `${kept}…`;
    if (out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

/** The ladder for one model, roomiest first. See the file's comment for the rungs. */
export function chipLabelLadder(
  name: string,
  { phone, effort, suffix = false }: { phone: boolean; effort: boolean; suffix?: boolean },
): ChipLabel[] {
  const short = chipShortName(name);
  const marked = chipMarkedName(name);
  const out: ChipLabel[] = [{ mark: true, text: phone ? short : name, effort }];
  if (!phone && short !== name) out.push({ mark: true, text: short, effort });
  out.push({ mark: false, text: short, effort });
  if (effort && marked !== short) out.push({ mark: true, text: marked, effort: true });
  if (effort) out.push({ mark: false, text: short, effort: false });
  if (marked !== short) out.push({ mark: true, text: marked, effort: false });
  if (suffix) {
    out.push({ mark: true, text: "", effort: false });
    return out;
  }
  for (const text of wordTrims(short)) out.push({ mark: false, text, effort: false });
  return out;
}

/**
 * The rung to print: the first that fits, else the tightest (which the chip's
 * own CSS truncation then holds inside its box, so it can never overlap the
 * control beside it).
 */
export function pickChipLabel(ladder: ChipLabel[], fits: (label: ChipLabel) => boolean): number {
  const at = ladder.findIndex(fits);
  return at < 0 ? ladder.length - 1 : at;
}
