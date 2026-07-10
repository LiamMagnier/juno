"use client";

import * as React from "react";
import { readChatStream } from "@/lib/chat-stream";
import { resolveModel, type ModelId } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import type { ChatFinishReason, ClientQuota } from "@/types/chat";

/**
 * Per-pane streaming state for the side-by-side comparison. Each pane runs the
 * EXISTING /api/chat route in private (ephemeral) mode — the same transport as
 * incognito chat: nothing is persisted, while spend and quota are recorded
 * server-side exactly like a normal private message. One fetch per pane, all
 * parallel, each independently abortable via its own generationId.
 */

export type PaneStatus = "idle" | "submitting" | "thinking" | "writing" | "done" | "error";

export interface PaneRun {
  status: PaneStatus;
  content: string;
  reasoning: string;
  /** Human sentence naming the failure cause (house error style). */
  errorMessage: string | null;
  /** Which single recovery action fits the failure. */
  errorAction: "upgrade" | "retry" | null;
  startedAt: number | null;
  /** Wall-clock time of the finished run (ms). */
  elapsedMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Estimated real cost of this answer, computed from the streamed usage. */
  costUsd: number | null;
  finishReason: ChatFinishReason | null;
}

export const IDLE_RUN: PaneRun = {
  status: "idle",
  content: "",
  reasoning: "",
  errorMessage: null,
  errorAction: null,
  startedAt: null,
  elapsedMs: null,
  promptTokens: null,
  completionTokens: null,
  costUsd: null,
  finishReason: null,
};

const STREAMING_STATUSES: readonly PaneStatus[] = ["submitting", "thinking", "writing"];

export function isPaneStreaming(run: PaneRun | undefined): boolean {
  return !!run && STREAMING_STATUSES.includes(run.status);
}

interface PaneHandle {
  controller: AbortController;
  generationId: string;
  /** Run token — a newer run on the same pane invalidates this one's writes. */
  token: number;
}

