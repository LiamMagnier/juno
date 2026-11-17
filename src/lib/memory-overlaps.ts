import { exclusiveSlot, significantTokens, slotsConflict } from "@/lib/memory-lifecycle";

/*
 * MEMORIES THAT SAY THE SAME THING, OR DISAGREE, as the memory page flags them.
 *
 * The lifecycle already settles the clear cases on its own: a restatement in
 * the same words refreshes the row, a single-valued slot ("lives in", "works
 * at") said again with a new value replaces the old one, and the timeline pass
 * merges near-identical automatic facts (planDuplicateMerges, Jaccard 0.75).
 * What it leaves, on purpose, is anything it could get wrong by acting alone:
 * two facts the person typed themselves (a typed fact is never retired by a
 * guess), wordings a little further apart than the merge threshold, and two
 * believed values for one slot that came in by routes that do not compete
 * (an import beside a typed fact).
 *
 * Those are the ones worth a person's look, so the page asks instead of
 * acting: "these may say the same thing" or "these disagree", and the person
 * keeps one (PATCH /api/memory/[id] with `replacedBy`). Nothing here writes.
 *
 * Conservative, like the merge: same scope only (a project's "works at Acme"
 * may differ from the account's by design), never across differing numbers
 * ("3 cats" / "2 cats" are not one fact), and each memory is in at most one
 * pair, so a cluster of five near-copies is asked about two at a time instead
 * of as a puzzle.
 */

export type MemoryOverlapKind = "duplicate" | "conflict";

export interface MemoryOverlap {
  kind: MemoryOverlapKind;
  /** The two memories, in the order the list had them. */
  ids: [string, string];
  /** For a conflict: what they disagree about, in words ("where you live"). */
  noun?: string;
}

interface OverlapCandidate {
  id: string;
  content: string;
  kind: string;
  status: string;
  projectId: string | null;
}

/** Token overlap (Jaccard) at or above which two believed facts are worth asking about. Below the merge's 0.75, which acts without asking. */
export const DUPLICATE_FLAG_JACCARD = 0.6;

/** A stable key for a pair, whichever order it comes in: what "Keep both" remembers. */
export function overlapKey(ids: readonly [string, string]): string {
  return [...ids].sort().join("|");
}

// "named" and "called" are one word for this purpose, as in the merge.
const fold = (token: string) => (token === "nam" || token === "name" || token === "call" ? "cal" : token);
const numbersOf = (content: string) => (content.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(",");

function sameSaying(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (shared / (a.size + b.size - shared) >= DUPLICATE_FLAG_JACCARD) return true;
  // One wholly inside the other, when the shorter one says enough to mean
  // something: "prefers short answers" inside "prefers short answers, with
  // the recommendation first".
  return shared === Math.min(a.size, b.size) && Math.min(a.size, b.size) >= 3;
}

export function findMemoryOverlaps(
  memories: readonly OverlapCandidate[],
  opts: { dismissed?: ReadonlySet<string> } = {}
): MemoryOverlap[] {
  const believed = memories.filter((memory) => memory.kind === "FACT" && memory.status === "active");
  const tokens = new Map(believed.map((memory) => [memory.id, new Set(significantTokens(memory.content).map(fold))]));
  const slots = new Map(believed.map((memory) => [memory.id, exclusiveSlot(memory.content)]));
  const paired = new Set<string>();
  const overlaps: MemoryOverlap[] = [];

  for (let i = 0; i < believed.length; i++) {
    const a = believed[i];
    if (paired.has(a.id)) continue;
    for (let j = i + 1; j < believed.length; j++) {
      const b = believed[j];
      if (paired.has(b.id) || paired.has(a.id)) continue;
      if ((a.projectId ?? null) !== (b.projectId ?? null)) continue;
      const ids: [string, string] = [a.id, b.id];
      if (opts.dismissed?.has(overlapKey(ids))) continue;

      const slotA = slots.get(a.id);
      const slotB = slots.get(b.id);
      if (slotA && slotB && slotsConflict(slotA, slotB)) {
        overlaps.push({ kind: "conflict", ids, noun: slotA.noun });
        paired.add(a.id).add(b.id);
        continue;
      }
      if (numbersOf(a.content) !== numbersOf(b.content)) continue;
      // "lives in Leeds" and "no longer lives in Leeds" share every word and
      // say opposite things.
      if (!!slotA?.negated !== !!slotB?.negated) continue;
      if (!sameSaying(tokens.get(a.id)!, tokens.get(b.id)!)) continue;
      overlaps.push({ kind: "duplicate", ids });
      paired.add(a.id).add(b.id);
    }
  }
  return overlaps;
}

/** Why a memory the person set aside for another is history now, in the words the page shows. */
export function replacedByReason(kind: MemoryOverlapKind, keptContent: string): string {
  const kept = keptContent.length > 80 ? `${keptContent.slice(0, 79)}…` : keptContent;
  return kind === "duplicate"
    ? `Merged: you kept “${kept}”, which says the same.`
    : `You kept “${kept}” instead.`;
}
