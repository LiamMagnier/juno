import { parseStoredDesignDocument } from "@/lib/design/migrations";
import type { DesignDocument } from "@/lib/design/types";

/**
 * THE RE-EMIT GUARD (04-MERGE-PLAN §2.7, §8.3; audit X-05, X-06).
 *
 * When a chat turn re-emits an artifact's identifier, the new body used to
 * become the current version unconditionally. Two things are lost that way:
 * a person's hand edits, which the model never saw and silently overwrote, and
 * a design's structure (components, variables, animations, interactions,
 * comments, effects), which the compact form the model writes cannot carry, so
 * a follow-up "make the title bigger" dropped every animation the person had
 * built.
 *
 * Instead of appending, such a re-emit is HELD as a suggestion
 * (`ArtifactProposal`): not a version, never synced, never shared, applied only
 * when a person says so. Everything here is pure, so the rules can be tested
 * without a database and read in one place; the store (`artifacts-store.ts`)
 * reads the rows, asks `decideReemit`, and writes what it answers.
 */

export type ReemitReason = "edited" | "structure" | "both";

export type ReemitDecision = { action: "append" } | { action: "suggest"; reason: ReemitReason; summary: string };

export interface ReemitInput {
  /** The artifact's stored type ("DESIGN", "HTML", …). Never changes (R0). */
  type: string;
  /** How the current version came to be; null on rows older than the column. */
  currentOrigin: string | null;
  /** The current version's body; null when the row could not be read. */
  currentContent: string | null;
  /** The re-emitted body in its STORED form (a DESIGN already expanded). */
  nextContent: string;
  /** `reemitGuardEnabled()`; off restores "every re-emit appends". */
  enabled: boolean;
}

/** The person's own words for rule 1, shown on the card and the bar. */
export const EDITED_SUMMARY = "You edited this after Juno's last version";

/**
 * Whether a re-emit appends a version or waits as a suggestion.
 *
 * Rule 1: the current version was written by a person (`edit` or `restore`).
 * That origin is an exact signal, not a heuristic: a design fold only ever
 * rewrites an `edit` row into an `edit` row and never into Juno's own
 * `generated` one (`allocatesCheckpoint`, operations.ts), so the first hand
 * change after Juno's last write always leaves an `edit` on top.
 *
 * Rule 2: a DESIGN re-emit would remove structure the current version has
 * (`designStructureLoss`), whoever wrote that version.
 *
 * Rule 3: otherwise it appends. That includes a null origin, a legacy row from
 * before the column: nothing says a person touched it, and treating the
 * unknown as "edited" would hold every re-emit on every old artifact.
 */
export function decideReemit(input: ReemitInput): ReemitDecision {
  if (!input.enabled) return { action: "append" };
  const edited = input.currentOrigin === "edit" || input.currentOrigin === "restore";
  const loss = input.type === "DESIGN" ? designStructureLoss(input.currentContent, input.nextContent) : null;
  if (!edited && !loss) return { action: "append" };
  const parts: string[] = [];
  if (edited) parts.push(EDITED_SUMMARY);
  if (loss) parts.push(`Would remove ${describeStructureLoss(loss)}`);
  return {
    action: "suggest",
    reason: edited && loss ? "both" : edited ? "edited" : "structure",
    summary: parts.join(" · "),
  };
}

/** What a design has that the compact authoring form cannot bring back. */
export const DESIGN_STRUCTURE_CATEGORIES = [
  "components",
  "variables",
  "animations",
  "interactions",
  "comments",
  "effects",
] as const;

export type DesignStructureCategory = (typeof DESIGN_STRUCTURE_CATEGORIES)[number];

/** How many of each a re-emit would remove; only the categories that drop. */
export type DesignStructureLoss = Partial<Record<DesignStructureCategory, number>>;

/** The counts `designStructureLoss` compares. `effects` sums every node's stack. */
export function designStructureCounts(document: DesignDocument): Record<DesignStructureCategory, number> {
  let effects = 0;
  for (const node of Object.values(document.nodes)) effects += node.effects?.length ?? 0;
  return {
    components: Object.keys(document.components).length,
    variables: Object.keys(document.variables).length,
    animations: Object.keys(document.animations).length,
    interactions: Object.keys(document.interactions).length,
    comments: document.comments.length,
    effects,
  };
}

function parseOrNull(content: string | null): DesignDocument | null {
  if (!content) return null;
  try {
    return parseStoredDesignDocument(content);
  } catch {
    return null;
  }
}

/**
 * What `next` would remove from `current`, or null when it removes nothing.
 *
 * Any category whose count falls from above zero counts as loss, by how much it
 * falls. Counts, not identities: a re-emit that swaps one animation for another
 * is a rewrite the person asked for, and matching ids across a model rewrite is
 * guesswork (the model re-mints them).
 *
 * An unreadable current document is "no loss": there is nothing structured to
 * protect, and holding every re-emit of a broken design would leave it broken.
 * An unreadable `next` is also "no loss", because it is never stored: the
 * store refuses a body the editor cannot open before it gets this far.
 */
export function designStructureLoss(current: string | null, next: string): DesignStructureLoss | null {
  const before = parseOrNull(current);
  if (!before) return null;
  const after = parseOrNull(next);
  if (!after) return null;
  const was = designStructureCounts(before);
  const now = designStructureCounts(after);
  const loss: DesignStructureLoss = {};
  let any = false;
  for (const category of DESIGN_STRUCTURE_CATEGORIES) {
    if (was[category] > 0 && now[category] < was[category]) {
      loss[category] = was[category] - now[category];
      any = true;
    }
  }
  return any ? loss : null;
}

const NOUNS: Record<DesignStructureCategory, [string, string]> = {
  components: ["component", "components"],
  variables: ["variable", "variables"],
  animations: ["animation", "animations"],
  interactions: ["interaction", "interactions"],
  comments: ["comment", "comments"],
  effects: ["effect", "effects"],
};

/**
 * "3 animations and 1 component": largest loss first, so the sentence leads
 * with what matters most, ties in the category order above.
 */
export function describeStructureLoss(loss: DesignStructureLoss): string {
  const items = DESIGN_STRUCTURE_CATEGORIES.flatMap((category, order) => {
    const count = loss[category] ?? 0;
    return count > 0 ? [{ count, order, text: `${count} ${NOUNS[category][count === 1 ? 0 : 1]}` }] : [];
  }).sort((a, b) => b.count - a.count || a.order - b.order);
  const words = items.map((item) => item.text);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What a proposal's `payload` column holds. `content` is the STORED form. */
export interface ProposalPayload {
  content: string;
  title: string;
  language: string | null;
}

/**
 * Read a payload back defensively: it is a JSON column, and a row written by a
 * later release (M4 adds roles and kinds) must not crash an older reader.
 * Null means "not a payload this build can apply".
 */
export function readProposalPayload(raw: unknown): ProposalPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.content !== "string") return null;
  return {
    content: value.content,
    title: typeof value.title === "string" ? value.title : "",
    language: typeof value.language === "string" ? value.language : null,
  };
}

/** The status a proposal is written with, and the three it can end in. */
export const PROPOSAL_STATUS = {
  pending: "PENDING",
  applied: "APPLIED",
  discarded: "DISCARDED",
  stale: "STALE",
} as const;

/** The one taint value R1 writes: the turn read text Juno did not author. */
export const UNTRUSTED_INPUT_TAINT = "untrusted-input";