export function useCompare(opts: { onQuota?: (quota: ClientQuota) => void } = {}) {
  const [runs, setRuns] = React.useState<Record<string, PaneRun>>({});
  const [stopping, setStopping] = React.useState(false);
  const handlesRef = React.useRef<Map<string, PaneHandle>>(new Map());
  // Monotonic token per pane so frames from a superseded run never clobber a
  // fresh one (start → abort → late catch would otherwise race the new state).
  const tokensRef = React.useRef<Map<string, number>>(new Map());
  const seqRef = React.useRef(0);
  const stopFallbackRef = React.useRef<number | null>(null);
  const onQuotaRef = React.useRef(opts.onQuota);
  onQuotaRef.current = opts.onQuota;

  const anyStreaming = React.useMemo(() => Object.values(runs).some(isPaneStreaming), [runs]);
  React.useEffect(() => {
    if (!anyStreaming) setStopping(false);
  }, [anyStreaming]);

  const patch = React.useCallback((paneId: string, token: number, update: (run: PaneRun) => PaneRun) => {
    if (tokensRef.current.get(paneId) !== token) return; // superseded run
    setRuns((prev) => ({ ...prev, [paneId]: update(prev[paneId] ?? IDLE_RUN) }));
  }, []);

  /** Run one pane: POST /api/chat in private mode and stream the answer in. */
  const runPane = React.useCallback(
    async (paneId: string, modelId: ModelId, prompt: string) => {
      const controller = new AbortController();
      const generationId = crypto.randomUUID();
      const token = ++seqRef.current;
      tokensRef.current.set(paneId, token);
      handlesRef.current.get(paneId)?.controller.abort();
      handlesRef.current.set(paneId, { controller, generationId, token });
      const startedAt = Date.now();
      patch(paneId, token, () => ({ ...IDLE_RUN, status: "submitting", startedAt }));

      const model = resolveModel(modelId);
      const fail = (message: string, action: "upgrade" | "retry" = "retry") =>
        patch(paneId, token, (r) => ({
          ...r,
          status: "error",
          errorMessage: message,
          errorAction: action,
          elapsedMs: Date.now() - startedAt,
        }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: prompt,
            model: modelId,
            privateMode: true,
            // Private transport carries the full history — here just the prompt.
            privateHistory: [{ role: "USER", content: prompt }],
            webSearch: false,
            canvasEnabled: false,
            generationId,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          // Machine-readable errors (e.g. 402 budget_exceeded) carry the human
          // sentence in `message`; plain errors keep it in `error`.
          fail(data.message ?? data.error ?? "Something went wrong.", res.status === 402 ? "upgrade" : "retry");
          return;
        }

        let sawTerminal = false;
        await readChatStream(res.body, (chunk) => {
          switch (chunk.type) {
            case "activity": {
              if (chunk.event.kind === "reasoning") {
                patch(paneId, token, (r) => (r.status === "writing" ? r : { ...r, status: "thinking" }));
              } else if (chunk.event.kind === "write") {
                patch(paneId, token, (r) => ({ ...r, status: "writing" }));
              } else {
                patch(paneId, token, (r) => (r.status === "submitting" ? { ...r, status: "thinking" } : r));
              }
              break;
            }
            case "reasoning": {
              patch(paneId, token, (r) => ({
                ...r,
                status: r.status === "writing" ? r.status : "thinking",
                reasoning: r.reasoning + chunk.text,
              }));
              break;
            }
            case "delta": {
              patch(paneId, token, (r) => ({ ...r, status: "writing", content: r.content + chunk.text }));
              break;
            }
            case "done": {
              sawTerminal = true;
              const msg = chunk.message;
              const finishReason = chunk.finishReason ?? msg.finishReason ?? "stop";
              // Real cost of this answer: the server estimates from the exact
              // streamed usage (cache buckets included); fall back to a client
              // estimate from the token counts when it's absent.
              const cost =
                msg.costUsd ??
                (model
                  ? estimateCostUsd(model, { input: msg.promptTokens ?? 0, output: msg.completionTokens ?? 0 })
                  : 0);
              patch(paneId, token, (r) => ({
                ...r,
                status: "done",
                content: msg.content || r.content,
                reasoning: msg.reasoning ?? r.reasoning,
                elapsedMs: Date.now() - startedAt,
                promptTokens: msg.promptTokens ?? null,
                completionTokens: msg.completionTokens ?? null,
                costUsd: cost > 0 ? cost : null,
                finishReason,
              }));
              onQuotaRef.current?.(chunk.quota);
              break;
            }
            case "error": {
              sawTerminal = true;
              patch(paneId, token, (r) => ({
                ...r,
                status: "error",
                errorMessage: chunk.message,
                errorAction: "retry",
                elapsedMs: Date.now() - startedAt,
                finishReason: chunk.finishReason ?? "error",
              }));
              if (chunk.quota) onQuotaRef.current?.(chunk.quota);
              break;
            }
          }
        });

        if (!sawTerminal && !controller.signal.aborted) {
          fail("The connection dropped before this model finished. Run it again.");
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // Stopped locally after the cancel endpoint couldn't confirm — keep
          // whatever streamed and close the pane out honestly.
          patch(paneId, token, (r) =>
            r.content
              ? { ...r, status: "done", elapsedMs: Date.now() - startedAt, finishReason: "user_stopped" }
              : { ...r, status: "error", errorMessage: "Stopped before the model answered.", errorAction: "retry", finishReason: "user_stopped" }
          );
        } else {
          fail(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        if (handlesRef.current.get(paneId)?.token === token) handlesRef.current.delete(paneId);
      }
    },
    [patch]
  );

  /** Start (or restart) the whole comparison — one parallel run per pane. */
  const start = React.useCallback(
    (prompt: string, panes: { id: string; modelId: ModelId }[]) => {
      for (const pane of panes) void runPane(pane.id, pane.modelId, prompt);
    },
    [runPane]
  );

  /** Stop every in-flight pane. Prefer the cancel endpoint (the server closes the
   *  stream with the partial answer + correct spend); abort locally as fallback. */
  const stopAll = React.useCallback(() => {
    const handles = [...handlesRef.current.values()];
    if (handles.length === 0) return;
    setStopping(true);
    for (const { controller, generationId } of handles) {
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data?.cancelled && !controller.signal.aborted) controller.abort();
        })
        .catch(() => {
          if (!controller.signal.aborted) controller.abort();
        });
    }
    if (stopFallbackRef.current != null) window.clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = window.setTimeout(() => {
      for (const { controller } of handlesRef.current.values()) {
        if (!controller.signal.aborted) controller.abort();
      }
    }, 5000);
  }, []);

  /** Drop a pane's run (used when the pane itself is removed). */
  const discardPane = React.useCallback((paneId: string) => {
    const handle = handlesRef.current.get(paneId);
    if (handle) {
      // Stop the server-side generation too — an abandoned private stream
      // would otherwise run (and bill) to completion.
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: handle.generationId }),
      }).catch(() => {});
      handle.controller.abort();
    }
    handlesRef.current.delete(paneId);
    tokensRef.current.set(paneId, ++seqRef.current); // invalidate late frames
    setRuns((prev) => {
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
  }, []);

  /** Reset a pane to idle (used after its model changes with no prompt to rerun). */
  const resetPane = React.useCallback((paneId: string) => {
    handlesRef.current.get(paneId)?.controller.abort();
    handlesRef.current.delete(paneId);
    tokensRef.current.set(paneId, ++seqRef.current);
    setRuns((prev) => ({ ...prev, [paneId]: IDLE_RUN }));
  }, []);

  // Leaving the page mid-stream: abort the fetches (generation server-side is
  // ephemeral private mode — spend is still recorded with what was produced).
  React.useEffect(() => {
    const handles = handlesRef.current;
    return () => {
      for (const { controller } of handles.values()) controller.abort();
      if (stopFallbackRef.current != null) window.clearTimeout(stopFallbackRef.current);
    };
  }, []);

  return { runs, anyStreaming, stopping, start, runPane, stopAll, discardPane, resetPane };
}
