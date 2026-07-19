"use client";

import * as React from "react";
import { toast } from "sonner";
import { readChatStream } from "@/lib/chat-stream";
import {
  clearPendingGeneration,
  getPendingGeneration,
  markPendingGeneration,
} from "@/lib/generation-pending";
import { appendReasoningDelta, emptyReasoning } from "@/lib/reasoning-parts";
import { resolveModel } from "@/lib/models";
import type { ArtifactEditRequest } from "@/lib/artifact-edit";
import {
  formatPreflightClarificationVisibleMessage,
  isPreflightClarificationResult,
  quickPreflightSkip,
  type PendingPreflightClarification,
  type PreflightClarificationAnswer,
  type PreflightClarificationContext,
} from "@/lib/preflight-clarification";
import type {
  ClientArtifact,
  ClientAttachment,
  ClientMessage,
  ClientMessageVersion,
  ClientQuota,
  GenerateEditPayload,
  GenerationStatus,
  ReasoningEffort,
  TitleSource,
} from "@/types/chat";

export type ChatMessage = ClientMessage & {
  streaming?: boolean;
  pending?: boolean;
  error?: boolean;
  /** A live realtime-voice turn rendered in the normal transcript. */
  voice?: boolean;
};

export type SendResult = { accepted: boolean; clarificationPending?: boolean };

/** Per-send flags carried alongside the message (not sticky composer prefs). */
export type SendOptions = {
  deepResearch?: boolean;
  artifactEdit?: ArtifactEditRequest;
  /** Per-send connector selection. When set, overrides the sticky `opts.connectors`
   *  for this generation (used when auto-enabling from prompt intent). */
  connectors?: string[];
};

export type ImageEditInput = { prompt: string; model: string; edit: GenerateEditPayload };

let tempCounter = 0;
const tempId = () => `temp-${Date.now()}-${tempCounter++}`;

// Poll a dropped stream for as long as a generation can legitimately run. Self-
// hosted on the VM there is no function timeout; the practical ceiling is nginx's
// proxy_read_timeout (3600s in deploy/nginx.conf.template). Keep this in sync with
// that value, plus a persistence margin for the final DB write.
const RECOVERY_WINDOW_MS = 3_600_000 + 60_000;

// Reopening a conversation after leaving mid-generation: the server keeps writing
// (detached from the browser stream). We reattach by polling until the assistant
// row lands. 45m covers long reasoning (Kimi/Claude) after tab close / navigation.
const RESUME_MAX_AGE_MS = 45 * 60_000;
const RESUME_POLL_WINDOW_MS = 45 * 60_000;

/** Backoff between recovery polls — first hit is immediate-ish. */
function recoveryDelayMs(attempt: number): number {
  if (attempt <= 0) return 400;
  if (attempt === 1) return 1_200;
  if (attempt === 2) return 2_500;
  if (attempt < 10) return 5_000;
  return 12_000;
}

interface UseChatOptions {
  conversationId: string | null;
  initialMessages: ClientMessage[];
  initialArtifacts: ClientArtifact[];
  model: string;
  projectId?: string;
  voiceMode?: boolean;
  canvasEnabled?: boolean;
  webSearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Premium fast mode (Anthropic speed / OpenAI priority). Honored server-side
   *  only on models that support it. */
  fastMode?: boolean;
  connectors?: string[];
  privateMode?: boolean;
  onMeta?: (meta: { conversationId: string; title: string; titleSource: TitleSource; isNew: boolean }) => void;
  onTitle?: (conversationId: string, title: string, titleSource?: TitleSource) => void;
  onQuota?: (quota: ClientQuota) => void;
  onArtifactsUpdated?: (artifacts: ClientArtifact[], newlyCreated: ClientArtifact[]) => void;
  onMemoryUpdated?: () => void;
  onDone?: (
    assistant: ClientMessage,
    meta?: { finishReason?: ClientMessage["finishReason"]; title?: string; projectId?: string | null; projectName?: string | null }
  ) => void;
}

