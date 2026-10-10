"use client";

import * as React from "react";
import type { CrossMessageRowData } from "@/components/chat/cross-message-row";

/*
 * Conversations messaging each other, on the web (src/lib/cross-conversation).
 *
 * useCrossMessages: one open Chat's messages to and from the person's other
 * conversations, for the transcript rows. It marks received ones read, and
 * when one is waiting for a reply and the chat is idle, it runs that reply
 * here (useChat.continueCrossReply) so the reader watches it stream.
 *
 * useCrossMessageInbox: for the whole shell. It names the chats with an unread
 * message (the sidebar's medium-weight title) and starts the replies owed by
 * chats that are NOT open, so a message gets its answer as long as Alevr is
 * open somewhere. The server claims each message before answering it, so two
 * tabs or devices never answer twice.
 */

export interface ClientCrossMessage extends CrossMessageRowData {
  peerRef: string;
  peerProduct: "chat" | "code";
  hop: number;
  createdAt: string;
  read: boolean;
}

const POLL_MS = 15_000;

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function useCrossMessages(
  conversationId: string | null,
  opts: { busy: boolean; privateMode?: boolean; continueCrossReply?: (linkId: string) => Promise<boolean> },
) {
  const [messages, setMessages] = React.useState<ClientCrossMessage[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const dispatched = React.useRef(new Set<string>());
  const markedRead = React.useRef(false);
  const id = opts.privateMode ? null : conversationId;

  const load = React.useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/cross-messages`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { messages?: ClientCrossMessage[]; enabled?: boolean } | null;
    if (!body) return;
    setMessages(body.messages ?? []);
    setEnabled(!!body.enabled);
  }, [id]);

  React.useEffect(() => {
    setMessages([]);
    markedRead.current = false;
    void load();
    const timer = setInterval(() => visible() && void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A turn just ended here: it may have sent one, or answered one.
  const wasBusy = React.useRef(opts.busy);
  React.useEffect(() => {
    if (wasBusy.current && !opts.busy) void load();
    wasBusy.current = opts.busy;
  }, [opts.busy, load]);

  React.useEffect(() => {
    if (!id || markedRead.current) return;
    if (!messages.some((m) => m.direction === "received" && !m.read)) return;
    markedRead.current = true;
    void fetch(`/api/conversations/${encodeURIComponent(id)}/cross-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).then(() => window.dispatchEvent(new CustomEvent("alevr:cross-read", { detail: { conversationId: id } })));
  }, [id, messages]);

  // Answer the oldest message waiting here, once the chat is idle.
  const { busy, continueCrossReply } = opts;
  React.useEffect(() => {
    if (!id || busy || !continueCrossReply) return;
    const waiting = messages.find((m) => m.direction === "received" && m.status === "queued" && !dispatched.current.has(m.id));
    if (!waiting) return;
    dispatched.current.add(waiting.id);
    void continueCrossReply(waiting.id).then(() => load());
  }, [id, messages, busy, continueCrossReply, load]);

  const setConversationToggle = React.useCallback(
    async (value: boolean | null) => {
      if (!id) return;
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/cross-messages`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: value }),
      }).catch(() => null);
      if (res?.ok) setEnabled(!!((await res.json()) as { enabled?: boolean }).enabled);
    },
    [id],
  );

  return { messages, enabled, reload: load, setConversationToggle };
}

/** Pure: the replies a shell should start, given what is open and what it already started. */
export function repliesToStart(
  replies: readonly { linkId: string; conversationId: string }[],
  openConversationId: string | null,
  started: ReadonlySet<string>,
): { linkId: string; conversationId: string }[] {
  const seen = new Set<string>();
  return replies.filter((r) => {
    if (r.conversationId === openConversationId || started.has(r.linkId) || seen.has(r.conversationId)) return false;
    seen.add(r.conversationId); // one reply per conversation at a time; the next waits its turn
    return true;
  });
}

export function useCrossMessageInbox(openConversationId: string | null): ReadonlySet<string> {
  const [unread, setUnread] = React.useState<ReadonlySet<string>>(new Set());
  const started = React.useRef(new Set<string>());
  const openRef = React.useRef(openConversationId);
  openRef.current = openConversationId;

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!visible()) return;
      const res = await fetch("/api/cross-messages/pending", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const body = (await res.json().catch(() => null)) as { replies?: { linkId: string; conversationId: string }[]; unread?: string[] } | null;
      if (!body || cancelled) return;
      setUnread(new Set(body.unread ?? []));
      for (const reply of repliesToStart(body.replies ?? [], openRef.current, started.current)) {
        started.current.add(reply.linkId);
        // The generation runs on the server whether or not anyone stays to
        // read it; this tab only needs the server to have started it.
        const controller = new AbortController();
        void fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: reply.conversationId, regenerate: true, crossReply: { linkId: reply.linkId }, client: "web" }),
          signal: controller.signal,
        })
          .then(() => controller.abort())
          .catch(() => undefined);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    const onRead = (event: Event) => {
      const id = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (id) setUnread((prev) => new Set([...prev].filter((x) => x !== id)));
    };
    window.addEventListener("alevr:cross-read", onRead);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("alevr:cross-read", onRead);
    };
  }, []);

  return unread;
}
