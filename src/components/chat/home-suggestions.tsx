"use client";

import * as React from "react";
import { AppIcons } from "@/lib/app-icons";
import { ConnectorMark } from "@/components/connections/connector-logos";
import type { ContextToken } from "@/lib/chat/context-tokens";
import { mentionToToken, type MentionItem, type MentionSearchResult } from "@/lib/mentions/types";

/*
 * THE HOME'S SUGGESTIONS: at most three, derived from the person's own state,
 * and none when nothing real exists (PRODUCT_REFOUNDATION §5, INTERACTION_SPEC
 * empty states: "an agent who needs them, an app just connected, a project
 * touched today"; never generic starters).
 *
 *   an app connected in the last three days   "Use GitHub": puts the app in
 *                                              the sentence as a token
 *   a project touched today                    "Continue in Atlas launch":
 *                                              the new chat is filed there
 *
 * An agent who needs an answer is NOT offered here: the sidebar already asks,
 * and one question is asked in one place (critique 1: "no repeated question").
 *
 * One lookup per session through the mention search the composer already
 * uses (owner-scoped, rate-limited); a failure or a signed-out preview shows
 * nothing, because suggestions are never required.
 */

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

let cached: { at: number; items: MentionItem[] } | null = null;
const CACHE_MS = 5 * 60_000;

export function HomeSuggestions({
  onPickProject,
  load,
}: {
  /** Files the new chat in a project (the composer's "Add to project"). */
  onPickProject?: (projectId: string) => void;
  /** Dev galleries pass fixtures; production asks GET /api/mentions. */
  load?: (signal: AbortSignal) => Promise<MentionSearchResult>;
}) {
  const [items, setItems] = React.useState<MentionItem[]>(() => (cached && Date.now() - cached.at < CACHE_MS ? cached.items : []));
  React.useEffect(() => {
    if (cached && Date.now() - cached.at < CACHE_MS) return;
    const abort = new AbortController();
    const run = async () => {
      try {
        const result = load
          ? await load(abort.signal)
          : await fetch("/api/mentions?kinds=app,project&limit=3", { signal: abort.signal }).then((response) =>
              response.ok ? (response.json() as Promise<MentionSearchResult>) : Promise.reject(new Error(String(response.status))),
            );
        cached = { at: Date.now(), items: result.items };
        if (!abort.signal.aborted) setItems(result.items);
      } catch {
        /* Nothing real to suggest is the same as nothing to suggest. */
      }
    };
    void run();
    return () => abort.abort();
  }, [load]);

  const suggestions = React.useMemo(() => homeSuggestions(items), [items]);
  if (suggestions.length === 0) return null;

  const choose = (suggestion: HomeSuggestion) => {
    if (suggestion.kind === "project") {
      onPickProject?.(suggestion.item.id);
      window.dispatchEvent(new CustomEvent("juno:composer-focus"));
      return;
    }
    const token: ContextToken = mentionToToken(suggestion.item);
    window.dispatchEvent(new CustomEvent("juno:composer-insert-token", { detail: { token, item: suggestion.item } }));
  };

  return (
    <div className="chat-home__chips" role="group" aria-label="Suggestions">
      {suggestions.map((suggestion) => (
        <button key={suggestion.key} type="button" className="chat-home__chip" onClick={() => choose(suggestion)}>
          {suggestion.kind === "app" ? (
            <ConnectorMark id={suggestion.item.connectorId ?? suggestion.item.id} className="size-4" />
          ) : (
            <AppIcons.projects aria-hidden="true" className="size-4" motion="none" />
          )}
          <span>{suggestion.label}</span>
        </button>
      ))}
    </div>
  );
}