export function useChat(opts: UseChatOptions) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(opts.initialMessages);
  const [artifacts, setArtifacts] = React.useState<ClientArtifact[]>(opts.initialArtifacts);
  const [status, setStatus] = React.useState<GenerationStatus>("idle");
  const [pendingClarification, setPendingClarification] = React.useState<PendingPreflightClarification | null>(null);
  const convoIdRef = React.useRef<string | null>(opts.conversationId);
  const abortRef = React.useRef<AbortController | null>(null);
  const generationIdRef = React.useRef<string | null>(null);
  const assistantIdRef = React.useRef<string | null>(null);
  const stopRequestedRef = React.useRef(false);
  /** View detached (new chat / unmount) — abort browser stream without user-stop or error toast. */
  const detachedRef = React.useRef(false);
  const stopFallbackRef = React.useRef<number | null>(null);
  // Increments on every generation; an in-flight background recovery from a
  // dropped stream aborts itself when the user has already moved on.
  const generationSeqRef = React.useRef(0);
  // Live snapshot of the message list, for the recovery poll's id matching.
  const messagesRef = React.useRef<ChatMessage[]>(opts.initialMessages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Server message ids removed from local state, mapped to the createdAt we
  // last saw. Regenerate pops the stale assistant answer locally, but the
  // server keeps that row and OVERWRITES it in place (bumping createdAt) once
  // the new answer lands — so drop recovery must treat a removed id as already
  // seen UNLESS its createdAt changed, which is exactly how a regenerate that
  // survived a dropped stream is recognized.
  const locallyRemovedRef = React.useRef<Map<string, string>>(new Map());

  // Reset when switching conversation. Detach the previous stream so the
  // server keeps writing; sessionStorage ledger reattaches on return.
  React.useEffect(() => {
    const prevConvo = convoIdRef.current;
    if (prevConvo && generationIdRef.current && !stopRequestedRef.current && !opts.privateMode) {
      markPendingGeneration({
        conversationId: prevConvo,
        userMessageId:
          messagesRef.current.filter((m) => m.role === "USER").at(-1)?.id ??
          getPendingGeneration(prevConvo)?.userMessageId ??
          null,
        generationId: generationIdRef.current,
        startedAt: getPendingGeneration(prevConvo)?.startedAt ?? Date.now(),
      });
    }
    detachedRef.current = true;
    abortRef.current?.abort(); // drop browser SSE only — not /api/chat/cancel
    convoIdRef.current = opts.conversationId;
    generationSeqRef.current++; // cancel any in-flight drop recovery for this instance
    generationIdRef.current = null;
    assistantIdRef.current = null;
    locallyRemovedRef.current = new Map();
    setMessages(opts.initialMessages);
    setArtifacts(opts.initialArtifacts);
    setStatus("idle");
    setPendingClarification(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.conversationId]);

  const mergeArtifacts = React.useCallback(
    (incoming: ClientArtifact[]) => {
      if (incoming.length === 0) return;
      setArtifacts((prev) => {
        const map = new Map(prev.map((a) => [a.identifier, a]));
        for (const a of incoming) map.set(a.identifier, a);
        return Array.from(map.values());
      });
    },
    []
  );

  /**
   * The server deliberately detaches generation from the request: when the SSE
   * connection drops (flaky network, tab close, route change), the answer is
   * still generated and persisted. Poll until the assistant row appears.
   */
  const recoverDroppedStream = React.useCallback(
    async (assistantTempId: string, userMessageId: string | null, seq: number, deadlineMs?: number) => {
      const convoId = convoIdRef.current;
      if (!convoId) return;
      // The recovered answer is whichever ASSISTANT message we have never seen.
      // Locally-removed ids count as seen while their createdAt is unchanged:
      // on regenerate the stale answer still exists server-side, and only gets
      // overwritten in place (createdAt bumped) once the new answer lands.
      const knownIds = new Set(messagesRef.current.map((m) => m.id));
      const removedAt = new Map(locallyRemovedRef.current);
      // Terminal stamps must write content too: an empty bubble renders its
      // content in the error box, so a content-less error shows an empty box.
      const stampTerminalError = (errorText: string) => {
        clearPendingGeneration(convoId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? {
                  ...m,
                  streaming: false,
                  error: true,
                  progress: null,
                  finishReason: "network_error" as const,
                  errorMessage: errorText,
                  content: m.content || errorText,
                }
              : m
          )
        );
      };

      const deadline = deadlineMs ?? Date.now() + RECOVERY_WINDOW_MS;
      let attempt = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, recoveryDelayMs(attempt)));
        attempt++;
        if (generationSeqRef.current !== seq) {
          // Newer turn on this hook instance — leave the ledger so reopening
          // this conversation can still reattach. Don't stamp an error onto a
          // bubble the user may no longer be looking at.
          return;
        }
        try {
          const res = await fetch(`/api/conversations/${convoId}`);
          if (!res.ok) continue;
          const payload = (await res.json()) as { messages?: ClientMessage[]; artifacts?: ClientArtifact[] };
          const msgs = payload.messages ?? [];
          const afterIdx = userMessageId ? msgs.findIndex((m) => m.id === userMessageId) : -1;
          const recovered = msgs.find(
            (m, i) =>
              m.role === "ASSISTANT" &&
              (removedAt.has(m.id) ? removedAt.get(m.id) !== m.createdAt : !knownIds.has(m.id)) &&
              (afterIdx < 0 || i > afterIdx) &&
              // Media generations persist with empty content + an attachment.
              (m.content || m.reasoning || (m.attachments?.length ?? 0) > 0)
          );
          if (!recovered) continue;
          if (generationSeqRef.current !== seq) return;
          locallyRemovedRef.current.delete(recovered.id);
          clearPendingGeneration(convoId);
          let replaced = false;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantTempId) return m;
              replaced = true;
              return { ...recovered, streaming: false, error: false, errorMessage: undefined };
            })
          );
          // If the placeholder was lost (e.g. remount race), append the answer.
          if (!replaced) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === recovered.id)) return prev;
              return [...prev, { ...recovered, streaming: false }];
            });
          }
          if (Array.isArray(payload.artifacts)) mergeArtifacts(payload.artifacts);
          opts.onDone?.(recovered, { finishReason: recovered.finishReason ?? undefined });
          toast.success("Answer ready — Juno finished in the background.");
          return;
        } catch {
          // transient poll failure — keep waiting
        }
      }
      if (generationSeqRef.current !== seq) return;
      stampTerminalError("The connection dropped and the response never finished. Use Continue or regenerate.");
    },
    [mergeArtifacts, opts]
  );

  // Resume when reopening a chat that left mid-generation (tab close, sidebar
  // navigation, refresh). Server keeps writing; we reattach via poll.
  React.useEffect(() => {
    if (opts.privateMode || !opts.conversationId) return;
    const convoId = opts.conversationId;
    const msgs = opts.initialMessages;
    const last = msgs[msgs.length - 1];
    const pending = getPendingGeneration(convoId);

    // Already have a finished assistant as the tail — nothing to recover.
    if (
      last?.role === "ASSISTANT" &&
      (last.content || last.reasoning || (last.attachments?.length ?? 0) > 0)
    ) {
      clearPendingGeneration(convoId);
      return;
    }

    // Sources of truth for "still waiting on an answer":
    //  1. Trailing USER message (generation never streamed a done frame)
    //  2. sessionStorage ledger from a prior tab/route that dropped the SSE
    const trailingUser = last?.role === "USER" ? last : null;
    const userMessageId = trailingUser?.id ?? pending?.userMessageId ?? null;
    if (!trailingUser && !pending) return;

    const ageSource = trailingUser?.createdAt ?? (pending ? new Date(pending.startedAt).toISOString() : null);
    if (ageSource) {
      const age = Date.now() - new Date(ageSource).getTime();
      if (!(age >= 0 && age < RESUME_MAX_AGE_MS)) {
        if (pending) clearPendingGeneration(convoId);
        return;
      }
    }

    const seq = generationSeqRef.current;
    const placeholderId = tempId();
    const placeholder: ChatMessage = {
      id: placeholderId,
      role: "ASSISTANT",
      content: "",
      createdAt: new Date().toISOString(),
      attachments: [],
      activity: [],
      streaming: true,
      errorMessage: "Juno is still working in the background. The answer will appear here when it's ready.",
    };

    setMessages((prev) => {
      const tail = prev[prev.length - 1];
      // Already showing a recovering/streaming bubble for this turn.
      if (tail?.role === "ASSISTANT" && (tail.streaming || tail.errorMessage?.includes("background"))) {
        return prev;
      }
      if (trailingUser && tail?.id === trailingUser.id) return [...prev, placeholder];
      if (!trailingUser && pending && tail?.role === "USER") return [...prev, placeholder];
      if (!trailingUser && pending && tail?.role === "ASSISTANT" && !tail.content && !tail.reasoning) {
        return prev.map((m, i) => (i === prev.length - 1 ? { ...placeholder, id: m.id } : m));
      }
      return prev;
    });

    // Ensure the ledger exists so further navigations still reattach.
    markPendingGeneration({
      conversationId: convoId,
      userMessageId,
      generationId: pending?.generationId ?? null,
      startedAt: pending?.startedAt ?? Date.now(),
    });

    void recoverDroppedStream(placeholderId, userMessageId, seq, Date.now() + RESUME_POLL_WINDOW_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.conversationId]);

  const runGeneration = React.useCallback(
    async (body: Record<string, unknown>, assistantTempId: string, path = "/api/chat") => {
      const controller = new AbortController();
      const generationId = crypto.randomUUID();
      abortRef.current = controller;
      generationIdRef.current = generationId;
      assistantIdRef.current = assistantTempId;
      stopRequestedRef.current = false;
      detachedRef.current = false;
      setStatus("submitting");
      const seq = ++generationSeqRef.current;
      let sawTerminal = false;
      let metaUserMessageId: string | null = null;
      let metaArrived = false;
      // The reasoning fold for this generation, accumulated HERE rather than
      // inside the setMessages updater. React defers an updater to the render
      // phase whenever the fiber already has queued work — which is routine,
      // since one network read parses every buffered SSE frame in a synchronous
      // loop — so an updater that read a mutable local would see the ordinal the
      // NEXT delta had already written, and place the "\n\n" part separator in
      // the wrong spot. This loop is the only writer, so the local is the source
      // of truth and the message mirrors it: the same synchronous fold the route
      // does, which is what makes server and client byte-identical.
      let reasoningState = emptyReasoning();

      // Mark the bubble as awaiting background recovery and start polling for
      // the answer the server is (very likely) still writing. No finishReason
      // yet — that would surface a "Continue" button on a bubble that is still
      // promising the original answer; terminal states set it later.
      const beginDropRecovery = (flags?: { silent?: boolean }) => {
        const convoId = convoIdRef.current;
        if (convoId && !opts.privateMode) {
          markPendingGeneration({
            conversationId: convoId,
            userMessageId: metaUserMessageId,
            generationId,
            startedAt: Date.now(),
          });
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? {
                  ...m,
                  streaming: true,
                  progress: null,
                  error: false,
                  errorMessage:
                    "Connection interrupted — Juno keeps working in the background. The answer will appear here when it's ready.",
                }
              : m
          )
        );
        if (!flags?.silent) {
          toast.info("Still generating in the background — you can leave and come back.");
        }
        if (convoId && !opts.privateMode) {
          void recoverDroppedStream(assistantTempId, metaUserMessageId, seq);
        }
      };

      try {
        // Let React paint "submitting" / the pending bubbles before a multi-MB
        // JSON.stringify blocks the main thread on long pastes / private history.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });

        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, generationId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          // Machine-readable errors (e.g. 402 budget_exceeded) carry the
          // human sentence in `message`; plain errors keep it in `error`.
          throw new Error(data.message ?? data.error ?? "Something went wrong.");
        }

        await readChatStream(res.body, (chunk) => {
          switch (chunk.type) {
            case "meta": {
              metaArrived = true;
              metaUserMessageId = chunk.userMessageId ?? null;
              const isNew = convoIdRef.current === null;
              if (!opts.privateMode) {
                convoIdRef.current = chunk.conversationId;
                // Ledger early so a tab close right after accept still recovers.
                markPendingGeneration({
                  conversationId: chunk.conversationId,
                  userMessageId: chunk.userMessageId ?? null,
                  generationId,
                  startedAt: Date.now(),
                });
              }
              if (chunk.userMessageId) {
                setMessages((prev) =>
                  prev.map((m) => (m.pending && m.role === "USER" ? { ...m, id: chunk.userMessageId!, pending: false } : m))
                );
              } else if (opts.privateMode) {
                setMessages((prev) => prev.map((m) => (m.pending && m.role === "USER" ? { ...m, pending: false } : m)));
              }
              if (!opts.privateMode)
                opts.onMeta?.({
                  conversationId: chunk.conversationId,
                  title: chunk.title,
                  titleSource: chunk.titleSource ?? "default",
                  isNew,
                });
              break;
            }
            case "title": {
              // Auto-generated title arrived mid/post-stream — update the sidebar live.
              if (!opts.privateMode) opts.onTitle?.(chunk.conversationId, chunk.title, chunk.titleSource);
              break;
            }
            case "activity": {
              setStatus((cur) => (cur === "submitting" ? "thinking" : cur));
              if (chunk.event.kind === "reasoning") setStatus((cur) => (cur === "writing" ? cur : "thinking"));
              if (chunk.event.kind === "write") setStatus("writing");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        activity: [...(m.activity ?? []).filter((event) => event.id !== chunk.event.id), chunk.event],
                      }
                    : m
                )
              );
              break;
            }
            case "sources": {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, sources: chunk.sources } : m))
              );
              break;
            }
            case "reasoning": {
              setStatus((cur) => (cur === "writing" ? cur : "thinking"));
              // Fold through the SAME helper the route uses, so the steps the
              // panel shows mid-stream are byte-identical to the ones it shows
              // after a reload. Providers without part boundaries fall through
              // it as a plain concat and keep `reasoningParts` absent.
              reasoningState = appendReasoningDelta(reasoningState, chunk.text, chunk.part);
              const { text: reasoning, parts: reasoningParts } = reasoningState;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        reasoning,
                        // Copied because `reasoningState.parts` is re-read by the
                        // next delta; the message must not alias live state.
                        ...(reasoningParts.length ? { reasoningParts: [...reasoningParts] } : {}),
                      }
                    : m
                )
              );
              break;
            }
            case "delta": {
              setStatus("writing");
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, content: m.content + chunk.text } : m))
              );
              break;
            }
            case "progress": {
              // Live /api/generate stage; modality was stamped when the generation started.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? { ...m, progress: { modality: m.progress?.modality ?? "image", stage: chunk.stage, pct: chunk.pct } }
                    : m
                )
              );
              break;
            }
            case "done": {
              sawTerminal = true;
              // A regenerated answer arrives under its original id (the server
              // overwrites the row in place) — it is no longer "removed".
              locallyRemovedRef.current.delete(chunk.message.id);
              if (convoIdRef.current) clearPendingGeneration(convoIdRef.current);
              if (stopFallbackRef.current != null) {
                window.clearTimeout(stopFallbackRef.current);
                stopFallbackRef.current = null;
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? { ...chunk.message, finishReason: chunk.finishReason ?? chunk.message.finishReason, streaming: false }
                    : m
                )
              );
              mergeArtifacts(chunk.artifacts);
              if (chunk.artifacts.length) opts.onArtifactsUpdated?.(chunk.artifacts, chunk.artifacts);
              opts.onQuota?.(chunk.quota);
              if (chunk.memoryUpdated) opts.onMemoryUpdated?.();
              opts.onDone?.(chunk.message, {
                finishReason: chunk.finishReason ?? chunk.message.finishReason,
                title: chunk.title,
                projectId: chunk.projectId,
                projectName: chunk.projectName,
              });
              break;
            }
            case "error": {
              sawTerminal = true;
              if (convoIdRef.current) clearPendingGeneration(convoIdRef.current);
              setStatus("error");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        streaming: false,
                        error: true,
                        progress: null,
                        finishReason: chunk.finishReason ?? "error",
                        ...(chunk.preservePartial && (m.content || m.reasoning)
                          ? { errorMessage: chunk.message }
                          : { content: chunk.message, errorMessage: chunk.message }),
                      }
                    : m
                )
              );
              if (chunk.quota) opts.onQuota?.(chunk.quota);
              toast.error(chunk.message);
              break;
            }
          }
        });

        // Stream ended without a done/error frame — the platform killed the
        // function or a proxy dropped the SSE mid-generation. Don't leave the
        // bubble spinning forever: recover the persisted answer if possible.
        if (!sawTerminal && !detachedRef.current) {
          if (metaArrived && !opts.privateMode && convoIdRef.current && !stopRequestedRef.current) {
            beginDropRecovery();
          } else if (!stopRequestedRef.current) {
            setStatus("error");
            const dropMessage = "The connection dropped before the response finished. Please try again.";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantTempId
                  ? {
                      ...m,
                      streaming: false,
                      error: true,
                      progress: null,
                      finishReason: "network_error",
                      errorMessage: dropMessage,
                      content: m.content || dropMessage,
                    }
                  : m
              )
            );
            toast.error("The connection dropped before the response finished.");
          }
        }
      } catch (err) {
        // View moved on (new chat) — server may still finish; ledger keeps recovery.
        if (detachedRef.current) return;
        const stopped = stopRequestedRef.current;
        // Explicit Stop: unmark streaming. Anything else (tab close, route
        // change, flaky network) is a drop — recover, even if the browser
        // aborted the fetch (pagehide often surfaces as AbortError).
        if (stopped) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, progress: null, finishReason: "user_stopped" }
                : m
            )
          );
          if (convoIdRef.current) clearPendingGeneration(convoIdRef.current);
        } else if (metaArrived && !opts.privateMode && convoIdRef.current) {
          // Generation already started server-side and survives disconnects.
          beginDropRecovery();
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          setStatus("error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, error: true, progress: null, finishReason: "error", errorMessage: message, content: m.content || message }
                : m
            )
          );
          toast.error(message);
        }
      } finally {
        if (stopFallbackRef.current != null) {
          window.clearTimeout(stopFallbackRef.current);
          stopFallbackRef.current = null;
        }
        setStatus((cur) => (cur === "error" ? "error" : "idle"));
        abortRef.current = null;
        generationIdRef.current = null;
        assistantIdRef.current = null;
        stopRequestedRef.current = false;
      }
    },
    [mergeArtifacts, opts, recoverDroppedStream]
  );

  const startGeneration = React.useCallback(
    (input: {
      text: string;
      attachments?: ClientAttachment[];
      preflightClarification?: PreflightClarificationContext;
      deepResearch?: boolean;
      artifactEdit?: ArtifactEditRequest;
      connectors?: string[];
    }): SendResult => {
      const trimmed = input.text.trim();
      const attachments = input.attachments ?? [];
      // Image/video models run through the generation endpoint, not the chat stream.
      const modality = resolveModel(opts.model)?.modality ?? "chat";
      // Clarification answers are shown (and, in private mode, re-sent as
      // history) as part of the user message — matches what the server persists.
      const visibleContent = input.preflightClarification
        ? formatPreflightClarificationVisibleMessage(input.preflightClarification)
        : null;
      const userMsg: ChatMessage = {
        id: tempId(),
        role: "USER",
        content: visibleContent ?? trimmed,
        createdAt: new Date().toISOString(),
        attachments,
        pending: true,
      };
      const assistantTempId = tempId();
      const assistantMsg: ChatMessage = {
        id: assistantTempId,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date().toISOString(),
        attachments: [],
        activity: [],
        streaming: true,
        // Media generations show their placeholder before the first SSE frame lands.
        progress: modality === "chat" || opts.privateMode ? null : { modality, stage: "queued" },
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      if (opts.privateMode && modality !== "chat") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? { ...m, streaming: false, error: true, progress: null, content: "Private chat only supports text chat right now because generated media is stored." }
              : m.pending && m.role === "USER"
                ? { ...m, pending: false }
                : m
          )
        );
        toast.error("Private chat only supports text chat right now.");
        setStatus("idle");
        return { accepted: true };
      }
      if (modality !== "chat") {
        void runGeneration(
          { conversationId: convoIdRef.current ?? undefined, prompt: trimmed, model: opts.model },
          assistantTempId,
          "/api/generate"
        );
        return { accepted: true };
      }

      void runGeneration(
        {
          conversationId: opts.privateMode ? undefined : convoIdRef.current ?? undefined,
          // Only relevant when creating a brand-new conversation inside a project.
          projectId: opts.privateMode || convoIdRef.current ? undefined : opts.projectId,
          message: trimmed,
          attachmentIds: attachments.map((a) => a.id),
          model: opts.model,
          voiceMode: opts.voiceMode,
          canvasEnabled: opts.privateMode ? false : opts.canvasEnabled,
          webSearch: opts.webSearch,
          fastMode: opts.fastMode,
          // Per-send, never sticky — and never in private mode (research
          // persists sources/activity, which private chats don't do).
          deepResearch: !opts.privateMode && input.deepResearch ? true : undefined,
          artifactEdit: !opts.privateMode ? input.artifactEdit : undefined,
          reasoningEffort: opts.reasoningEffort,
          connectors: input.connectors ?? opts.connectors,
          preflightClarification: input.preflightClarification,
          privateMode: opts.privateMode,
          privateHistory: opts.privateMode
            ? [...messages, userMsg]
                .filter((m) => !m.error && (m.role === "USER" || m.role === "ASSISTANT"))
                .map((m) => ({ role: m.role, content: m.content }))
            : undefined,
        },
        assistantTempId
      ).catch((err) => {
        // Keep the SPA alive if stringify/fetch throws on huge pastes.
        console.error("[chat] generation failed to start", err);
        toast.error(err instanceof Error ? err.message : "Could not start that message.");
        setStatus("error");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? {
                  ...m,
                  streaming: false,
                  error: true,
                  content: err instanceof Error ? err.message : "Could not send that message.",
                }
              : m.pending && m.role === "USER"
                ? { ...m, pending: false }
                : m
          )
        );
      });
      return { accepted: true };
    },
    [
      runGeneration,
      opts.model,
      opts.voiceMode,
      opts.canvasEnabled,
      opts.webSearch,
      opts.reasoningEffort,
      opts.fastMode,
      opts.connectors,
      opts.projectId,
      opts.privateMode,
      messages,
    ]
  );

  const send = React.useCallback(
    async (text: string, attachments: ClientAttachment[] = [], options?: SendOptions): Promise<SendResult> => {
      if ((status !== "idle" && status !== "error") || pendingClarification) return { accepted: false };
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return { accepted: false };

      const modality = resolveModel(opts.model)?.modality ?? "chat";
      const connectors = options?.connectors;
      if (modality !== "chat" || !trimmed) {
        return startGeneration({ text: trimmed, attachments, connectors });
      }

      // Deep research goes straight to generation: the researcher plans its own
      // sub-questions server-side, so the preflight clarification round-trip
      // would only add latency (and the flag wouldn't survive its detour).
      if ((options?.deepResearch || options?.artifactEdit) && !opts.privateMode) {
        return startGeneration({
          text: trimmed,
          attachments,
          deepResearch: options.deepResearch,
          artifactEdit: options.artifactEdit,
          connectors,
        });
      }

      // Deterministic skip (long paste, code, "just answer", …) — never pay a
      // network round-trip for cases the server would skip anyway. Long prompts
      // used to POST the entire body to /api/chat/clarify *then* again to
      // /api/chat, which made Send feel stuck for seconds before "charging".
      const localSkip = quickPreflightSkip({
        message: trimmed,
        hasAttachments: attachments.length > 0,
      });
      if (localSkip) {
        return startGeneration({ text: trimmed, attachments, connectors });
      }

      setStatus("checking");
      // The preflight clarification check must never block sending: if it hangs
      // or errors, we time out and fall through to actually answering. Without
      // this abort the composer could sit in "Checking…" forever on a stalled
      // request (e.g. a slow/unreachable server), locking the user out of chat.
      const clarifyController = new AbortController();
      // Keep well under the old 6s stall; triage itself budgets ~4s server-side.
      const clarifyTimeout = setTimeout(() => clarifyController.abort(), 3500);
      try {
        const res = await fetch("/api/chat/clarify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: opts.privateMode ? null : convoIdRef.current,
            // Triage only needs the start of the prompt — never re-upload multi-MB pastes.
            message: trimmed.length > 2_500 ? trimmed.slice(0, 2_500) : trimmed,
            hasAttachments: attachments.length > 0,
            privateMode: opts.privateMode,
          }),
          signal: clarifyController.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.ok && isPreflightClarificationResult(data) && data.needsClarification) {
          setPendingClarification({
            id: crypto.randomUUID(),
            originalUserMessage: trimmed,
            attachments,
            result: data,
          });
          setStatus("idle");
          return { accepted: false, clarificationPending: true };
        }
      } catch {
        // If the preflight check fails or times out, keep the product moving and answer.
      } finally {
        clearTimeout(clarifyTimeout);
      }

      return startGeneration({ text: trimmed, attachments, connectors });
    },
    [opts.model, opts.privateMode, pendingClarification, startGeneration, status]
  );

  // Region-based image edit — same /api/generate transport (quota, meta, progress,
  // done/error handling all come from runGeneration). The edit prompt becomes the
  // new user message; the result arrives like any other generation.
  const sendImageEdit = React.useCallback(
    (input: ImageEditInput): SendResult => {
      if ((status !== "idle" && status !== "error") || pendingClarification) return { accepted: false };
      const trimmed = input.prompt.trim();
      if (!trimmed) return { accepted: false };
      if (opts.privateMode) {
        toast.error("Image editing isn't available in private chat.");
        return { accepted: false };
      }
      const userMsg: ChatMessage = {
        id: tempId(),
        role: "USER",
        content: trimmed,
        createdAt: new Date().toISOString(),
        attachments: [],
        pending: true,
      };
      const assistantTempId = tempId();
      const assistantMsg: ChatMessage = {
        id: assistantTempId,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date().toISOString(),
        attachments: [],
        activity: [],
        streaming: true,
        progress: { modality: "image", stage: "queued" },
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      void runGeneration(
        { conversationId: convoIdRef.current ?? undefined, prompt: trimmed, model: input.model, edit: input.edit },
        assistantTempId,
        "/api/generate"
      );
      return { accepted: true };
    },
    [status, pendingClarification, runGeneration, opts.privateMode]
  );

  const resolvePendingClarification = React.useCallback(
    async (answers: PreflightClarificationAnswer[], skipped = false): Promise<SendResult> => {
      if ((status !== "idle" && status !== "error") || !pendingClarification) return { accepted: false };
      const pending = pendingClarification;
      setPendingClarification(null);
      const context: PreflightClarificationContext = {
        originalUserMessage: pending.originalUserMessage,
        answers: skipped
          ? [
              {
                questionId: "skipped",
                question: "Pre-answer clarification",
                source: "skip",
                value: "Skipped clarification",
              },
            ]
          : answers,
        skipped,
      };
      return startGeneration({
        text: pending.originalUserMessage,
        attachments: pending.attachments,
        preflightClarification: context,
      });
    },
    [pendingClarification, startGeneration, status]
  );

  const cancelPendingClarification = React.useCallback(() => {
    setPendingClarification(null);
    setStatus("idle");
  }, []);

  const regenerate = React.useCallback(async () => {
    if (status !== "idle" && status !== "error") return;
    if (!convoIdRef.current) return;
    // Drop the trailing assistant message locally and add a fresh placeholder.
    // Remember the dropped ids (with the createdAt we saw): the server keeps
    // the stale row — preserving its content as a MessageVersion and updating
    // it in place — so drop recovery must not mistake the untouched row for a
    // fresh answer, yet must recognize it once its createdAt is bumped.
    const assistantTempId = tempId();
    setMessages((prev) => {
      const copy = [...prev];
      while (copy.length && copy[copy.length - 1].role === "ASSISTANT") {
        const dropped = copy[copy.length - 1];
        locallyRemovedRef.current.set(dropped.id, dropped.createdAt);
        copy.pop();
      }
      return [
        ...copy,
        { id: assistantTempId, role: "ASSISTANT", content: "", createdAt: new Date().toISOString(), attachments: [], activity: [], streaming: true },
      ];
    });
    await runGeneration(
      {
        conversationId: convoIdRef.current,
        regenerate: true,
        model: opts.model,
        voiceMode: opts.voiceMode,
        canvasEnabled: opts.canvasEnabled,
        reasoningEffort: opts.reasoningEffort,
        fastMode: opts.fastMode,
        connectors: opts.connectors,
      },
      assistantTempId
    );
  }, [status, runGeneration, opts.model, opts.voiceMode, opts.canvasEnabled, opts.reasoningEffort, opts.fastMode, opts.connectors]);

  const editAndResend = React.useCallback(
    async (messageId: string, newContent: string) => {
      if (status !== "idle" && status !== "error") return;
      const res = await fetch(`/api/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Could not edit the message.");
        return;
      }
      // The server snapshotted the pre-edit wording as a MessageVersion; append
      // its metadata locally so the "‹ 2/3 ›" pager grows without a refetch.
      const data = (await res.json().catch(() => ({}))) as { version?: ClientMessageVersion };
      // Truncate locally to the edited message, update its content.
      const assistantTempId = tempId();
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const kept = prev.slice(0, idx + 1).map((m) =>
          m.id === messageId
            ? { ...m, content: newContent, versions: data.version ? [...(m.versions ?? []), data.version] : m.versions }
            : m
        );
        return [
          ...kept,
          { id: assistantTempId, role: "ASSISTANT", content: "", createdAt: new Date().toISOString(), attachments: [], activity: [], streaming: true },
        ];
      });
      await runGeneration(
        {
          conversationId: convoIdRef.current ?? undefined,
          regenerate: true,
          model: opts.model,
          canvasEnabled: opts.canvasEnabled,
          reasoningEffort: opts.reasoningEffort,
          fastMode: opts.fastMode,
          connectors: opts.connectors,
        },
        assistantTempId
      );
    },
    [status, runGeneration, opts.model, opts.canvasEnabled, opts.reasoningEffort, opts.fastMode, opts.connectors]
  );

  const stop = React.useCallback(() => {
    if (!abortRef.current) return;
    stopRequestedRef.current = true;
    setStatus("stopping");

    const generationId = generationIdRef.current;
    const controller = abortRef.current;
    const assistantId = assistantIdRef.current;
    if (convoIdRef.current) clearPendingGeneration(convoIdRef.current);

    if (generationId) {
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
    } else {
      controller.abort();
    }

    if (stopFallbackRef.current != null) window.clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = window.setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
      if (assistantId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, finishReason: "user_stopped" } : m))
        );
      }
      setStatus("idle");
    }, 5000);
  }, []);

  // Reset to a fresh "new chat" without remounting (used after the shallow-URL flow).
  // Does NOT cancel server-side generation — only detaches this view. Pending
  // ledger stays so reopening the prior chat still reattaches.
  const reset = React.useCallback(() => {
    // Abort only the browser stream reader — server generation is detached and
    // continues. Do not call /api/chat/cancel (that's explicit Stop).
    detachedRef.current = true;
    stopRequestedRef.current = false;
    abortRef.current?.abort();
    generationSeqRef.current++; // cancel local drop recovery for THIS instance
    locallyRemovedRef.current = new Map();
    if (stopFallbackRef.current != null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
    // Keep sessionStorage ledger for the previous conversationId.
    convoIdRef.current = null;
    generationIdRef.current = null;
    assistantIdRef.current = null;
    setMessages([]);
    setArtifacts([]);
    setStatus("idle");
    setPendingClarification(null);
  }, []);

  // Tab close / background / soft navigation: remember the in-flight turn so
  // reopening the chat reattaches. Never cancel the server generation here.
  React.useEffect(() => {
    if (opts.privateMode) return;
    const remember = () => {
      const convoId = convoIdRef.current;
      const genId = generationIdRef.current;
      if (!convoId || !genId || stopRequestedRef.current) return;
      // Only while a stream is live (or recently dropped into recovery).
      if (!abortRef.current && !getPendingGeneration(convoId)) return;
      markPendingGeneration({
        conversationId: convoId,
        userMessageId:
          messagesRef.current.filter((m) => m.role === "USER").at(-1)?.id ??
          getPendingGeneration(convoId)?.userMessageId ??
          null,
        generationId: genId,
        startedAt: getPendingGeneration(convoId)?.startedAt ?? Date.now(),
      });
    };
    window.addEventListener("pagehide", remember);
    window.addEventListener("freeze", remember);
    const onVis = () => {
      if (document.visibilityState === "hidden") remember();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", remember);
      window.removeEventListener("freeze", remember);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [opts.privateMode]);

  const setFeedback = React.useCallback((messageId: string, feedback: "UP" | "DOWN" | null) => {
    // Optimistic, but honest: capture the previous value while applying the
    // new one, and roll back with a toast if the API doesn't accept it.
    let previous: "UP" | "DOWN" | null = null;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        previous = m.feedback ?? null;
        return { ...m, feedback };
      })
    );
    const rollback = () => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: previous } : m)));
      toast.error("Could not save your feedback.");
    };
    fetch(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    })
      .then((res) => {
        if (!res.ok) rollback();
      })
      .catch(rollback);
  }, []);

  const continueResponse = React.useCallback(() => {
    return send("Continue from where you left off.");
  }, [send]);

  return {
    messages,
    artifacts,
    status,
    pendingClarification,
    isBusy: status === "checking" || status === "submitting" || status === "thinking" || status === "writing" || status === "stopping",
    send,
    sendImageEdit,
    resolvePendingClarification,
    cancelPendingClarification,
    continueResponse,
    regenerate,
    editAndResend,
    stop,
    reset,
    setFeedback,
    setArtifacts,
    setMessages,
  };
}
