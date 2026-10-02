/**
 * The home's suggestions, derived from the person's own state: at most three,
 * and none when nothing real exists (PRODUCT_REFOUNDATION §5). Pure, so the
 * rule is tested (tests/home-suggestions.test.ts); the component that draws
 * them is src/components/chat/home-suggestions.tsx.
 *
 *   an app connected in the last three days   "Use GitHub"
 *   a project touched today                    "Continue in Atlas launch"
 *
 * An agent who needs an answer is never offered: the sidebar already asks.
 */
import type { MentionItem } from "@/lib/mentions/types";

export type HomeSuggestion =
  | { kind: "app"; key: string; label: string; item: MentionItem }
  | { kind: "project"; key: string; label: string; item: MentionItem };

const APP_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 3;

/** The suggestions a lookup's rows support, newest first, at most three. Pure, so the rule is tested. */
export function homeSuggestions(items: readonly MentionItem[], now = Date.now()): HomeSuggestion[] {
  const today = new Date(now);
  const sameDay = (iso?: string) => {
    if (!iso) return false;
    const at = new Date(iso);
    return at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  };
  const at = (iso?: string) => (iso ? new Date(iso).getTime() : 0);
  const out: Array<HomeSuggestion & { at: number }> = [];
  for (const item of items) {
    if (item.kind === "app" && item.connected !== false && !item.needsConnection) {
      const when = at(item.updatedAt);
      if (when && now - when <= APP_FRESH_MS && when <= now + 60_000) {
        out.push({ kind: "app", key: `app:${item.id}`, label: `Use ${item.label}`, item, at: when });
      }
    } else if (item.kind === "project" && sameDay(item.updatedAt)) {
      out.push({ kind: "project", key: `project:${item.id}`, label: `Continue in ${item.label}`, item, at: at(item.updatedAt) });
    }
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ at: _at, ...rest }) => {
      void _at;
      return rest;
    });
}

