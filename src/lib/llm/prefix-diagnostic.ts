/**
 * Prompt-cache miss diagnostic: what changed in a request's prefix since the
 * previous request with the same cache key, told with hashes only.
 *
 * Providers cache a PREFIX in render order (tools, system, messages; the
 * model and the thinking / effort settings are part of the key too). A miss
 * the usage counters report ("cache read fell to 0") says THAT the prefix
 * broke, never WHERE. This module splits one request body into its prefix
 * segments, hashes each, and compares them with the previous request of the
 * same conversation, so a log line can say "history rewritten at message 14"
 * or "tools changed" without carrying a byte of what the person wrote.
 *
 * PRIVACY. Nothing here returns or stores content: segment hashes are
 * truncated SHA-256 digests of the serialized segment, and the cache key
 * itself is hashed before it is kept. The tracker holds hashes and counts.
 *
 * WHAT COUNTS AS THE PREFIX. The bytes as they go on the wire, with the cache
 * markers stripped (`cache_control`, `prompt_cache_breakpoint`): the marker
 * moves every request by design and is not an invalidator. Per-request
 * context the adapter appends after its cacheable region (the volatile tail,
 * the date message) is left out only while it is TRAILING: the same item
 * spliced into the middle of the history is part of the prefix the next
 * request has to match, and the diagnostic has to see it there.
 *
 * Pure: no I/O, no server-only, so tests drive it with literal bodies.
 */
import { createHash } from "node:crypto";
import { isVolatileBlock } from "@/lib/anthropic-cache";

/** The wire dialects whose bodies this module knows how to split. */
export type PrefixWire = "anthropic" | "responses" | "compat" | "gemini";

/** One request's prefix, as hashes. */
export interface PrefixSnapshot {
  wire: PrefixWire;
  /** The model id as sent. Not content; a model switch is a cache reset. */
  model: string;
  /** Request settings that render into the prefix (thinking, effort, speed, tool_choice…). */
  settings: string;
  tools: string;
  /** One hash per system block (Anthropic sends several tiers); [] when the wire has none. */
  system: string[];
  /** One hash per history item, trailing volatile context excluded. */
  messages: string[];
}

export type PrefixVerdict =
  /** No previous request under this key in this process. */
  | { status: "first" }
  /** The previous request's prefix is a prefix of this one: it can be read. */
  | { status: "stable" }
  | {
      status: "changed";
      reason: "model" | "settings" | "tools" | "system" | "history_rewritten" | "history_truncated";
      /** The first diverging system block or history item, where it has one. */
      at?: number;
    };

const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);

/** Which top-level body fields render into each wire's prefix. */
const SETTINGS_KEYS: Record<PrefixWire, readonly string[]> = {
  // `speed` and `tool_choice` invalidate the system / messages tiers
  // (prompt-caching docs, invalidation table); thinking and effort the messages.
  anthropic: ["thinking", "output_config", "speed", "tool_choice"],
  // OpenAI: reasoning effort rewrites hidden instructions; text.format,
  // parallel_tool_calls and the service tier change the rendered prompt.
  responses: ["reasoning", "tool_choice", "text", "parallel_tool_calls", "service_tier"],
  compat: ["reasoning_effort", "thinking", "tool_choice", "parallel_tool_calls", "service_tier", "response_format"],
  gemini: ["generationConfig", "toolConfig"],
};

function digest(value: unknown): string {
  const json = JSON.stringify(value ?? null, (key, v) => (MARKER_KEYS.has(key) ? undefined : v));
  return createHash("sha256").update(json ?? "null").digest("hex").slice(0, 12);
}

/** A cache key as the tracker keeps it: never the raw conversation id. */
export function hashCacheKey(key: string): string {
  return createHash("sha256").update(`prefix:${key}`).digest("hex").slice(0, 16);
}

type Item = Record<string, unknown>;

/**
 * Anthropic renders a string content and a single text block the same way,
 * and history is sent as a string on later turns but as blocks (to carry the
 * marker or a volatile tail) on the turn it is newest. Normalised so that
 * difference is not reported as a rewrite. A volatile block
 * (`volatileTextBlock`) always sits after the conversation marker, so the
 * entry a later request reads ends in front of it: it is left out.
 */
function anthropicMessageForHash(message: Item): Item {
  const content = message.content;
  if (typeof content === "string") return { role: message.role, content: [{ type: "text", text: content }] };
  if (!Array.isArray(content)) return message;
  return { role: message.role, content: (content as unknown[]).filter((block) => !isVolatileBlock(block)) };
}

/**
 * Split one request body into prefix segments.
 *
 * `volatile` names items (by identity) the adapter appended for this request
 * only: the date message, a volatile-tail message. They are dropped from the
 * END of the history; one in the middle stays, because there it is part of
 * the prefix.
 */
