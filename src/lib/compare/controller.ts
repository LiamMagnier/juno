import { readChatStream } from "@/lib/chat-stream";
import { resolveModel as resolveCatalogModel, type ModelInfo } from "@/lib/models";
import {
  abortRun,
  applyChunk,
  DROPPED_MESSAGE,
  failRun,
  failureFromException,
  failureFromResponse,
  IDLE_RUN,
  isPaneStreaming,
  monotonicNow,
  startRun,
  type PaneRun,
} from "@/lib/compare/pane-run";
import { buildCompareRequestBody, sharedInputFingerprint, type CompareRunSpec } from "@/lib/compare/run-spec";
import type { ClientQuota } from "@/types/chat";

/**
 * The comparison's runtime, without React.
 *
 * Each pane runs the EXISTING /api/chat route in private (ephemeral) mode,
 * the same transport as incognito chat: nothing is persisted, while spend
 * and quota are recorded server-side exactly as for a private message. One
 * fetch per pane, all started in the same tick, each independently stoppable
 * by its own generationId.
 *
 * Stopping is server-first. Aborting the fetch alone does not stop a
 * generation (it is bound to its own AbortController so a closed tab still
 * gets its answer), so a pane that is stopped, removed, reset, superseded or
 * left behind on navigation also asks /api/chat/cancel to stop it. Otherwise
 * it would run, and bill, to completion with nobody reading it.
 *
 * Every dependency (fetch, clocks, ids, timers) is injectable, which is what
 * lets tests/compare-controller.test.ts drive real SSE bodies through it.
 */

export interface CompareSnapshot {
  runs: Readonly<Record<string, PaneRun>>;
  anyStreaming: boolean;
  /** Stop was pressed and some pane has not closed yet. */
  stopping: boolean;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CompareControllerDeps {
  fetch: FetchLike;
  /** Monotonic ms clock; latency is measured with it. */
  now: () => number;
  newId: () => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  resolveModel: (id: string) => ModelInfo | undefined;
  onQuota?: (quota: ClientQuota) => void;
  /** How long Stop waits for the server before aborting locally. */
  stopFallbackMs: number;
}

interface PaneHandle {
  controller: AbortController;
  generationId: string;
  /** Run token: a newer run on the same pane invalidates this one's writes. */
  token: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function defaultDeps(): CompareControllerDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    now: monotonicNow,
    newId: () => crypto.randomUUID(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    resolveModel: (id) => resolveCatalogModel(id) ?? undefined,
    stopFallbackMs: 5000,
  };
}

export class CompareController {
  private readonly deps: CompareControllerDeps;
  private runs: Record<string, PaneRun> = {};
  private snapshot: CompareSnapshot = { runs: this.runs, anyStreaming: false, stopping: false };
  private readonly listeners = new Set<() => void>();
  private readonly handles = new Map<string, PaneHandle>();
  // Monotonic token per pane so frames from a superseded run never clobber a
  // fresh one (start → abort → late catch would otherwise race the new state).
  private readonly tokens = new Map<string, number>();
  private seq = 0;
  private stopping = false;
  private stopTimer: unknown = null;
  /** When each comparison's first pane started, for every pane's start offset. */
  private readonly specStarts = new Map<string, number>();

