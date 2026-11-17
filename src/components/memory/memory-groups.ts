import { isMemoryCategory, type MemoryCategory } from "@/lib/memory-categories";
import { memorySourceKind } from "@/lib/memory-provenance";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { isRetired, type Memory } from "@/components/memory/memory-model";
import { DATE_BUCKETS, dateBucket } from "@/components/memory/memory-time";

/*
 * HOW THE MEMORY LIST IS GROUPED: by what a memory is about, by where it came
 * from, or by when it arrived.
 *
 * The list used to be cut into the classifier's nine categories, each a
 * heading with its own description: Identity, Preferences, Goals, Studies,
 * Workflows, Projects, People, Temporary. Nine headings over thirty facts is
 * a filing cabinet, and three of them ("Workflows", "Projects", "Studies")
 * were words the classifier needed, not words a person sorts their life by.
 * Five groups answer the question a reader arrives with ("what does it think
 * about me, my work, how I like things"), and the nine still steer retrieval
 * underneath, unchanged.
 *
 * By source answers the other question the page has to make obvious: which
 * of these did I say, and which did it pick up. Each group is newest first,
 * since the fact most likely to be wrong is the one learned last.
 *
 * Pure, so the grouping is tested without rendering (tests/memory-groups.test.ts).
 */

export type MemoryGrouping = "topic" | "source" | "newest";

export const MEMORY_GROUPINGS: readonly { id: MemoryGrouping; label: string }[] = [
  { id: "topic", label: "Topic" },
  { id: "source", label: "Source" },
  { id: "newest", label: "Newest" },
];

export interface MemoryGroup {
  id: string;
  label: string;
  /** One sentence saying what belongs here; omitted where the label says it all. */
  description?: string;
  rows: Memory[];
}

/** The five topic groups, in reading order, and the categories each one gathers. */
export const TOPIC_GROUPS: readonly { id: string; label: string; description: string; categories: readonly MemoryCategory[] }[] = [
  {
    id: "about",
    label: "About you",
    description: "Who you are, where you live, and the people you mention.",
    categories: ["identity", "relationships"],
  },
  {
    id: "work",
    label: "Your work",
    description: "What you do, the tools you use, and what you’re building.",
    categories: ["workflows", "projects"],
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "How you like answers, and how you like things done.",
    categories: ["preferences"],
  },
  {
    id: "goals",
    label: "Goals and learning",
    description: "What you’re working towards, and what you’re studying.",
    categories: ["goals", "studies"],
  },
  {
    id: "now",
    label: "For now",
    description: `True for a while. ${PRODUCT_NAME} lets these go on its own.`,
    categories: ["temporary"],
  },
];

const OTHER_TOPIC = {
  id: "other",
  label: "Other",
  description: `Kept before ${PRODUCT_NAME} filed memories by subject.`,
};

/** The topic group a category belongs to: rows with no category, or one this build has never heard of, are "other". */
export function topicGroupOf(category: string | null): string {
  if (!isMemoryCategory(category)) return OTHER_TOPIC.id;
  return TOPIC_GROUPS.find((group) => group.categories.includes(category))?.id ?? OTHER_TOPIC.id;
}

export type SourceGroupId = "you" | "chats" | "imported" | "other";

export const SOURCE_GROUPS: readonly { id: SourceGroupId; label: string; description: string }[] = [
  { id: "you", label: `You told ${PRODUCT_NAME}`, description: "Added or corrected by you, or said with “remember”." },
  { id: "chats", label: "Learned from your chats", description: `What ${PRODUCT_NAME} picked up while you talked.` },
  { id: "imported", label: "Imported", description: "Brought over from another assistant." },
  { id: "other", label: "Other", description: "From before memories recorded where they came from." },
];

/**
 * Where a memory came from, as one of four groups. A fact the person stated
 * (typed here, corrected, or a chat's "remember that") is theirs whichever
 * door it came through; an inferred one from a chat is the chat's.
 */
export function sourceGroupOf(memory: Pick<Memory, "sourceRef" | "source">): SourceGroupId {
  const kind = memorySourceKind(memory);
  if (kind === "import") return "imported";
  if (kind === "manual" || kind === "edit" || kind === "native") return "you";
  if (kind === "chat") return memory.source === "MANUAL" ? "you" : "chats";
  return memory.source === "MANUAL" ? "you" : "other";
}

const newestFirst = (a: Memory, b: Memory) =>
  (b.observedAt ?? b.createdAt).localeCompare(a.observedAt ?? a.createdAt) || b.createdAt.localeCompare(a.createdAt);

/**
 * The believed facts, grouped. Retired rows and the block-list are left out:
 * the page shows those apart ("No longer used"), because a list of what
 * memory holds that also lists what it let go of reads as a contradiction.
 * Empty groups are dropped.
 */
export function groupMemories(facts: readonly Memory[], by: MemoryGrouping, now: Date = new Date()): MemoryGroup[] {
  const active = facts.filter((memory) => memory.kind === "FACT" && !isRetired(memory)).sort(newestFirst);

  if (by === "newest") {
    return DATE_BUCKETS.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      rows: active.filter((memory) => dateBucket(memory.observedAt ?? memory.createdAt, now) === bucket.id),
    })).filter((group) => group.rows.length > 0);
  }

  if (by === "source") {
    return SOURCE_GROUPS.map((group) => ({
      ...group,
      rows: active.filter((memory) => sourceGroupOf(memory) === group.id),
    })).filter((group) => group.rows.length > 0);
  }

  return [...TOPIC_GROUPS, OTHER_TOPIC]
    .map(({ id, label, description }) => ({
      id,
      label,
      description,
      rows: active.filter((memory) => topicGroupOf(memory.category) === id),
    }))
    .filter((group) => group.rows.length > 0);
}

/**
 * Search earns its field once the list is longer than a screen can take in
 * at a glance. Below that, a search box over eight sentences is chrome; the
 * reader finds the fact faster by reading. A query already typed keeps it.
 */
export const SEARCH_FROM = 9;

export function offerSearch(activeCount: number, query = ""): boolean {
  return activeCount >= SEARCH_FROM || query.trim().length > 0;
}

/** Everything a search should find a memory by: its words, its group's name, its project. */
export function memorySearchText(memory: Memory): string {
  const topic = [...TOPIC_GROUPS, OTHER_TOPIC].find((group) => group.id === topicGroupOf(memory.category));
  return [memory.content, memory.projectName ?? "", topic?.label ?? "", memory.reason ?? ""].join(" ").toLowerCase();
}
