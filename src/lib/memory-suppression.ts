/**
 * The one door every MemoryEntry write goes through.
 *
 * "Forget my old job" is stored as a SUPPRESSION entry holding the statement
 * verbatim, and it worked — for exactly one writer. `saveCandidates()` (the
 * automatic extractor) consulted the block-list; nothing else did. A manual add
 * via POST /api/memory, an applied natural-language edit via
 * /api/memory/edit/apply, and the native sync mutations `memory.create` /
 * `memory.update` all wrote straight to the table, so a forgotten statement
 * came back the moment it was typed on the web or synced from a phone. A
 * block-list that only one writer reads is not a block-list, and "forget this"
 * is a promise the product has to keep on every path or on none.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, for the same
 * reason background-provider-policy.ts is: the rule has to be unit-testable
 * without a database, and the door has to be callable both from a request
 * client and from inside a `$transaction` without either being baked in.
 */

export type MemoryEntryKind = "FACT" | "SUPPRESSION";

/** Mirrors the zod caps on every memory write route. */
export const MEMORY_CONTENT_LIMIT = 500;

/** How much of a suppression is quoted back in a refusal before it is elided. */
const QUOTED_SUPPRESSION_LIMIT = 120;

/**
 * Comparable form for matching. Punctuation, case and spacing are noise here —
 * "The user works at Acme." and "the user works at acme" are the same claim,
 * and a block-list that could be defeated by a full stop would be theatre.
 * Latin-1/Latin Extended and CJK ranges are kept so the rule is not
 * English-only.
 */
export function normalizeStatement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ一-鿿]+/g, " ")
    .trim();
}

/**
 * The suppression covering `candidate`, or null when nothing does.
 *
 * Containment is checked in BOTH directions on purpose. A suppression saying
 * "works at Acme" has to catch the fuller fact "The user works at Acme as a
 * staff designer", and a suppression that spells out the whole sentence has to
 * catch the terser paraphrase the model produces next week. The asymmetry cost
 * is real — a broad suppression refuses more than the user pictured — but the
 * failure modes are not equal: an over-broad refusal is visible and reversible
 * ("remember that again"), while a miss silently resurrects the one thing they
 * asked to be rid of.
 */
export function findSuppression(
  candidate: string,
  suppressions: readonly string[]
): string | null {
  const c = normalizeStatement(candidate);
  if (!c) return null;
  for (const suppression of suppressions) {
    const n = normalizeStatement(suppression);
    if (n.length > 0 && (c === n || c.includes(n) || n.includes(c))) return suppression;
  }
  return null;
}

/**
 * The sentence shown wherever a write is refused. Built here rather than at the
 * three call sites so the explanation cannot drift between the web add, the
 * applied edit and the native sync — and so it always names the statement being
 * honoured, which is the only part that tells the user what to do next.
 */
const REFUSAL_MESSAGE = {
  // Split around the quoted statement, which is the user's own text and cannot
  // be part of a translatable string. The name and the `*Message` suffix are
  // what put both halves in the i18n catalog — see
  // scripts/generate-i18n-catalog.mjs.
  lead: "You asked Juno to forget",
  tail: "This wasn’t saved — tell Juno to remember it again if that has changed.",
};

export function suppressionRefusalMessage(suppression: string): string {
  const quoted =
    suppression.length > QUOTED_SUPPRESSION_LIMIT
      ? `${suppression.slice(0, QUOTED_SUPPRESSION_LIMIT - 1)}…`
      : suppression;
  return `${REFUSAL_MESSAGE.lead} “${quoted}”. ${REFUSAL_MESSAGE.tail}`;
}

export type MemoryWriteRefusal =
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "suppressed"; suppression: string; message: string };

export type MemoryWriteDecision = { ok: true; content: string } | MemoryWriteRefusal;

/**
 * Decide whether `content` may be written. Pure, so the rule can be tested
 * exhaustively without a database standing in the way.
 *
 * SUPPRESSION entries are never screened against the block-list. They ARE the
 * block-list: running them through it would make "forget my old job" refuse
 * itself the second time it was asked, and would make the un-forget/re-forget
 * round trip in the memory editor impossible.
 */
export function screenMemoryWrite(opts: {
  content: string;
  kind?: MemoryEntryKind;
  suppressions: readonly string[];
}): MemoryWriteDecision {
  const content = opts.content.trim().slice(0, MEMORY_CONTENT_LIMIT);
  if (!content || !normalizeStatement(content)) return { ok: false, reason: "empty" };
  if ((opts.kind ?? "FACT") === "SUPPRESSION") return { ok: true, content };

  const suppression = findSuppression(content, opts.suppressions);
  if (suppression) {
    return {
      ok: false,
      reason: "suppressed",
      suppression,
      message: suppressionRefusalMessage(suppression),
    };
  }
  return { ok: true, content };
}

export type MemoryWriteOutcome<T> =
  | { ok: true; value: T; content: string }
  | MemoryWriteRefusal;

/**
 * Run `write` only if the content clears the block-list.
 *
 * The callback shape is what makes this a door rather than a suggestion: no
 * call site can reach the table except through the `write` argument, and that
 * argument is not invoked on a refusal. The SQL still belongs to the caller
 * because it genuinely differs — a create, an ownership-scoped `updateMany`,
 * and one of each inside a Serializable transaction — but the decision does
 * not, and now lives in exactly one place.
 *
 * `loadSuppressions` is lazy so the extra query is skipped for suppression
 * writes and for content that was empty to begin with.
 */
export async function guardedMemoryWrite<T>(opts: {
  content: string;
  kind?: MemoryEntryKind;
  loadSuppressions: () => Promise<readonly string[]>;
  write: (content: string) => Promise<T>;
}): Promise<MemoryWriteOutcome<T>> {
  const kind = opts.kind ?? "FACT";
  const trimmed = opts.content.trim().slice(0, MEMORY_CONTENT_LIMIT);
  if (!trimmed || !normalizeStatement(trimmed)) return { ok: false, reason: "empty" };

  const suppressions = kind === "SUPPRESSION" ? [] : await opts.loadSuppressions();
  const decision = screenMemoryWrite({ content: trimmed, kind, suppressions });
  if (!decision.ok) return decision;

  return { ok: true, value: await opts.write(decision.content), content: decision.content };
}
