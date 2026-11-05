/**
 * A voice call's tool chips, from the relay's `tool.activity` frames
 * (relay/src/tools.ts), and what this client does when the person answers a
 * card aloud (`tool.spoken`). Pure and client-safe: the hook folds frames
 * through these, and the dock renders what comes out.
 */

import type { ActionApprovalDecision, ClientActionApproval } from "@/lib/action-approval";
import type { VoiceServerMessage, VoiceToolStatus } from "@/lib/voice-relay-protocol";

/** One tool call of the current voice call, as its chip shows it. */
export interface VoiceToolActivity {
  id: string;
  name: string;
  label: string;
  status: VoiceToolStatus;
  /** The chat's approval, while the call waits on the person; null otherwise. */
  approval: ClientActionApproval | null;
  /** A spoken yes may answer the approval (false: only the card). */
  spoken: boolean;
  /** The person answered the card aloud and this client sent that answer; the card steps aside. */
  answeredAloud: "allow_once" | "deny" | null;
}

/** The most chips a call keeps: the newest, since a call can run many tools. */
export const VOICE_TOOL_ACTIVITY_MAX = 6;

type ToolActivityFrame = Extract<VoiceServerMessage, { type: "tool.activity" }>;
type ToolSpokenFrame = Extract<VoiceServerMessage, { type: "tool.spoken" }>;

/**
 * The chips after one frame: a new call is added at the end, a known one is
 * updated in place, and an approval is kept only while the call waits on it —
 * an answered or abandoned card must not stay answerable on screen. A call
 * waiting on the person is never the one dropped for space.
 */
export function applyVoiceToolActivity(list: readonly VoiceToolActivity[], frame: ToolActivityFrame): VoiceToolActivity[] {
  const waiting = frame.status === "awaiting_approval";
  const index = list.findIndex((entry) => entry.id === frame.id);
  const previous = index >= 0 ? list[index] : null;
  const next: VoiceToolActivity = {
    id: frame.id,
    name: frame.name,
    label: frame.label || previous?.label || frame.name,
    status: frame.status,
    approval: waiting ? (frame.approval ?? previous?.approval ?? null) : null,
    spoken: waiting ? frame.spoken === true : false,
    answeredAloud: waiting ? (previous?.answeredAloud ?? null) : null,
  };
  const updated = index >= 0 ? list.map((entry, i) => (i === index ? next : entry)) : [...list, next];
  while (updated.length > VOICE_TOOL_ACTIVITY_MAX) {
    const drop = updated.findIndex((entry) => entry.status !== "awaiting_approval");
    updated.splice(drop >= 0 ? drop : 0, 1);
  }
  return updated;
}

/** The decision this client sends for a spoken answer: the chat's own route and body. */
export interface SpokenApprovalRequest {
  url: string;
  body: { decision: ActionApprovalDecision; receiptDigest: string };
}

/**
 * What a spoken answer does here. The relay heard the person and recorded
 * nothing; this signed-in client answers the card the way a tap does — the
 * chat's decision route, the digest of the card it is showing. Only for a
 * card it is showing, for the approval the frame names, and a yes only where
 * that card may be answered aloud; anything else changes nothing.
 */
export function applySpokenAnswer(
  list: readonly VoiceToolActivity[],
  frame: ToolSpokenFrame
): { list: VoiceToolActivity[]; request: SpokenApprovalRequest | null } {
  const index = list.findIndex((entry) => entry.id === frame.id);
  const entry = index >= 0 ? list[index] : null;
  const approval = entry?.approval;
  if (!entry || entry.status !== "awaiting_approval" || !approval || approval.id !== frame.approvalId || entry.answeredAloud) {
    return { list: [...list], request: null };
  }
  // A no may always be said; a yes only to a card that takes one aloud.
  const permitted = frame.decision === "deny" || (frame.decision === "allow_once" && entry.spoken);
  if (!permitted) return { list: [...list], request: null };
  return {
    list: list.map((item, i) => (i === index ? { ...item, answeredAloud: frame.decision } : item)),
    request: {
      url: `/api/approvals/${encodeURIComponent(approval.id)}`,
      body: { decision: frame.decision, receiptDigest: approval.receiptDigest },
    },
  };
}

/** A spoken answer the route refused: the card comes back, so the person can see why and answer it there. */
export function withdrawSpokenAnswer(list: readonly VoiceToolActivity[], id: string): VoiceToolActivity[] {
  return list.map((entry) => (entry.id === id ? { ...entry, answeredAloud: null } : entry));
}

/** The chip's state word, for its label and for screen readers. */
export function voiceToolStatusWord(entry: Pick<VoiceToolActivity, "status" | "answeredAloud">): string {
  if (entry.status === "awaiting_approval" && entry.answeredAloud) {
    return entry.answeredAloud === "deny" ? "Declining" : "Approving";
  }
  switch (entry.status) {
    case "running":
      return "Working";
    case "awaiting_approval":
      return "Needs your OK";
    case "succeeded":
      return "Done";
    case "denied":
      return "Declined";
    case "cancelled":
      return "Stopped";
    default:
      return "Failed";
  }
}
