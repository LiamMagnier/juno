"use client";

import * as React from "react";
import { toast } from "sonner";
import { readChatStream } from "@/lib/chat-stream";
import { resolveModel } from "@/lib/models";
import type { ClientArtifact, ClientAttachment, ClientMessage, ClientQuota, GenerationStatus, ReasoningEffort } from "@/types/chat";

export type ChatMessage = ClientMessage & {
  streaming?: boolean;
  pending?: boolean;
  error?: boolean;
};

let tempCounter = 0;
const tempId = () => `temp-${Date.now()}-${tempCounter++}`;

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
  privateMode?: boolean;
  onMeta?: (meta: { conversationId: string; title: string; isNew: boolean }) => void;
  onTitle?: (conversationId: string, title: string) => void;
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
  const convoIdRef = React.useRef<string | null>(opts.conversationId);
  const abortRef = React.useRef<AbortController | null>(null);
  const generationIdRef = React.useRef<string | null>(null);
  const assistantIdRef = React.useRef<string | null>(null);
  const stopRequestedRef = React.useRef(false);
  const stopFallbackRef = React.useRef<number | null>(null);

  // Reset when switching conversation.
  React.useEffect(() => {
    convoIdRef.current = opts.conversationId;
    setMessages(opts.initialMessages);
    setArtifacts(opts.initialArtifacts);
    setStatus("idle");
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

  const runGeneration = React.useCallback(
    async (body: Record<string, unknown>, assistantTempId: string, path = "/api/chat") => {
      const controller = new AbortController();
      const generationId = crypto.randomUUID();
      abortRef.current = controller;
      generationIdRef.current = generationId;
      assistantIdRef.current = assistantTempId;
      stopRequestedRef.current = false;
      setStatus("submitting");

      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, generationId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Something went wrong.");
        }

        await readChatStream(res.body, (chunk) => {
          switch (chunk.type) {
            case "meta": {
              const isNew = convoIdRef.current === null;
              if (!opts.privateMode) convoIdRef.current = chunk.conversationId;
              if (chunk.userMessageId) {
                setMessages((prev) =>
                  prev.map((m) => (m.pending && m.role === "USER" ? { ...m, id: chunk.userMessageId!, pending: false } : m))
                );
              } else if (opts.privateMode) {
                setMessages((prev) => prev.map((m) => (m.pending && m.role === "USER" ? { ...m, pending: false } : m)));
              }
              if (!opts.privateMode) opts.onMeta?.({ conversationId: chunk.conversationId, title: chunk.title, isNew });
              break;
            }
            case "title": {
              // Auto-generated title arrived mid/post-stream — update the sidebar live.
              if (!opts.privateMode) opts.onTitle?.(chunk.conversationId, chunk.title);
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
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, reasoning: (m.reasoning ?? "") + chunk.text } : m))
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
            case "done": {
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
              setStatus("error");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        streaming: false,
                        error: true,
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
      } catch (err) {
        if (controller.signal.aborted) {
          // Keep whatever streamed; just unmark streaming.
          const stopped = stopRequestedRef.current;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, finishReason: stopped ? "user_stopped" : m.finishReason }
                : m
            )
          );
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          setStatus("error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, error: true, finishReason: "error", errorMessage: message, content: m.content || message }
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
    [mergeArtifacts, opts]
  );

  const send = React.useCallback(
    async (text: string, attachments: ClientAttachment[] = []) => {
      if (status !== "idle" && status !== "error") return;
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      const userMsg: ChatMessage = {
        id: tempId(),
        role: "USER",
        content: trimmed,
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
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      // Image/video models run through the generation endpoint, not the chat stream.
      const modality = resolveModel(opts.model)?.modality ?? "chat";
      if (opts.privateMode && modality !== "chat") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? { ...m, streaming: false, error: true, content: "Private chat only supports text chat right now because generated media is stored." }
              : m.pending && m.role === "USER"
                ? { ...m, pending: false }
                : m
          )
        );
        toast.error("Private chat only supports text chat right now.");
        setStatus("idle");
        return;
      }
      if (modality !== "chat") {
        await runGeneration(
          { conversationId: convoIdRef.current ?? undefined, prompt: trimmed, model: opts.model },
          assistantTempId,
          "/api/generate"
        );
        return;
      }

      await runGeneration(
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
          reasoningEffort: opts.reasoningEffort,
          privateMode: opts.privateMode,
          privateHistory: opts.privateMode
            ? [...messages, userMsg]
                .filter((m) => !m.error && (m.role === "USER" || m.role === "ASSISTANT"))
                .map((m) => ({ role: m.role, content: m.content }))
            : undefined,
        },
        assistantTempId
      );
    },
    [
      status,
      runGeneration,
      opts.model,
      opts.voiceMode,
      opts.canvasEnabled,
      opts.webSearch,
      opts.reasoningEffort,
      opts.projectId,
      opts.privateMode,
      messages,
    ]
  );

  const regenerate = React.useCallback(async () => {
    if (status !== "idle" && status !== "error") return;
    if (!convoIdRef.current) return;
    // Drop the trailing assistant message locally and add a fresh placeholder.
    const assistantTempId = tempId();
    setMessages((prev) => {
      const copy = [...prev];
      while (copy.length && copy[copy.length - 1].role === "ASSISTANT") copy.pop();
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
      },
      assistantTempId
    );
  }, [status, runGeneration, opts.model, opts.voiceMode, opts.canvasEnabled, opts.reasoningEffort]);

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
      // Truncate locally to the edited message, update its content.
      const assistantTempId = tempId();
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const kept = prev.slice(0, idx + 1).map((m) => (m.id === messageId ? { ...m, content: newContent } : m));
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
        },
        assistantTempId
      );
    },
    [status, runGeneration, opts.model, opts.canvasEnabled, opts.reasoningEffort]
  );

  const stop = React.useCallback(() => {
    if (!abortRef.current) return;
    stopRequestedRef.current = true;
    setStatus("stopping");

    const generationId = generationIdRef.current;
    const controller = abortRef.current;
    const assistantId = assistantIdRef.current;

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
  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    if (stopFallbackRef.current != null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
    convoIdRef.current = null;
    generationIdRef.current = null;
    assistantIdRef.current = null;
    stopRequestedRef.current = false;
    setMessages([]);
    setArtifacts([]);
    setStatus("idle");
  }, []);

  const setFeedback = React.useCallback((messageId: string, feedback: "UP" | "DOWN" | null) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback } : m)));
    fetch(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    }).catch(() => {});
  }, []);

  const continueResponse = React.useCallback(() => {
    return send("Continue from where you left off.");
  }, [send]);

  return {
    messages,
    artifacts,
    status,
    isBusy: status === "submitting" || status === "thinking" || status === "writing" || status === "stopping",
    send,
    continueResponse,
    regenerate,
    editAndResend,
    stop,
    reset,
    setFeedback,
    setArtifacts,
  };
}
