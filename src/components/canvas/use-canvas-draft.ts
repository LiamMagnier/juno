"use client";

import * as React from "react";
import {
  CANVAS_DRAFT_LOCAL_DEBOUNCE_MS,
  CANVAS_DRAFT_SERVER_DEBOUNCE_MS,
  KEEPALIVE_BODY_LIMIT,
  browserStorage,
  canvasDraftOffer,
  clearLocalCanvasDraft,
  draftAtRisk,
  parseServerCanvasDraft,
  readLocalCanvasDraft,
  syncAfterLocalWrite,
  syncAfterServerWrite,
  writeLocalCanvasDraft,
  type CanvasDraftCopy,
  type CanvasDraftOffer,
  type CanvasDraftSync,
} from "@/lib/canvas-draft";

/*
 * Keeps the canvas's unsaved Code-tab edit safe (G12), and offers it back.
 *
 * Every change is recorded: the device copy a quarter-second after the last
 * keystroke, the server's a little over a second after. Leaving — another
 * artifact opening, the panel closing, the tab hiding or unloading — flushes
 * whatever is still waiting: the device copy synchronously, the server's as a
 * keepalive request that outlives the page. The browser asks before leaving
 * only while the edit is actually at risk (written nowhere yet, or nowhere at
 * all), never merely because a draft exists.
 *
 * When an artifact opens, both copies are read and the newer one is offered
 * (`offer`), unless it is the version already on screen. Restoring is the
 * caller's: it puts the content in the editor and calls `acceptOffer`.
 *
 * `persist: false` (an incognito canvas, or a design, whose working copy the
 * editor keeps) writes nothing to the device or the server; the unload guard
 * then protects any dirty edit, because nothing else does. With `remember`
 * (an incognito canvas) the edit is still held in this tab's memory, so
 * opening another artifact and coming back offers it again; it never outlives
 * the page, which is what incognito promises.
 */

/** Incognito edits, held for this page's lifetime only (see `remember`). */
const memoryDrafts = new Map<string, CanvasDraftCopy>();

interface Pending {
  artifactId: string;
  content: string;
  baseVersion: number;
}

function draftUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/draft`;
}

export interface CanvasDraftHandle {
  /** The edit to offer back on open, or null. */
  offer: CanvasDraftOffer | null;
  /** Where the current edit is kept; null when nothing has been recorded. */
  sync: CanvasDraftSync | null;
  /** Record the editor's content (call on every change while editing the latest version). */
  record(content: string, baseVersion: number): void;
  /** Write anything waiting now (device synchronously, server as keepalive). */
  flush(): void;
  /** The offer was restored into the editor: stop offering it. */
  acceptOffer(): void;
  /** Drop every copy: the edit was saved as a version, or discarded. */
  clear(): void;
}

export function useCanvasDraft({
  artifactId,
  persist,
  remember = false,
  headContent,
  currentVersion,
  dirty,
}: {
  artifactId: string;
  persist: boolean;
  /** Without `persist`: still hold the edit in this tab's memory (incognito). */
  remember?: boolean;
  /** The latest version's content, so an edit identical to it is not offered. */
  headContent: string;
  currentVersion: number;
  /** The editor holds an edit that differs from the latest version. */
  dirty: boolean;
}): CanvasDraftHandle {
  const [candidates, setCandidates] = React.useState<{ artifactId: string; local: CanvasDraftCopy | null; server: CanvasDraftCopy | null } | null>(null);
  const [offerClosed, setOfferClosed] = React.useState<string | null>(null);
  const [sync, setSyncState] = React.useState<CanvasDraftSync | null>(null);
  const syncRef = React.useRef<CanvasDraftSync | null>(null);
  const setSync = React.useCallback((next: CanvasDraftSync | null) => {
    if (syncRef.current === next) return;
    syncRef.current = next;
    setSyncState(next);
  }, []);

  const pendingRef = React.useRef<Pending | null>(null);
  const localTimer = React.useRef<number | null>(null);
  const serverTimer = React.useRef<number | null>(null);
  const wroteLocally = React.useRef(false);
  /** Bumped on every record and clear, so a late server answer for older content changes nothing. */
  const sequence = React.useRef(0);
  /** The server refused this artifact's drafts for good (gone, or a design): keep the device copy only. */
  const serverOff = React.useRef(false);
  /**
   * The autosave request still on its way, if any. A discard or a save waits
   * for it before it deletes, so a write that lands late cannot put back a
   * draft the person has just dropped.
   */
  const inflight = React.useRef<Promise<unknown> | null>(null);

  const cancelTimers = React.useCallback(() => {
    if (localTimer.current !== null) window.clearTimeout(localTimer.current);
    if (serverTimer.current !== null) window.clearTimeout(serverTimer.current);
    localTimer.current = null;
    serverTimer.current = null;
  }, []);

  const writeLocal = React.useCallback((pending: Pending) => {
    const ok = writeLocalCanvasDraft(browserStorage(), pending.artifactId, {
      content: pending.content,
      baseVersion: pending.baseVersion,
      updatedAt: new Date().toISOString(),
    });
    wroteLocally.current = ok;
    return ok;
  }, []);

  const sendServer = React.useCallback(
    async (pending: Pending, seq: number) => {
      let ok = false;
      const request = fetch(draftUrl(pending.artifactId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: pending.content, baseVersion: pending.baseVersion }),
      });
      inflight.current = request.catch(() => null);
      try {
        const res = await request;
        ok = res.ok;
        // Gone, a design, or too large: retrying will not change the answer.
        if (res.status === 404 || res.status === 409 || res.status === 413) serverOff.current = true;
      } catch {
        ok = false;
      }
      if (seq !== sequence.current) return;
      setSync(syncAfterServerWrite(ok, wroteLocally.current));
    },
    [setSync]
  );

  /** The keepalive write on the way out: no answer is read, the page may already be gone. */
  const sendKeepalive = React.useCallback((pending: Pending) => {
    if (serverOff.current) return;
    const body = JSON.stringify({ content: pending.content, baseVersion: pending.baseVersion });
    if (body.length > KEEPALIVE_BODY_LIMIT) return;
    try {
      void fetch(draftUrl(pending.artifactId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* The device copy is the fallback. */
    }
  }, []);

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const waitingLocal = localTimer.current !== null;
    const waitingServer = serverTimer.current !== null;
    cancelTimers();
    if (waitingLocal) writeLocal(pending);
    if (waitingServer) sendKeepalive(pending);
  }, [cancelTimers, sendKeepalive, writeLocal]);

  const record = React.useCallback(
    (content: string, baseVersion: number) => {
      if (!persist) {
        if (remember) memoryDrafts.set(artifactId, { content, baseVersion, updatedAt: new Date().toISOString() });
        return;
      }
      const pending = { artifactId, content, baseVersion };
      pendingRef.current = pending;
      const seq = ++sequence.current;
      if (syncRef.current !== "saving") setSync("pending");
      if (localTimer.current !== null) window.clearTimeout(localTimer.current);
      localTimer.current = window.setTimeout(() => {
        localTimer.current = null;
        const ok = writeLocal(pending);
        if (seq === sequence.current) setSync(syncAfterLocalWrite(ok, serverTimer.current !== null));
      }, CANVAS_DRAFT_LOCAL_DEBOUNCE_MS);
      if (serverOff.current) return;
      if (serverTimer.current !== null) window.clearTimeout(serverTimer.current);
      serverTimer.current = window.setTimeout(() => {
        serverTimer.current = null;
        void sendServer(pending, seq);
      }, CANVAS_DRAFT_SERVER_DEBOUNCE_MS);
    },
    [artifactId, persist, remember, sendServer, setSync, writeLocal]
  );

  const clear = React.useCallback(() => {
    cancelTimers();
    sequence.current += 1;
    pendingRef.current = null;
    wroteLocally.current = false;
    setSync(null);
    setCandidates((current) => (current && current.artifactId === artifactId ? { artifactId, local: null, server: null } : current));
    memoryDrafts.delete(artifactId);
    if (!persist) return;
    clearLocalCanvasDraft(browserStorage(), artifactId);
    if (serverOff.current) return;
    const before = inflight.current ?? Promise.resolve();
    void before.then(() => fetch(draftUrl(artifactId), { method: "DELETE" })).catch(() => {});
  }, [artifactId, cancelTimers, persist, setSync]);

  const acceptOffer = React.useCallback(() => setOfferClosed(artifactId), [artifactId]);

  // Opening an artifact: read both copies. Leaving it: flush what is waiting.
  React.useEffect(() => {
    serverOff.current = false;
    wroteLocally.current = false;
    inflight.current = null;
    setSync(null);
    setOfferClosed(null);
    setCandidates(null);
    if (!persist) {
      if (remember) setCandidates({ artifactId, local: memoryDrafts.get(artifactId) ?? null, server: null });
      return;
    }
    const local = readLocalCanvasDraft(browserStorage(), artifactId);
    const controller = new AbortController();
    setCandidates({ artifactId, local, server: null });
    fetch(draftUrl(artifactId), { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) serverOff.current = true;
          return null;
        }
        return parseServerCanvasDraft(await res.json().catch(() => null));
      })
      .then((server) => {
        if (controller.signal.aborted || !server) return;
        setCandidates((current) => (current && current.artifactId === artifactId ? { ...current, server } : current));
      })
      .catch(() => {
        /* Offline: the device copy is all there is to offer. */
      });
    return () => {
      controller.abort();
      const pending = pendingRef.current;
      if (pending && pending.artifactId === artifactId) {
        const waitingLocal = localTimer.current !== null;
        const waitingServer = serverTimer.current !== null;
        cancelTimers();
        if (waitingLocal) writeLocal(pending);
        if (waitingServer) sendKeepalive(pending);
      }
      pendingRef.current = null;
      sequence.current += 1;
    };
  }, [artifactId, cancelTimers, persist, remember, sendKeepalive, setSync, writeLocal]);

  // The way out of the page: flush, and ask first only when the edit is at risk.
  const atRiskRef = React.useRef(false);
  // Nothing recorded for a dirty editor (an edit made while a kept one is on
  // offer) is as much at risk as one that failed to save.
  atRiskRef.current = dirty && (!persist || sync === null || draftAtRisk(sync));
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      // After the flush: a device copy written just now makes the edit safe.
      const stillAtRisk = atRiskRef.current && (!persist || !wroteLocally.current);
      if (!stillAtRisk) return;
      event.preventDefault();
      // Older browsers need a value; none of them show it any more.
      event.returnValue = "";
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flush, persist]);

  // A reconnect retries a draft the server never got.
  React.useEffect(() => {
    if (!persist) return;
    const onOnline = () => {
      const pending = pendingRef.current;
      if (!pending || serverOff.current || syncRef.current !== "device") return;
      void sendServer(pending, sequence.current);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [persist, sendServer]);

  const offer = React.useMemo(() => {
    if (!candidates || candidates.artifactId !== artifactId || offerClosed === artifactId) return null;
    return canvasDraftOffer({ local: candidates.local, server: candidates.server, headContent, currentVersion });
  }, [artifactId, candidates, currentVersion, headContent, offerClosed]);

  return React.useMemo(() => ({ offer, sync, record, flush, acceptOffer, clear }), [offer, sync, record, flush, acceptOffer, clear]);
}
