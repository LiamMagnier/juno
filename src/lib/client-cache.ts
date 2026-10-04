"use client";

import * as React from "react";

/**
 * A small stale-while-revalidate cache for the account-level JSON the shell's
 * pages share: the project list, the agent roster, the connector list.
 *
 * Measured before this existed (docs/rework/program/PERFORMANCE.md): every
 * navigation into Projects, a project, Orbit or a chat re-read the same lists
 * from scratch — `/api/projects` from five different components, `/api/connectors`
 * on every conversation open — and each page painted a skeleton until its own
 * read came back, even when the identical list had arrived a second earlier.
 *
 * Rules, deliberately few:
 *  - One in-flight request per URL. Concurrent callers share it.
 *  - `peekJson` returns the last good body at any age, so a page can paint the
 *    list it already has and refresh it underneath (stale-while-revalidate).
 *  - `cachedJson` returns a body younger than `maxAgeMs` without the network.
 *  - A mutation broadcast the app already sends (`projects:sync`,
 *    `starred:sync`, `juno:agents-changed`, `juno:agent-updated`,
 *    `juno:connections-changed`) invalidates the matching entries, so a write
 *    is never hidden behind a cached read.
 *  - Only GETs of the signed-in user's own data, in memory, for this page load.
 *    Nothing is persisted; signing out is a full navigation and drops it all.
 */

interface Entry {
  data?: unknown;
  at: number;
  inflight?: Promise<unknown>;
  /** Bumped by invalidation so a read started before a write cannot land after it. */
  generation: number;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

export class CachedJsonError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const INVALIDATIONS: Array<[event: string, prefix: string]> = [
  ["projects:sync", "/api/projects"],
  ["starred:sync", "/api/projects"],
  ["juno:agents-changed", "/api/agents"],
  ["juno:agent-updated", "/api/agents"],
  ["juno:connections-changed", "/api/connectors"],
];

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const [event, prefix] of INVALIDATIONS) window.addEventListener(event, () => invalidateJson(prefix));
}

// Registered when the module is first evaluated — before any component that
// imports it attaches its own listener for the same broadcast — so by the time
// a page's "projects:sync" handler rereads, the stale entry is already gone.
install();

function entry(url: string): Entry {
  let e = store.get(url);
  if (!e) {
    e = { at: 0, generation: 0 };
    store.set(url, e);
  }
  return e;
}

function notify(url: string) {
  for (const fn of listeners.get(url) ?? []) fn();
}

/** The last good body for `url`, however old, or undefined. Never fetches. */
export function peekJson<T>(url: string): T | undefined {
  return store.get(url)?.data as T | undefined;
}

/** Seed a body a caller already holds (for example from a mutation response). */
export function primeJson(url: string, data: unknown) {
  install();
  const e = entry(url);
  e.data = data;
  e.at = Date.now();
  notify(url);
}

/** Mark every entry under `prefix` stale. The next read goes to the network. */
export function invalidateJson(prefix: string) {
  for (const [url, e] of store) {
    if (!url.startsWith(prefix)) continue;
    e.at = 0;
    e.generation++;
    e.inflight = undefined;
    notify(url);
  }
}

/**
 * A JSON GET through the cache. Fresh bodies (younger than `maxAgeMs`) are
 * returned without the network; otherwise one request per URL is made and
 * shared. `force` skips the freshness check but still joins an in-flight read.
 */
export function cachedJson<T>(url: string, options: { maxAgeMs?: number; force?: boolean } = {}): Promise<T> {
  install();
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const e = entry(url);
  if (!options.force && e.data !== undefined && Date.now() - e.at < maxAgeMs) return Promise.resolve(e.data as T);
  if (e.inflight) return e.inflight as Promise<T>;
  const generation = e.generation;
  const request = fetch(url, { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) throw new CachedJsonError(res.status);
      return res.json() as Promise<T>;
    })
    .then((data) => {
      if (e.generation === generation) {
        e.data = data;
        e.at = Date.now();
        notify(url);
      }
      return data;
    })
    .finally(() => {
      if (e.inflight === request) e.inflight = undefined;
    });
  e.inflight = request;
  return request;
}

/** Test seam: forget everything. */
export function resetJsonCacheForTests() {
  store.clear();
  listeners.clear();
}

/**
 * Subscribe a component to `url`: renders the cached body immediately (any
 * age), revalidates when it is older than `maxAgeMs`, and re-renders when any
 * caller refreshes or invalidates the same URL. `null` disables the read.
 */
export function useCachedJson<T>(url: string | null, options: { maxAgeMs?: number } = {}) {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!url) return;
    let set = listeners.get(url);
    if (!set) listeners.set(url, (set = new Set()));
    // An invalidation empties `at`; reread so the subscriber is never left on a
    // body the app has declared stale.
    const onChange = () => {
      force();
      const e = store.get(url);
      if (e && e.at === 0 && !e.inflight) void cachedJson<T>(url, { maxAgeMs }).catch(setError);
    };
    set.add(onChange);
    void cachedJson<T>(url, { maxAgeMs }).then(() => setError(null), setError);
    return () => {
      set!.delete(onChange);
    };
  }, [url, maxAgeMs]);

  const refresh = React.useCallback(() => {
    if (!url) return Promise.resolve(undefined);
    return cachedJson<T>(url, { force: true }).then((d) => {
      setError(null);
      return d;
    }, (err) => {
      setError(err);
      return undefined;
    });
  }, [url]);

  return { data: url ? peekJson<T>(url) : undefined, error, refresh };
}
