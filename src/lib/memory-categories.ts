/**
 * The facets a remembered fact can belong to, and the lifecycle states it can
 * be in.
 *
 * Before this, every MemoryEntry was an undifferentiated sentence. That made
 * three things impossible at once: the memory page could not explain *why* a
 * fact was kept, retrieval could not prefer durable facts over incidental ones,
 * and nothing could expire — "flying to Lisbon on Friday" aged silently into a
 * permanent belief about the user.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports: the memory page
 * renders these labels in the browser and the lifecycle tests import them
 * without a database.
 */

export const MEMORY_CATEGORIES = [
  "identity",
  "preferences",
  "goals",
  "studies",
  "workflows",
  "projects",
  "relationships",
  "temporary",
  "suppression",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * Copy shown on the memory page. `description` answers the question a user
 * actually asks of a category chip — "what counts as this?" — rather than
 * restating the label.
 */
export const MEMORY_CATEGORY_META: Record<MemoryCategory, { label: string; description: string }> = {
  identity: {
    label: "Identity",
    description: "Who you are — your role, where you live and work, the languages you speak.",
  },
  preferences: {
    label: "Preferences",
    description: "How you like things done, and what you would rather avoid.",
  },
  goals: {
    label: "Goals",
    description: "What you are working towards, beyond any single conversation.",
  },
  studies: {
    label: "Studies",
    description: "Courses, exams and subjects you are learning.",
  },
  workflows: {
    label: "Workflows",
    description: "The tools, stacks and routines you work in day to day.",
  },
  projects: {
    label: "Projects",
    description: "Things you are building, and the work around them.",
  },
  relationships: {
    label: "People",
    description: "The people you mention — family, colleagues, collaborators.",
  },
  temporary: {
    label: "Temporary",
    description: "True for now, not forever. Juno forgets these on its own.",
  },
  suppression: {
    label: "Never remember",
    description: "Statements you asked Juno to forget. They block future recall.",
  },
};

/**
 * The catch-all when the classifier recognises nothing specific. `identity` is
 * the honest default: an extracted fact is by construction a durable statement
 * about the user, so the worst case is a fact filed one drawer over — not a
 * fact claiming to be something it isn't.
 */
export const DEFAULT_MEMORY_CATEGORY: MemoryCategory = "identity";

/**
 * Retrieval tie-breaker. Identity and preferences shape *every* answer, so they
 * earn context space even when the current question doesn't mention them;
 * temporary notes have to earn their place by being relevant right now.
 */
export const MEMORY_CATEGORY_WEIGHT: Record<MemoryCategory, number> = {
  identity: 0.12,
  preferences: 0.12,
  workflows: 0.08,
  projects: 0.06,
  goals: 0.05,
  studies: 0.05,
  relationships: 0.04,
  temporary: 0,
  suppression: 0,
};

/** How long a `temporary` fact is believed before the sweep retires it. */
export const TEMPORARY_MEMORY_TTL_DAYS = 30;

export const MEMORY_STATUSES = ["active", "superseded", "contradicted", "suppressed", "expired"] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * Only `active` entries reach a model. The other four exist so that a memory
 * that stopped being true leaves a trail instead of vanishing — "why did Juno
 * stop believing that?" has to have an answer.
 */
export const MEMORY_STATUS_META: Record<MemoryStatus, { label: string; description: string }> = {
  active: { label: "In use", description: "Juno may use this as context." },
  superseded: { label: "Replaced", description: "Something newer took its place. Kept so you can see the change." },
  contradicted: {
    label: "Conflicting",
    description: "It clashes with a fact you saved yourself, so Juno does not use it.",
  },
  suppressed: { label: "Forgotten", description: "You asked Juno to forget this. It will not be relearned." },
  expired: { label: "Expired", description: "It was only true for a while, and that while has passed." },
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value);
}

/**
 * Label for a category read back from the database. Rows written before Memory
 * v2 have `category = null`, and a row written by a newer build could carry a
 * category this one has never heard of — both render as "Uncategorised" rather
 * than crashing the page or showing a raw enum value.
 */
export function memoryCategoryLabel(value: string | null | undefined): string {
  return isMemoryCategory(value) ? MEMORY_CATEGORY_META[value].label : "Uncategorised";
}

export function memoryStatusLabel(value: string | null | undefined): string {
  return isMemoryStatus(value) ? MEMORY_STATUS_META[value].label : "Unknown";
}

/**
 * Confidence as words. A number between 0 and 1 is meaningless to a reader, and
 * "87%" implies a precision this classifier does not have.
 */
export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "You told Juno";
  if (confidence >= 0.6) return "Confident";
  return "Inferred";
}
