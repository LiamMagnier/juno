/**
 * What an agent may keep from its own tasks, as pure rules.
 *
 * A Work run can save a short note for its agent (the `remember` tool,
 * runner/agent-core/src/work/tools.ts, saved by src/lib/agents/run-notes.ts).
 * Two decisions are made before anything is stored, and both are here so the
 * tests read the rule that runs.
 *
 * **Whether it waits for the person.** The agent's "What it may remember about
 * you" setting (`memoryAccess`, src/lib/memory-scope.ts) is the person's
 * statement of how far they trust this agent with what it knows about them.
 * A note a task saves is read by every later turn and task of that agent, and
 * the task that wrote it may have been reading a web page or an email nobody
 * vetted. So:
 *
 *   - `full` ("Everything you share with chats"): the person gave this agent
 *     their whole memory, and a note it learns is kept at once. It is still
 *     listed in "What it knows", where one press forgets it.
 *   - `profile` (the default) and `none`: the note is `pending` until the
 *     person keeps it. Nothing reads a pending note.
 *   - Under any setting, a note that touches a sensitive topic (health,
 *     money trouble, …: `sensitiveTopicOf`, the same gate memory uses) waits
 *     for the person.
 *
 * **What it may contain.** Never a secret. Credential-shaped strings (API
 * keys, tokens, private keys, card numbers: `scanAndRedact` in
 * src/lib/security/dlp.ts, the redaction shared transcripts already use) are
 * masked before the note is stored; a note that names a password, passcode,
 * PIN or one-time code with a value is refused outright, because the value a
 * person typed into a question is exactly what a model would copy into
 * "remember this". A note that is nothing but a mask after redaction is
 * refused too: it would be a note about nothing.
 *
 * Pure and client-safe.
 */

import { agentMemoryAccessOf } from "@/lib/memory-scope";
import { sensitiveTopicOf } from "@/lib/memory-sensitive";
import { scanAndRedact } from "@/lib/security/dlp";

export const AGENT_NOTE_STATUSES = ["kept", "pending"] as const;
export type AgentNoteStatus = (typeof AGENT_NOTE_STATUSES)[number];

/** A stored status read back; anything unknown is `pending`, never quietly kept. */
export function agentNoteStatusOf(value: unknown): AgentNoteStatus {
  return value === "kept" ? "kept" : "pending";
}

/** The most notes one run may save. A run that wants more is narrating, not learning. */
export const MAX_RUN_NOTES_PER_RUN = 3;
/** One note's length: a fact, not a transcript. */
export const MAX_RUN_NOTE_CHARS = 500;

export type RunNoteReview = { status: AgentNoteStatus; reason: "full_access" | "needs_review" | "sensitive" };

/** Whether a note a task saved is kept at once or waits for the person. */
export function runNoteReview(input: { memoryAccess: unknown; content: string }): RunNoteReview {
  if (sensitiveTopicOf(input.content) !== null) return { status: "pending", reason: "sensitive" };
  return agentMemoryAccessOf(input.memoryAccess) === "full"
    ? { status: "kept", reason: "full_access" }
    : { status: "pending", reason: "needs_review" };
}

/** The words that name a secret. */
const SECRET_LABEL =
  "(?:pass(?:word|code|phrase)|pwd|pin(?:\\s*code)?|one[-\\s]?time\\s+(?:code|password)|otp|2fa\\s+code|verification\\s+code|security\\s+code|cvv|cvc|api[-\\s]?key|secret(?:\\s+key)?|access\\s+token|auth(?:entication)?\\s+token)";

/**
 * A secret named with its value: "password: hunter2", "the PIN for the door
 * is 4821", "OTP 552019". The label alone ("asks for a password at login",
 * "the API key is in 1Password") is fine; the value is what must never be
 * kept.
 */
const LABEL_THEN_VALUE = new RegExp(
  `\\b${SECRET_LABEL}\\b[^.;:=\\n]{0,30}?(?:\\bis\\b|\\bwas\\b|=|:)\\s*["'\u0060]?([^\\s"'\u0060,;.]{3,})`,
  "gi"
);
// No `g` flag: `test` on a global regex keeps `lastIndex` between calls.
const LABEL_THEN_DIGITS = new RegExp(`\\b${SECRET_LABEL}\\s*#?\\s*(\\d{4,})\\b`, "i");

/** Words that may follow a secret's label without being its value ("the password is required"). */
const NOT_A_VALUE =
  /^(?:required|needed|missing|wrong|incorrect|expired|stored|saved|reset|changed|in|on|at|for|the|a|an|to|from|with|by|of|and|or|not|set|kept|managed|shared|unknown|correct|valid|invalid|same|different|long|short|weak|strong|case|sent|emailed|texted|written|listed|available|hidden|private)$/i;

/** Whether the text names a secret together with its value. */
export function namesASecretValue(text: string): boolean {
  for (const match of text.matchAll(LABEL_THEN_VALUE)) {
    if (!NOT_A_VALUE.test(match[1] ?? "")) return true;
  }
  return LABEL_THEN_DIGITS.test(text);
}

export type ScreenedNote =
  | { ok: true; content: string; redacted: number }
  | { ok: false; reason: "empty" | "too_long" | "secret"; message: string };

/**
 * The note as it may be stored, or why it may not be. `maxChars` is a task's
 * bound by default; a note the person or their chat writes has the profile's
 * longer one (`MAX_AGENT_NOTE_CHARS`), and the same secret rules.
 */
export function screenAgentNote(raw: unknown, options: { maxChars?: number } = {}): ScreenedNote {
  const maxChars = options.maxChars ?? MAX_RUN_NOTE_CHARS;
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return { ok: false, reason: "empty", message: "Say the fact to remember in a sentence." };
  if (text.length > maxChars) {
    return {
      ok: false,
      reason: "too_long",
      message: `That is ${text.length} characters; a note is at most ${maxChars}. Keep only the fact worth remembering.`,
    };
  }
  if (namesASecretValue(text)) {
    return {
      ok: false,
      reason: "secret",
      message:
        "That note names a password, code or key with its value, and notes never keep secrets. Nothing was saved. Remember where the secret lives instead, never the secret.",
    };
  }
  const scan = scanAndRedact(text);
  const content = scan.sanitizedText.trim();
  // Only masks left: a note about nothing.
  if (scan.redactedCount > 0 && content.replace(/\[REDACTED[^\]]*\]/g, "").replace(/[\s\p{P}]/gu, "").length < 8) {
    return { ok: false, reason: "secret", message: "That note was only a key or token, and notes never keep secrets. Nothing was saved." };
  }
  return { ok: true, content, redacted: scan.redactedCount };
}
