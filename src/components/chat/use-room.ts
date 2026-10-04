"use client";

import * as React from "react";
import type { ClientRoomDetail } from "@/lib/agents/room-types";
import {
  liveRoomSpeaker,
  roomSpeakersByMessage,
  roomTurnToDispatch,
  type RoomSpeaker,
} from "@/lib/agents/room-client";

/**
 * A room in ChatView: its detail (members, turns, what runs next), the
 * speaker of every reply, and the bounded follow-up dispatch.
 *
 * The page hands the first detail in (`initialRoom`, read with the
 * conversation), so an ordinary chat never fetches anything here. In a room
 * the detail is re-read when a reply starts (the server has just written the
 * plan, so the live speaker is known) and when it ends (so `next` is current),
 * and `next` is dispatched one at a time through `continueRoomTurn`.
 */
export function useRoom(input: {
  conversationId: string | null;
  initialRoom: ClientRoomDetail | null;
  privateMode: boolean;
  busy: boolean;
  continueRoomTurn: (agentId: string) => Promise<boolean>;
}) {
  const { conversationId, privateMode, busy, continueRoomTurn } = input;
  const [detail, setDetail] = React.useState<ClientRoomDetail | null>(input.initialRoom);
  const [dispatchedAgentId, setDispatchedAgentId] = React.useState<string | null>(null);
  /** Turns this tab has dispatched, by `userMessageId:agentId`. Never cleared for a conversation. */
  const dispatchedRef = React.useRef<Set<string>>(new Set());
  const isRoom = !!detail && !privateMode;

  React.useEffect(() => {
    setDetail(input.initialRoom);
    dispatchedRef.current = new Set();
    setDispatchedAgentId(null);
    // Only a different conversation resets the room; a refreshed initialRoom
    // object for the same one must not forget what this tab dispatched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const refresh = React.useCallback(async (): Promise<ClientRoomDetail | null> => {
    if (!conversationId || privateMode) return null;
    try {
      const res = await fetch(`/api/agents/rooms/${encodeURIComponent(conversationId)}`, { cache: "no-store" });
      if (res.status === 404) {
        setDetail(null);
        return null;
      }
      if (!res.ok) return null;
      const next = (await res.json()) as ClientRoomDetail;
      setDetail(next);
      return next;
    } catch {
      return null;
    }
  }, [conversationId, privateMode]);

  // Busy edges: the start of a reply (the plan is written, the speaker known)
  // and its end (the turn answered, the next one pending).
  const wasBusyRef = React.useRef(busy);
  React.useEffect(() => {
    if (!isRoom) {
      wasBusyRef.current = busy;
      return;
    }
    if (busy !== wasBusyRef.current) {
      wasBusyRef.current = busy;
      if (!busy) {
        setDispatchedAgentId(null);
        void refresh();
        return;
      }
      // The plan is written once the person's message is saved, a moment
      // after the request leaves; read it then to name who is answering.
      const timer = window.setTimeout(() => void refresh(), 1200);
      return () => window.clearTimeout(timer);
    }
  }, [busy, isRoom, refresh]);

  // Dispatch the next turn, bounded per message and remembered across
  // refreshes. On a reload the page's detail may already name a pending turn:
  // running it is right (it is waiting), and the server lets only one tab in.
  React.useEffect(() => {
    if (!isRoom) return;
    const turn = roomTurnToDispatch({ detail, busy, dispatched: dispatchedRef.current });
    if (!turn) return;
    dispatchedRef.current.add(turn.key);
    setDispatchedAgentId(turn.agentId);
    void continueRoomTurn(turn.agentId).then((ran) => {
      if (!ran) {
        setDispatchedAgentId(null);
        void refresh();
      }
    });
  }, [detail, busy, isRoom, continueRoomTurn, refresh]);

  const speakers = React.useMemo(() => roomSpeakersByMessage(isRoom ? detail : null), [detail, isRoom]);
  const live = React.useMemo(
    () => (isRoom && busy ? liveRoomSpeaker(detail, dispatchedAgentId) : null),
    [detail, dispatchedAgentId, isRoom, busy]
  );

  return { detail: isRoom ? detail : null, speakers, live, refresh } as {
    detail: ClientRoomDetail | null;
    speakers: Map<string, RoomSpeaker>;
    live: RoomSpeaker | null;
    refresh: () => Promise<ClientRoomDetail | null>;
  };
}
