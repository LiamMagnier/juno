/**
 * The Mac's screen-control frames on the web (Code v2 SPEC §3.12).
 *
 * A `computer_action` item from a paired Mac carries `screenshotRef:
 * "alevr-shot://<session>/<call>.jpg"`: a file in the Mac app's shots folder,
 * which no URL on the web points at. The env server reads it back with
 * `computer.frame` (over the same link the session runs on), and this turns
 * the bytes into a blob URL the timeline's `<img>` can show.
 *
 * The resolver is synchronous, as `buildComputerTimeline` and the thread's
 * thumbnail need: a frame not fetched yet resolves to null (the stage shows
 * its alt text meanwhile) and starts one fetch; when the frame arrives the
 * hook hands out a new resolver, so everything that uses it renders again
 * with the blob URL. The blob URLs are revoked when the hook unmounts or the
 * link changes.
 */
import * as React from "react";

import { defaultScreenshotResolver } from "./computer-timeline";
import type { ClientCommandParams, ClientCommandResults } from "./contracts";

export type ScreenshotResolver = (ref: string) => string | null;

/** What the cache needs from the env link: this one request (an `EnvClient` is one). */
export interface MacFrameSource {
  request(type: "computer.frame", params: ClientCommandParams["computer.frame"]): Promise<ClientCommandResults["computer.frame"]>;
}

export const MAC_SCREENSHOT_SCHEME = "alevr-shot://";

export function isMacScreenshotRef(ref: string): boolean {
  return ref.startsWith(MAC_SCREENSHOT_SCHEME);
}

export interface MacScreenshotCacheOptions {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** The Mac keeps at most 300 frames a session; so does this, oldest out first. */
  limit?: number;
  /** A frame that failed (the Mac asleep, the frame pruned) is asked for again after this long. */
  retryAfterMs?: number;
  now?: () => number;
}

/** Fetched frames as blob URLs, by ref. One per link; dispose it with the view. */
export class MacScreenshotCache {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly limit: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    private readonly source: MacFrameSource,
    options: MacScreenshotCacheOptions = {},
  ) {
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.limit = Math.max(1, options.limit ?? 300);
    this.retryAfterMs = options.retryAfterMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * The frame's blob URL once it has arrived. Before that, null, and one
   * fetch starts. Refs that are not the Mac's go through the default
   * resolver (data URLs, https, same-origin paths).
   */
  resolve(ref: string): string | null {
    if (!isMacScreenshotRef(ref)) return defaultScreenshotResolver(ref);
    const url = this.urls.get(ref);
    if (url) return url;
    this.fetch(ref);
    return null;
  }

  /** A resolver bound to this cache. A new function each call, so a consumer's memo sees the change. */
  resolver(): ScreenshotResolver {
    return (ref) => this.resolve(ref);
  }

  /** Called whenever a frame arrives. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Revokes every blob URL; later lookups resolve to null and fetch nothing. */
  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) this.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
    this.listeners.clear();
  }

  private fetch(ref: string): void {
    if (this.disposed || this.pending.has(ref)) return;
    const failed = this.failedAt.get(ref);
    if (failed !== undefined && this.now() - failed < this.retryAfterMs) return;
    this.pending.add(ref);
    this.source.request("computer.frame", { ref }).then(
      (frame) => {
        this.pending.delete(ref);
        if (this.disposed) return;
        const bytes = frameBytes(frame);
        if (!bytes) {
          this.failedAt.set(ref, this.now());
          return;
        }
        this.failedAt.delete(ref);
        this.urls.set(ref, this.createObjectURL(new Blob([bytes], { type: frame.mime })));
        this.evict();
        for (const listener of [...this.listeners]) listener();
      },
      () => {
        this.pending.delete(ref);
        if (!this.disposed) this.failedAt.set(ref, this.now());
      },
    );
  }

  private evict(): void {
    while (this.urls.size > this.limit) {
      const [oldest, url] = this.urls.entries().next().value as [string, string];
      this.urls.delete(oldest);
      this.revokeObjectURL(url);
    }
  }
}

/** The decoded frame, or null when the answer is not an image this can show. */
function frameBytes(frame: ClientCommandResults["computer.frame"] | undefined): Uint8Array<ArrayBuffer> | null {
  if (!frame || (frame.mime !== "image/jpeg" && frame.mime !== "image/png") || typeof frame.data !== "string") return null;
  try {
    const binary = atob(frame.data);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * A screenshot resolver for a Code session's view that shows the paired
 * Mac's frames. Pass the session's env link (null while there is none: Mac
 * refs then resolve to null and the stage keeps its alt text).
 *
 * Nothing is fetched while rendering on the server: the cache exists only
 * once the view has mounted.
 */
export function useMacScreenshots(source: MacFrameSource | null | undefined): ScreenshotResolver {
  const [resolve, setResolve] = React.useState<ScreenshotResolver>(() => defaultScreenshotResolver);
  React.useEffect(() => {
    if (!source) {
      setResolve(() => defaultScreenshotResolver);
      return;
    }
    const cache = new MacScreenshotCache(source);
    const publish = () => setResolve(() => cache.resolver());
    publish();
    const unsubscribe = cache.subscribe(publish);
    return () => {
      unsubscribe();
      cache.dispose();
    };
  }, [source]);
  return resolve;
}