  constructor(deps: Partial<CompareControllerDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  setOnQuota(onQuota: ((quota: ClientQuota) => void) | undefined): void {
    this.deps.onQuota = onQuota;
  }

  // ── Store protocol (useSyncExternalStore) ─────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CompareSnapshot => this.snapshot;

  /** Generation ids currently in flight, by pane (tests and diagnostics). */
  inFlight(): Record<string, string> {
    return Object.fromEntries([...this.handles].map(([paneId, handle]) => [paneId, handle.generationId]));
  }

  private emit(): void {
    const anyStreaming = Object.values(this.runs).some(isPaneStreaming);
    if (!anyStreaming && this.stopping) {
      this.stopping = false;
      this.clearStopTimer();
    }
    this.snapshot = { runs: this.runs, anyStreaming, stopping: this.stopping };
    for (const listener of [...this.listeners]) listener();
  }

  private patch(paneId: string, token: number, update: (run: PaneRun) => PaneRun): void {
    if (this.tokens.get(paneId) !== token) return; // superseded run
    this.runs = { ...this.runs, [paneId]: update(this.runs[paneId] ?? IDLE_RUN) };
    this.emit();
  }

  private clearStopTimer(): void {
    if (this.stopTimer != null) this.deps.clearTimer(this.stopTimer);
    this.stopTimer = null;
  }

  /**
   * Ask the server to stop one generation. With `abortIfUnconfirmed`, abort
   * the fetch when the server cannot confirm (Stop keeps whatever streamed);
   * otherwise the fetch is aborted by the caller straight away.
   */
  private requestCancel(handle: PaneHandle, opts: { abortIfUnconfirmed: boolean; keepalive?: boolean }): void {
    const abort = () => {
      if (opts.abortIfUnconfirmed && !handle.controller.signal.aborted) handle.controller.abort();
    };
    let request: Promise<Response>;
    try {
      request = this.deps.fetch("/api/chat/cancel", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ generationId: handle.generationId }),
        // Survives the page being torn down (navigation away mid-stream).
        ...(opts.keepalive ? { keepalive: true } : {}),
      });
    } catch {
      abort();
      return;
    }
    request
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { cancelled?: boolean } | null) => {
        if (!data?.cancelled) abort();
      })
      .catch(abort);
  }

  /** Stop a pane's in-flight run outright: server cancel, then local abort. */
  private abandon(paneId: string, keepalive = false): void {
    const handle = this.handles.get(paneId);
    if (!handle) return;
    this.requestCancel(handle, { abortIfUnconfirmed: false, keepalive });
    handle.controller.abort();
    this.handles.delete(paneId);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /** Run one pane from a comparison's frozen spec. */
  async runPane(paneId: string, modelId: string, spec: CompareRunSpec): Promise<void> {
    // A pane can hold one run. The one it replaces is stopped server-side too.
    this.abandon(paneId);
    const controller = new AbortController();
    const generationId = this.deps.newId();
    const token = ++this.seq;
    this.tokens.set(paneId, token);
    this.handles.set(paneId, { controller, generationId, token });

    const body = buildCompareRequestBody(spec, modelId, generationId);
    const startedAt = this.deps.now();
    if (!this.specStarts.has(spec.id)) this.specStarts.set(spec.id, startedAt);
    const specStart = this.specStarts.get(spec.id) ?? startedAt;
    this.patch(paneId, token, () =>
      startRun({
        at: startedAt,
        specId: spec.id,
        requestedModelId: modelId,
        inputFingerprint: sharedInputFingerprint(body),
        startOffsetMs: startedAt - specStart,
      })
    );

    try {
      const res = await this.deps.fetch("/api/chat", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        this.patch(paneId, token, (run) => failRun(run, failureFromResponse(res.status, data), this.deps.now()));
        return;
      }

      let sawTerminal = false;
      await readChatStream(res.body, (chunk) => {
        if (chunk.type === "done" || chunk.type === "error") sawTerminal = true;
        this.patch(paneId, token, (run) => applyChunk(run, chunk, this.deps.now(), this.deps.resolveModel));
        // Quota is account-wide truth, whichever run reports it.
        if (chunk.type === "done") this.deps.onQuota?.(chunk.quota);
        else if (chunk.type === "error" && chunk.quota) this.deps.onQuota?.(chunk.quota);
      });

      if (!sawTerminal) {
        // A stream can end quietly after an abort as well as on a dropped
        // connection; either way the pane must leave its streaming state.
        this.patch(paneId, token, (run) =>
          controller.signal.aborted
            ? abortRun(run, this.deps.now())
            : failRun(run, { message: DROPPED_MESSAGE, action: "retry" }, this.deps.now())
        );
      }
    } catch (err) {
      this.patch(paneId, token, (run) =>
        controller.signal.aborted ? abortRun(run, this.deps.now()) : failRun(run, failureFromException(err), this.deps.now())
      );
    } finally {
      if (this.handles.get(paneId)?.token === token) this.handles.delete(paneId);
    }
  }

  /** Start (or restart) a whole comparison: every pane in the same tick. */
  start(spec: CompareRunSpec, panes: ReadonlyArray<{ id: string; modelId: string }>): Promise<void> {
    return Promise.all(panes.map((pane) => this.runPane(pane.id, pane.modelId, spec))).then(() => undefined);
  }

  /**
   * Stop every in-flight pane. The cancel endpoint is preferred (the server
   * closes the stream with the partial answer and the right spend); a pane the
   * server cannot confirm is aborted locally, and anything still open when the
   * fallback timer fires is aborted too.
   */
  stopAll(): void {
    const handles = [...this.handles.values()];
    if (handles.length === 0) return;
    this.stopping = true;
    this.emit();
    for (const handle of handles) this.requestCancel(handle, { abortIfUnconfirmed: true });
    this.clearStopTimer();
    this.stopTimer = this.deps.setTimer(() => {
      this.stopTimer = null;
      for (const { controller } of this.handles.values()) {
        if (!controller.signal.aborted) controller.abort();
      }
    }, this.deps.stopFallbackMs);
  }

  /** Stop one pane and forget it (the pane itself was removed). */
  discardPane(paneId: string): void {
    this.abandon(paneId);
    this.tokens.set(paneId, ++this.seq); // invalidate late frames
    const next = { ...this.runs };
    delete next[paneId];
    this.runs = next;
    this.emit();
  }

  /** Stop one pane and return it to idle (its model changed with nothing to rerun). */
  resetPane(paneId: string): void {
    this.abandon(paneId);
    this.tokens.set(paneId, ++this.seq);
    this.runs = { ...this.runs, [paneId]: IDLE_RUN };
    this.emit();
  }

  /**
   * Leaving the page: stop every generation server-side (keepalive, so the
   * request outlives the page) and abort the fetches. The controller stays
   * usable, which is what React's development double-mount needs.
   */
  dispose(): void {
    for (const paneId of [...this.handles.keys()]) this.abandon(paneId, true);
    this.clearStopTimer();
  }
}
