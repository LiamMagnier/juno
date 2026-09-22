/*
 * THE EXTRACTION PROMPT — what the model that reads a chat is told, and how
 * its answer is read back.
 *
 * Its own module, pure, for one reason: the recall benchmark
 * (src/lib/memory-bench.ts) has to measure the prompt production sends, not a
 * copy of it. Two copies of a prompt drift, and a benchmark of the wrong copy
 * reports on a reader nobody runs.
 */

/**
 * The version of the reader that distils chats into facts. Stored on every
 * conversation it reads (ConversationMemory.extractorVersion), so that when
 * the reader improves, the dreamer knows which history was read by an older
 * one and re-reads it — the part of "learning from history" that makes old
 * chats worth reading twice.
 *
 *   1  everything before versioning.
 *   2  "Already known" lists only facts Juno currently believes, in the
 *      chat's own scope. Version 1 listed the newest facts from anywhere, in
 *      any state: a project chat was told it already knew another project's
 *      notes and skipped them, a plain chat skipped anything a project had
 *      heard first, and a fact Juno had stopped believing ("lives in Madrid",
 *      before the year in Valencia) was skipped when the user said it again.
 *      Re-reading with v2 recovers exactly those facts.
 */
export const EXTRACTOR_VERSION = 2;

/** At most this many facts per call — a chunk is a slice of chat, not a biography. */
export const EXTRACTION_MAX_FACTS = 12;

/** How many known facts the prompt lists — the newest in scope. */
export const EXTRACTION_KNOWN_FACTS = 40;

export function extractionSystemPrompt(opts: {
  /** Sensitive subjects the account has NOT opted into, as readable labels. */
  offLimitsLabels: readonly string[];
  /** Statements the user asked Juno to forget. */
  suppressions: readonly string[];
  /** Facts already stored in this chat's scope, newest first. */
  known: readonly string[];
}): string {
  const offLimits = opts.offLimitsLabels.length
    ? `NEVER extract anything touching these subjects, even when the user states it plainly — ${opts.offLimitsLabels.join(", ")}. Leave them out entirely rather than paraphrasing around them.\n`
    : "";
  const forgotten = opts.suppressions.length
    ? `The user asked to FORGET the following — never extract anything about them:\n${opts.suppressions.map((s) => `- ${s}`).join("\n")}\n`
    : "";
  return `You maintain a long-term memory of durable facts about a user. From the chat messages below (all written BY the user), extract NEW durable facts worth remembering — identity, role, location, preferences, tools and languages they use, ongoing projects, goals, recurring themes. Ignore one-off task details, questions that reveal nothing durable, and anything already known. Never extract secrets, passwords, or API keys.
${offLimits}${forgotten}Already known:
${opts.known.length ? opts.known.map((f) => `- ${f}`).join("\n") : "(nothing yet)"}

Return ONLY JSON: {"facts":["<short third-person fact>", ...],"digest":"<one line: what this chat is about>"} — facts may be empty.`;
}

export function extractionUserMessage(opts: { title: string; messages: readonly string[] }): string {
  return `Chat title: ${opts.title}\nUser messages (oldest to newest):\n${opts.messages
    .map((m) => `- ${m}`)
    .join("\n")}\n\nReturn the JSON.`;
}

/** The model's answer, or null when it is not the JSON asked for. */
export function parseExtraction(text: string): { facts: string[]; digest: string | null } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const facts = Array.isArray(obj.facts)
      ? obj.facts
          .filter((f: unknown): f is string => typeof f === "string" && !!f.trim())
          .map((f: string) => f.trim().slice(0, 500))
          .slice(0, EXTRACTION_MAX_FACTS)
      : [];
    const digest = typeof obj.digest === "string" && obj.digest.trim() ? obj.digest.trim().slice(0, 300) : null;
    return { facts, digest };
  } catch {
    return null;
  }
}