export function snapshotPrefix(wire: PrefixWire, body: unknown, volatile?: ReadonlySet<unknown>): PrefixSnapshot {
  const b = (body ?? {}) as Item;
  const settings: Item = {};
  for (const key of SETTINGS_KEYS[wire]) if (b[key] !== undefined) settings[key] = b[key];

  let system: unknown[] = [];
  let items: unknown[] = [];
  let tools: unknown = b.tools ?? null;
  switch (wire) {
    case "anthropic":
      system = typeof b.system === "string" ? [b.system] : Array.isArray(b.system) ? (b.system as unknown[]) : [];
      items = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
      break;
    case "responses":
      // `instructions` renders first; a GPT-5.6+ system prompt rides as the first input item instead.
      system = typeof b.instructions === "string" ? [b.instructions] : [];
      items = Array.isArray(b.input) ? (b.input as unknown[]) : [];
      break;
    case "compat":
      items = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
      break;
    case "gemini":
      system = b.systemInstruction !== undefined ? [b.systemInstruction] : [];
      items = Array.isArray(b.contents) ? (b.contents as unknown[]) : [];
      tools = b.tools ?? null;
      break;
  }

  let end = items.length;
  while (end > 0 && volatile?.has(items[end - 1])) end -= 1;
  const kept = items.slice(0, end);
  const messages = kept.map((item) => digest(wire === "anthropic" ? anthropicMessageForHash(item as Item) : item));

  return {
    wire,
    model: typeof b.model === "string" ? b.model : "",
    settings: digest(settings),
    tools: digest(tools),
    system: system.map((block) => digest(block)),
    messages,
  };
}

/**
 * Compare a request with the previous one under the same key, in render
 * order: the first difference found is the one that invalidated everything
 * after it, so it is the only one reported.
 */
export function comparePrefix(previous: PrefixSnapshot | undefined, next: PrefixSnapshot): PrefixVerdict {
  if (!previous) return { status: "first" };
  if (previous.model !== next.model || previous.wire !== next.wire) return { status: "changed", reason: "model" };
  if (previous.tools !== next.tools) return { status: "changed", reason: "tools" };
  const systemLength = Math.max(previous.system.length, next.system.length);
  for (let i = 0; i < systemLength; i++) {
    if (previous.system[i] !== next.system[i]) return { status: "changed", reason: "system", at: i };
  }
  // Settings render ahead of the messages tier on every wire this knows
  // (and ahead of tools on some models); reported after tools and system so a
  // turn that changed both names the larger reset.
  if (previous.settings !== next.settings) return { status: "changed", reason: "settings" };
  const overlap = Math.min(previous.messages.length, next.messages.length);
  for (let i = 0; i < overlap; i++) {
    if (previous.messages[i] !== next.messages[i]) return { status: "changed", reason: "history_rewritten", at: i };
  }
  if (next.messages.length < previous.messages.length) {
    return { status: "changed", reason: "history_truncated", at: next.messages.length };
  }
  return { status: "stable" };
}

/** A short label for logs: "stable", "first", "history_rewritten@14". */
export function verdictLabel(verdict: PrefixVerdict): string {
  if (verdict.status !== "changed") return verdict.status;
  return verdict.at === undefined ? verdict.reason : `${verdict.reason}@${verdict.at}`;
}

export interface PrefixTracker {
  /** Compare `next` with the recent snapshots under `key`, then remember `next`. */
  observe(key: string | undefined, next: PrefixSnapshot): PrefixVerdict;
  readonly size: number;
}

/** How far into the prefix a verdict got before it diverged: higher is a smaller miss. */
function depth(verdict: PrefixVerdict): number {
  if (verdict.status !== "changed") return Number.POSITIVE_INFINITY;
  switch (verdict.reason) {
    case "model":
      return 0;
    case "tools":
      return 1;
    case "system":
      return 2 + (verdict.at ?? 0) / 100;
    case "settings":
      return 3;
    default:
      return 4 + (verdict.at ?? 0);
  }
}

/**
 * The recent snapshots per cache key, bounded by count and age. Per process,
 * like the provider cache it is a window onto: an entry older than the
 * longest provider TTL Juno uses (1h) could not have been read anyway.
 *
 * SEVERAL per key, because a request can read an entry any earlier request
 * wrote, not only the one just before it. A tool loop's round N reads round
 * N-1; the next turn reads the entry the previous turn's FIRST round wrote at
 * the user's message, since the tool rounds after it are re-sent as text
 * notes. The verdict is "stable" when any recent snapshot is a prefix of this
 * request, and otherwise the divergence that got furthest.
 */
export function createPrefixTracker(
  opts: { maxKeys?: number; perKey?: number; ttlMs?: number; now?: () => number } = {}
): PrefixTracker {
  const maxKeys = opts.maxKeys ?? 2000;
  const perKey = opts.perKey ?? 8;
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Array<{ at: number; snapshot: PrefixSnapshot }>>();
  return {
    observe(key, next) {
      if (!key) return { status: "first" };
      const id = hashCacheKey(key);
      const at = now();
      const recent = (entries.get(id) ?? []).filter((entry) => at - entry.at <= ttlMs);
      let verdict: PrefixVerdict = { status: "first" };
      for (const entry of recent) {
        const candidate = comparePrefix(entry.snapshot, next);
        if (verdict.status === "first" || depth(candidate) > depth(verdict)) verdict = candidate;
        if (candidate.status === "stable") break;
      }
      recent.push({ at, snapshot: next });
      entries.delete(id);
      entries.set(id, recent.slice(-perKey));
      while (entries.size > maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return verdict;
    },
    get size() {
      return entries.size;
    },
  };
}
