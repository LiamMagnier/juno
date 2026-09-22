/**
 * Turning what a model called a file into the file it meant.
 *
 * Pure and separate from `attachments.ts` for two reasons. The first is
 * testability: the ladder below is the part with judgement in it, and it
 * should be exercised without a database. The second is that the tool
 * definitions themselves must stay importable outside a server runtime — the
 * agent registry is constructed at module load and is read by tests that have
 * no `react-server` condition, so a `server-only` import anywhere in that
 * graph takes the whole registry down. The Prisma half lives behind a dynamic
 * import inside `execute`; this half does not need to.
 */

/** What both attachment tools need to know about a file they may reach. */
export interface ConversationAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  kind: "IMAGE" | "FILE";
  storageKey: string;
  size: number;
  parserState: string;
  createdAt: Date;
}

/**
 * Resolve what the model called the file to one of the files it may read.
 *
 * Models name files the way people do — "the report", "TD1.pdf", "the second
 * one" — and almost never by id, because the id is not something they were
 * shown. Matching is therefore a ladder from exact to forgiving, and it stops
 * at the first rung that produces exactly one answer: an ambiguous reference
 * resolves to nothing rather than to a guess, because reading out the wrong
 * document is a worse answer than asking which one.
 */
export function matchAttachment<T extends { id: string; fileName: string }>(
  items: readonly T[],
  reference: string | undefined | null,
): { match: T | null; ambiguous: T[] } {
  if (items.length === 0) return { match: null, ambiguous: [] };
  const needle = (reference ?? "").trim();
  // No reference at all, and only one candidate: that is the one they mean.
  if (!needle) return { match: items.length === 1 ? items[0] : null, ambiguous: [...items] };

  const byId = items.find((item) => item.id === needle);
  if (byId) return { match: byId, ambiguous: [] };

  const lower = needle.toLowerCase();
  const stem = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, "");
  const rungs: ((item: T) => boolean)[] = [
    (item) => item.fileName.toLowerCase() === lower,
    // Without the extension: "TD1" for "TD1.pdf" is what a model writes when
    // it is reading the name back out of its own prose.
    (item) => stem(item.fileName) === stem(lower),
    (item) => item.fileName.toLowerCase().includes(lower),
  ];

  for (const rung of rungs) {
    const hits = items.filter(rung);
    if (hits.length === 1) return { match: hits[0], ambiguous: [] };
    if (hits.length > 1) return { match: null, ambiguous: hits };
  }
  return { match: null, ambiguous: [...items] };
}

/** `"TD1.pdf", "notes.txt"` — the list a failed match should offer instead. */
export function nameList(items: readonly { fileName: string }[], limit = 10): string {
  const names = items.slice(0, limit).map((item) => `"${item.fileName}"`);
  const more = items.length > limit ? `, and ${items.length - limit} more` : "";
  return names.join(", ") + more;
}
