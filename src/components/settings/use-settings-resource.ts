"use client";

import * as React from "react";

/*
 * What each section last fetched, for the life of the page. Sections remount
 * on every switch (the pane keys them), so without this every visit to
 * Connectors, Devices or Plan & usage started from a skeleton again. Now a
 * return visit draws the last answer at once and refreshes it underneath.
 *
 * Every mounted reader of a URL hears each new answer, not just the one that
 * set it: a write can settle after the section that made it has remounted
 * (Connectors rolling a refused policy back, say), and the new mount has to
 * show the rollback rather than the optimistic value it was drawn with.
 */
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<(value: unknown) => void>>();

function publish(url: string, value: unknown) {
  cache.set(url, value);
  listeners.get(url)?.forEach((listener) => listener(value));
}

export interface SettingsResource<T> {
  /** The latest answer, the cached one while a refresh is in flight, or null before the first. */
  data: T | null;
  /** The last load failed. `data` still holds the previous answer if there was one. */
  error: boolean;
  reload: () => Promise<void>;
  /** Replace the answer locally, after an optimistic write. */
  setData: (next: T) => void;
}

/**
 * A GET a settings section depends on, cached per URL and revalidated on
 * mount. `parse` turns the JSON body into the section's shape and throws on
 * anything it cannot use, which counts as a failed load.
 */
export function useSettingsResource<T>(url: string, parse: (body: unknown) => T): SettingsResource<T> {
  const [data, setDataState] = React.useState<T | null>(() => (cache.get(url) as T | undefined) ?? null);
  const [error, setError] = React.useState(false);
  const parseRef = React.useRef(parse);
  React.useEffect(() => {
    parseRef.current = parse;
  }, [parse]);

  React.useEffect(() => {
    let readers = listeners.get(url);
    if (!readers) {
      readers = new Set();
      listeners.set(url, readers);
    }
    const listener = (value: unknown) => setDataState(value as T);
    readers.add(listener);
    return () => {
      readers.delete(listener);
    };
  }, [url]);

  const setData = React.useCallback((next: T) => publish(url, next), [url]);

  const reload = React.useCallback(async () => {
    setError(false);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      setData(parseRef.current(await res.json()));
    } catch {
      setError(true);
    }
  }, [setData, url]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, reload, setData };
}
