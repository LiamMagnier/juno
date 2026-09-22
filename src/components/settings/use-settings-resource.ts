"use client";

import * as React from "react";

/*
 * What each section last fetched, for the life of the page. Sections remount
 * on every switch (the pane keys them), so without this every visit to
 * Connectors, Devices or Plan & usage started from a skeleton again. Now a
 * return visit draws the last answer at once and refreshes it underneath.
 */
const cache = new Map<string, unknown>();

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

  const setData = React.useCallback(
    (next: T) => {
      cache.set(url, next);
      setDataState(next);
    },
    [url]
  );

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
