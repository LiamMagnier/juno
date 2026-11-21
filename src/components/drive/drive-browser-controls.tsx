"use client";

import * as React from "react";
import { ChevronRight } from "@/components/ui/icons";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { DriveBrowseEntry, DriveBrowsePage } from "@/lib/projects/drive-source";

type Location = "folder" | "shared";
type Crumb = Pick<DriveBrowseEntry, "id" | "name">;
type BrowseError = { message: string; code?: string };

const roots: Record<Location, Crumb> = {
  folder: { id: "root", name: "My Drive" },
  shared: { id: "root", name: "Shared with me" },
};

export function useDriveBrowser(endpoint: string, enabled: boolean) {
  const [location, setLocation] = React.useState<Location>("folder");
  const [path, setPath] = React.useState([roots.folder]);
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [entries, setEntries] = React.useState<DriveBrowseEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<BrowseError | null>(null);
  const [pageError, setPageError] = React.useState<string | null>(null);
  const pending = React.useRef<AbortController | null>(null);
  const parent = path[path.length - 1];

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim().slice(0, 200)), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = React.useCallback(async (next: string | null = null) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const params = new URLSearchParams({ view: search ? "search" : location === "shared" && path.length === 1 ? "shared" : "folder" });
    if (search) params.set("q", search);
    else params.set("parent", parent.id);
    if (next) params.set("cursor", next);
    if (!next) {
      setEntries([]);
      setCursor(null);
      setError(null);
    }
    setPageError(null);
    setLoading(!next);
    setLoadingMore(Boolean(next));
    const fail = (failure: BrowseError) => {
      if (next && failure.code !== "connector_reconnect" && failure.code !== "reconnect") setPageError(failure.message);
      else setError(failure);
    };
    try {
      const response = await fetch(`${endpoint}?${params}`, { signal: controller.signal });
      const data = await response.json().catch(() => null) as (Partial<DriveBrowsePage> & { code?: string; error?: string }) | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !Array.isArray(data?.entries)) {
        fail({ message: data?.error ?? "Couldn’t reach Google Drive. Try again.", code: data?.code });
        return;
      }
      const { entries: page, nextCursor } = data;
      setEntries((previous) => next ? [...new Map([...previous, ...page].map((entry) => [entry.id, entry])).values()] : page);
      setCursor(nextCursor && nextCursor !== next ? nextCursor : null);
    } catch {
      if (!controller.signal.aborted) fail({ message: "Couldn’t reach Google Drive. Check your connection and try again." });
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [endpoint, location, parent.id, path.length, search]);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
    return () => pending.current?.abort();
  }, [enabled, load]);

  const changeLocation = React.useCallback((next: Location) => {
    setLocation(next);
    setPath([roots[next]]);
    setQuery("");
    setSearch("");
  }, []);
  const enter = (entry: Crumb) => {
    setPath((current) => [...(search ? current.slice(0, 1) : current), { id: entry.id, name: entry.name }]);
    setQuery("");
    setSearch("");
  };
  const backTo = (index: number) => setPath((current) => current.slice(0, index + 1));
  return { location, changeLocation, path, parent, query, setQuery, search, entries, cursor, loading, loadingMore, error, setError, pageError, load, enter, backTo };
}

export function DriveBrowserControls({ browser }: { browser: ReturnType<typeof useDriveBrowser> }) {
  const { location, changeLocation, query, setQuery, search, loading, path, backTo } = browser;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl value={location} onChange={changeLocation} ariaLabel="Where to look" columns="content" options={[
          { value: "folder", label: roots.folder.name },
          { value: "shared", label: roots.shared.name },
        ]} />
        <SearchField value={query} onValueChange={setQuery} label="Search Google Drive" busy={loading && !!search} className="min-w-0 flex-[1_1_15rem]" />
      </div>
      {!search && path.length > 1 && (
        <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 text-ui">
          {path.map((crumb, index) => (
            <React.Fragment key={`${crumb.id}-${index}`}>
              {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />}
              {index === path.length - 1 ? (
                <span className="max-w-full truncate px-1 font-medium" aria-current="location">{crumb.name}</span>
              ) : (
                <button type="button" className="max-w-full truncate rounded-control px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground coarse:min-h-11" onClick={() => backTo(index)}>{crumb.name}</button>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
    </>
  );
}
