import { createHash } from "node:crypto";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";

/**
 * Suggestions are a small, paid decoration on a finished reply. Reopening that
 * reply on two devices must not start two identical model walks. This cache is
 * process-local, bounded, and short-lived; ownership and policy are still read
 * by the route before EVERY lookup. No transcript text is retained in a key.
 */
export function followUpCacheKey(input: {
  userId: string;
  conversationId: string;
  model: string;
  conversationProvider: string | null | undefined;
  policy: BackgroundProviderPolicy;
  system: string;
  messages: readonly { id: string; role: string; content: string }[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      userId: input.userId,
      conversationId: input.conversationId,
      model: input.model,
      conversationProvider: input.conversationProvider ?? null,
      policy: {
        mode: input.policy.mode,
        selectedProvider: input.policy.selectedProvider ?? null,
        allowedProviders: input.policy.allowedProviders ? [...input.policy.allowedProviders].sort() : null,
      },
      system: input.system,
      // Include identities AND content: a regenerated sibling or an edit on
      // the same id must never inherit suggestions for the previous answer.
      messages: input.messages.map(({ id, role, content }) => ({ id, role, content })),
    }))
    .digest("hex");
}

export interface FollowUpCache {
  getOrCreate(key: string, generate: () => Promise<string[] | null>): Promise<string[]>;
}

export function createFollowUpCache(options: {
  ttlMs?: number;
  maxEntries?: number;
  maxPending?: number;
  now?: () => number;
} = {}): FollowUpCache {
  const ttlMs = Math.max(1, options.ttlMs ?? 10 * 60_000);
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? 64));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { suggestions: string[]; expiresAt: number }>();
  const pending = new Map<string, Promise<string[]>>();

  return {
    async getOrCreate(key, generate) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) {
        // LRU order is independent of expiry: a popular answer still expires
        // ten minutes after generation, rather than staying forever.
        entries.delete(key);
        entries.set(key, hit);
        return [...hit.suggestions];
      }
      if (hit) entries.delete(key);
      const held = pending.get(key);
      if (held) return [...await held];

      // Decoration may be omitted under load. Starting an untracked call when
      // the flight map is full would remove the bound and the deduplication.
      if (pending.size >= maxPending) return [];
      const task = Promise.resolve().then(generate).then((result) => result ? [...result] : []);
      pending.set(key, task);
      try {
        const suggestions = await task;
        // An outage, a budget/policy denial or an unusable answer is not a
        // reusable success. The next request is allowed to recover immediately.
        if (suggestions.length > 0) {
          const at = now();
          for (const [storedKey, stored] of entries) {
            if (stored.expiresAt <= at) entries.delete(storedKey);
          }
          while (entries.size >= maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
          }
          entries.set(key, { suggestions: [...suggestions], expiresAt: at + ttlMs });
        }
        return [...suggestions];
      } finally {
        if (pending.get(key) === task) pending.delete(key);
      }
    },
  };
}
