/**
 * A transcript a client sends with a share link, for a conversation whose
 * messages are not in Message rows: a Code session that runs on the user's
 * Mac keeps its transcript in the env server's log there, so the server-side
 * snapshot (`getSharedChatSnapshot`) would publish an empty page.
 *
 * WHAT IT MAY CARRY is exactly what a chat link already publishes: the
 * person's messages and the answers, as text. Never the work log (commands,
 * file paths, tool output), never attachments, never reasoning. The client
 * builds it that way (`transcriptFromTurns`) and the server re-checks the
 * shape, bounds it, and redacts anything that looks like a credential before
 * it is stored, because the client is not where a public page's safety can
 * be decided.
 *
 * Pure: no Prisma, no DOM. The share route, the share library and the Code
 * workspace all import it.
 */
import { scanAndRedact } from "@/lib/security/dlp";
import { groupTurns } from "@/lib/code-v2/turns";
import type { TurnItem } from "@/lib/code-v2/contracts";

export interface SharedTranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

export const SHARED_TRANSCRIPT_LIMITS = {
  maxEntries: 400,
  maxEntryChars: 60_000,
  maxTotalChars: 1_000_000,
} as const;

export type SanitizedTranscript =
  | { ok: true; entries: SharedTranscriptEntry[]; redacted: number }
  | { ok: false; error: string };

/** Validates, bounds and redacts a client-supplied transcript. */
export function sanitizeSharedTranscript(input: unknown): SanitizedTranscript {
  if (!Array.isArray(input)) return { ok: false, error: "The transcript must be a list of messages." };
  if (input.length > SHARED_TRANSCRIPT_LIMITS.maxEntries) return { ok: false, error: "This session is too long to share as one link." };
  const entries: SharedTranscriptEntry[] = [];
  let total = 0;
  let redacted = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Each message needs a role and text." };
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return { ok: false, error: "Each message needs a role and text." };
    const text = content.trim();
    if (!text) continue;
    if (text.length > SHARED_TRANSCRIPT_LIMITS.maxEntryChars) return { ok: false, error: "One of the messages is too long to share." };
    total += text.length;
    if (total > SHARED_TRANSCRIPT_LIMITS.maxTotalChars) return { ok: false, error: "This session is too long to share as one link." };
    const scan = scanAndRedact(text);
    redacted += scan.redactedCount;
    entries.push({ role, content: scan.sanitizedText });
  }
  if (!entries.some((e) => e.role === "user")) return { ok: false, error: "Nothing to share yet." };
  return { ok: true, entries, redacted };
}

/**
 * A Code thread's shareable transcript: each turn's opening message and the
 * steers sent into it, then its final answer. Subagents' words, the work log
 * and every intermediate assistant message stay out.
 */
export function transcriptFromTurns(items: readonly TurnItem[]): SharedTranscriptEntry[] {
  const out: SharedTranscriptEntry[] = [];
  for (const turn of groupTurns(items, { state: "idle" })) {
    if (turn.user?.text.trim()) out.push({ role: "user", content: turn.user.text });
    for (const item of turn.items) {
      if (item.kind === "user_message" && !item.agentId && item.text.trim()) out.push({ role: "user", content: item.text });
    }
    if (turn.answer?.text.trim() && !turn.answer.streaming) out.push({ role: "assistant", content: turn.answer.text });
  }
  return out;
}
