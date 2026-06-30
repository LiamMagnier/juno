import { prisma } from "@/lib/prisma";
import { streamChat } from "@/lib/llm";
import type { ModelInfo } from "@/lib/models";
import type { MessageForModel } from "@/types/llm";

/** Recent memories to inject into the model context (most recent first, capped). */
export async function getMemoriesForContext(userId: string, limit = 50): Promise<string[]> {
  const rows = await prisma.memoryEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { content: true },
  });
  return rows.map((r) => r.content);
}

/** Persist auto-extracted memories, skipping near-duplicates. Returns count created. */
export async function saveAutoMemories(userId: string, facts: string[]): Promise<number> {
  if (facts.length === 0) return 0;

  const existing = await prisma.memoryEntry.findMany({
    where: { userId },
    select: { content: true },
  });
  const seen = new Set(existing.map((e) => normalize(e.content)));

  let created = 0;
  for (const fact of facts) {
    const trimmed = fact.trim().slice(0, 500);
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.memoryEntry.create({ data: { userId, content: trimmed, source: "AUTO" } });
    created++;
  }
  return created;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Consolidated memory summary — a periodically regenerated, deduped profile
// (Markdown, sectioned) that replaces the raw sentence-by-sentence list in
// context. Keeps memory tidy and non-redundant over time.
// ---------------------------------------------------------------------------

export interface MemorySummary {
  content: string;
  updatedAt: Date;
  entryCount: number;
}

export async function getMemorySummary(userId: string): Promise<MemorySummary | null> {
  return prisma.memorySummary.findUnique({
    where: { userId },
    select: { content: true, updatedAt: true, entryCount: true },
  });
}

/**
 * What to inject into the model context: the consolidated summary plus any raw
 * memories newer than it (so freshly-saved facts are never missed between
 * consolidations). Falls back to the raw list when no summary exists yet.
 */
export async function getMemoryProfile(userId: string): Promise<{ summary: string | null; recent: string[] }> {
  const summary = await getMemorySummary(userId);
  const rows = await prisma.memoryEntry.findMany({
    where: { userId, ...(summary ? { createdAt: { gt: summary.updatedAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: summary ? 15 : 50,
    select: { content: true },
  });
  return { summary: summary?.content ?? null, recent: rows.map((r) => r.content) };
}

/**
 * Regenerate the consolidated summary from ALL of the user's memories using a
 * cheap model. Returns the new Markdown, or null if there's nothing to
 * summarize / the model failed (in which case the old summary is left intact).
 */
export async function consolidateMemories(opts: { userId: string; model: ModelInfo }): Promise<string | null> {
  const rows = await prisma.memoryEntry.findMany({
    where: { userId: opts.userId },
    orderBy: { createdAt: "asc" },
    select: { content: true },
  });
  if (rows.length === 0) {
    await prisma.memorySummary.deleteMany({ where: { userId: opts.userId } });
    return null;
  }

  const facts = rows.map((r) => r.content);
  const system = `You maintain a tidy long-term memory profile of a user, used to personalize future conversations. You are given the raw list of remembered facts collected over time — possibly redundant, out of order, or partly outdated. Rewrite them into a clean, deduplicated, well-organized summary in Markdown.
Rules:
- Group related facts under "## " section headings, and INCLUDE A SECTION ONLY IF IT HAS CONTENT. Prefer these, in this order: Work context, Personal context, Preferences, Projects & goals, Top of mind.
- Merge duplicates and near-duplicates; resolve contradictions by keeping the most recent / most specific fact.
- Write in the third person as concise prose (a short paragraph per section) — synthesize, don't just restate each fact as a bullet.
- Keep only durable, non-sensitive facts. Never include secrets.
- Output ONLY the Markdown summary — no preamble, no closing remarks.`;
  const userMsg = `Raw remembered facts (oldest to newest):\n${facts.map((f) => `- ${f}`).join("\n")}\n\nWrite the consolidated Markdown memory summary.`;

  let out = "";
  try {
    for await (const ev of streamChat({
      model: opts.model,
      system,
      history: [{ role: "USER", content: userMsg, attachments: [] }],
      maxTokens: 900,
    })) {
      if (ev.type === "text") out += ev.text;
    }
  } catch {
    return null;
  }

  const content = out.trim();
  if (!content) return null;
  await prisma.memorySummary.upsert({
    where: { userId: opts.userId },
    create: { userId: opts.userId, content, entryCount: rows.length },
    update: { content, entryCount: rows.length },
  });
  return content;
}

/**
 * Background, periodic-ish consolidation: regenerate the summary only when the
 * set of memories has changed AND the existing summary is missing or stale
 * (>12h old). Cheap no-op otherwise — safe to call after every exchange.
 */
export async function maybeConsolidate(userId: string, model: ModelInfo): Promise<void> {
  const [count, summary] = await Promise.all([
    prisma.memoryEntry.count({ where: { userId } }),
    prisma.memorySummary.findUnique({ where: { userId }, select: { entryCount: true, updatedAt: true } }),
  ]);
  if (count === 0) return;
  const STALE_MS = 12 * 60 * 60 * 1000;
  const changed = !summary || summary.entryCount !== count;
  const stale = !summary || Date.now() - summary.updatedAt.getTime() > STALE_MS;
  if (changed && stale) {
    await consolidateMemories({ userId, model }).catch(() => {});
  }
}

function parseFactsJson(text: string): string[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim().slice(0, 500))
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Proactively extract durable facts about the user from the latest exchange,
 * using a cheap model — so things get remembered even when the user didn't ask
 * and even when the answering model didn't emit memory tags. Runs in the
 * background (see the chat route's `after()` call). Returns # of new memories.
 */
export async function autoExtractMemories(opts: {
  userId: string;
  model: ModelInfo;
  history: MessageForModel[];
  assistantText: string;
  existing: string[];
}): Promise<number> {
  const lastUser = [...opts.history].reverse().find((m) => m.role === "USER")?.content?.slice(0, 4000) ?? "";
  if (!lastUser && !opts.assistantText) return 0;

  const system = `You maintain a long-term memory of durable facts about the user to personalize future conversations. From the exchange below, extract any NEW, durable facts worth remembering — their identity, role, location, preferences, the tools/languages they use, ongoing projects and goals, and anything they asked you to remember. Ignore one-off task details and anything already known. Never store secrets.
Return ONLY a JSON array of short third-person fact strings, e.g. ["The user is a CS student in France learning SwiftUI."]. Return [] if there is nothing new worth saving.
Already known about the user:
${opts.existing.length ? opts.existing.map((f) => `- ${f}`).join("\n") : "(nothing yet)"}`;

  const userMsg = `User: ${lastUser}\n\nAssistant: ${opts.assistantText.slice(0, 4000)}\n\nExtract new durable facts about the user as a JSON array.`;

  let out = "";
  try {
    for await (const ev of streamChat({
      model: opts.model,
      system,
      history: [{ role: "USER", content: userMsg, attachments: [] }],
      maxTokens: 400,
    })) {
      if (ev.type === "text") out += ev.text;
    }
  } catch {
    return 0;
  }

  return saveAutoMemories(opts.userId, parseFactsJson(out));
}
