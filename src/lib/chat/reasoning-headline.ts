/**
 * One line of what the model is thinking about, for the live thinking row.
 *
 * The owner wants the row to say what the model is doing, the way ChatGPT and
 * Claude do ("Comparing the two pricing models"), not "Thinking" for a minute.
 * The full reasoning stays in the panel; this picks one honest, readable line
 * from it and refuses anything that would look broken in the transcript.
 *
 * Order of preference:
 *  1. The latest summary title: providers that summarise their reasoning
 *     (OpenAI, Gemini, Claude) open each step with `**Title**` or a heading.
 *  2. Otherwise the latest complete prose sentence of the newest paragraph.
 * Code, URLs, maths and fragments are rejected; `null` means "say Thinking".
 */

const MAX = 84;

function clean(text: string): string {
  return text
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^[#>\-*\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[:;,\s]+$/, "")
    .trim();
}

/** Prose, not code or data: mostly letters and spaces, no code punctuation. */
function readable(text: string): boolean {
  if (text.length < 8) return false;
  if (/[{}<>=$\\|]|=>|::|\/\/|https?:|```|\b(function|const|let|return|import|SELECT)\b/.test(text)) return false;
  const letters = (text.match(/[\p{L}\s,'’-]/gu) ?? []).length;
  return letters / text.length > 0.82;
}

function shorten(text: string): string {
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function reasoningHeadline(reasoning: string | null | undefined): string | null {
  if (!reasoning) return null;
  const tail = reasoning.slice(-6000);

  // 1. Summary titles: a bold line or a markdown heading.
  const titles = [
    ...tail.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,120})\*\*\s*(?=\n|$)/g),
    ...tail.matchAll(/(?:^|\n)\s*#{1,4}\s+([^\n]{3,120})/g),
  ]
    .map((m) => ({ at: m.index ?? 0, text: clean(m[1]) }))
    .filter((t) => readable(t.text))
    .sort((a, b) => a.at - b.at);
  const title = titles.at(-1)?.text;
  if (title) return shorten(capitalise(title.replace(/[.!?]+$/, "")));

  // 2. The newest complete sentence of the newest paragraph that has one.
  const paragraphs = tail.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).reverse();
  for (const paragraph of paragraphs.slice(0, 3)) {
    const sentences = paragraph.match(/[^.!?\n]+[.!?](?=\s|$)/g) ?? [];
    for (const sentence of [...sentences].reverse()) {
      const text = clean(sentence).replace(/[.!?]+$/, "");
      if (text.length >= 12 && readable(text)) return shorten(capitalise(text));
    }
  }
  return null;
}
