"use client";

/**
 * The ⌘K palette's message search: the open thread's messages at once (in
 * memory), other Code sessions' messages from unified search after a short
 * pause in typing, cancelled when the query changes or the palette closes.
 */
import * as React from "react";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { codeSessionHits, messageMatches, type MessageMatch } from "@/lib/code-v2/palette-search";

const DEBOUNCE_MS = 180;

export function usePaletteMessageSearch({
  query,
  items,
  threads,
  openId,
}: {
  query: string;
  items: readonly TurnItem[];
  threads: readonly { id: string; title: string }[];
  openId: string;
}): { here: MessageMatch[]; elsewhere: MessageMatch[]; searching: boolean } {
  const here = React.useMemo(() => messageMatches(items, query), [items, query]);
  const [elsewhere, setElsewhere] = React.useState<MessageMatch[]>([]);
  const [searching, setSearching] = React.useState(false);
  // Keyed on the list's content, not its identity: the palette's caller builds a fresh array on
  // every render, and a streaming turn re-renders several times a second, which would abort the
  // other-sessions search before it ever answered.
  const threadsKey = threads.map((t) => `${t.id}\u0001${t.title}`).join("\u0002");
  const titles = React.useMemo(
    () => new Map(threads.map((t) => [t.id, t.title])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- threadsKey is the content of threads
    [threadsKey],
  );

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || titles.size === 0) {
      setElsewhere([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?${new URLSearchParams({ q, types: "message", limit: "25" })}`, { signal: controller.signal, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { groups?: { hits: Parameters<typeof codeSessionHits>[0] }[] } | null) => {
          if (controller.signal.aborted) return;
          const hits = (body?.groups ?? []).flatMap((g) => g.hits ?? []);
          setElsewhere(codeSessionHits(hits, titles, openId));
          setSearching(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, titles, openId]);

  return { here, elsewhere, searching };
}
