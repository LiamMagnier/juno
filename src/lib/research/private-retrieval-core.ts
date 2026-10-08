/**
 * Deep Research's own-sources retrieval, as ports and pure rules.
 *
 * The server half (`private-retrieval.ts`) binds these ports to the real
 * stores: the knowledge index for files, project and library, the memory
 * profile, and the connector toolset for calendar and mail. Everything that
 * decides WHAT is searched and HOW a result becomes a citable source lives
 * here, free of Prisma and the network, so the gate and the citation format
 * are tested without either (`tests/research-private-sources.test.ts`).
 *
 * Three rules hold for every kind:
 *
 * 1. Only enabled options are searched. The engine already hands over only
 *    enabled, offered options; this module checks again and never widens.
 * 2. Every result is a `https://private.invalid/` address with a title a person can find
 *    the record by: file and page, subject and date, event and date.
 * 3. Connectors are read-only and unattended. A tool the toolset does not
 *    classify as a read is never called, and a call the approval policy
 *    refuses (an "always ask" account) is reported as skipped, never retried
 *    and never escalated to a prompt nobody is there to answer.
 */
import { contentTokens } from "@/lib/research/claim-analysis";
import {
  type PrivateSourceKind,
  type PrivateSourceOption,
  privateSourceTitle,
  privateSourceUrl,
} from "@/lib/research/private-sources";
import type { PrivateResearchHit } from "@/lib/research/stages/types";

/** A passage from the knowledge index, as `retrieveKnowledge` returns it. */
export interface PrivatePassage {
  documentId: string;
  fileName: string;
  ordinal: number;
  text: string;
  /** "page 4", or empty. */
  locator: string;
  documentAt?: Date | null;
}

/** One connector tool call's outcome, with the untrusted envelope already removed. */
export interface ConnectorCallResult {
  ok: boolean;
  body: string;
}

export interface PrivateRetrievalPorts {
  /** Files attached to this conversation. */
  chatFiles?(input: { userId: string; conversationId: string; query: string; signal?: AbortSignal }): Promise<PrivatePassage[]>;
  /** The conversation's project knowledge. */
  project?(input: { userId: string; conversationId: string; query: string; signal?: AbortSignal }): Promise<PrivatePassage[]>;
  /** Every indexed file the person owns. */
  library?(input: { userId: string; query: string; signal?: AbortSignal }): Promise<PrivatePassage[]>;
  /** Saved memories relevant to the query. */
  memory?(input: { userId: string; query: string }): Promise<string[]>;
  /**
   * A connector session: whether a tool is a read, and the call itself. Opened
   * once per search and always closed. Null when the connector is not usable
   * (not linked, not configured, blocked).
   */
  openConnector?(input: {
    userId: string;
    runId: string;
    conversationId: string | null;
    connectorId: string;
    timeZone?: string | null;
  }): Promise<ConnectorSession | null>;
  now?(): Date;
}

export interface ConnectorSession {
  isRead(tool: string): boolean;
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectorCallResult>;
  close(): Promise<void>;
}

/** Passages kept per question per source. */
export const PASSAGES_PER_QUESTION = 4;
/** Calendar events kept per run pass. */
export const MAX_EVENTS = 8;
/** Messages read in full per run pass. */
export const MAX_MESSAGES = 4;
/** How far back and ahead a calendar search looks. */
export const CALENDAR_WINDOW_DAYS = 120;

/**
 * Knowledge passages grouped into citable sources: one per file and page, the
 * passages of one page joined in reading order. Two passages of one page are
 * one citation, and page 3 and page 9 of one file are two.
 */
export function passagesToHits(
  passages: readonly PrivatePassage[],
  kind: Extract<PrivateSourceKind, "file" | "project" | "library">,
  optionKey: string
): PrivateResearchHit[] {
  const groups = new Map<string, { passage: PrivatePassage; parts: PrivatePassage[] }>();
  for (const passage of passages) {
    if (!passage.text.trim()) continue;
    const locator = passage.locator.trim();
    const key = `${passage.documentId}\u0000${locator || `#${passage.ordinal}`}`;
    const group = groups.get(key) ?? { passage, parts: [] };
    if (!group.parts.some((part) => part.ordinal === passage.ordinal)) group.parts.push(passage);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ passage, parts }) => {
    const locator = passage.locator.trim() || `part ${passage.ordinal + 1}`;
    return {
      url: privateSourceUrl({ kind, id: passage.documentId, locator }),
      title: privateSourceTitle({ kind, name: passage.fileName, locator }),
      text: parts
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((part) => part.text.trim())
        .join("\n\n"),
      kind,
      optionKey,
      publishedAt: passage.documentAt ?? null,
    };
  });
}

/** One event line of the calendar connector's `list_events` text. */
export interface CalendarEventLine {
  summary: string;
  when: string;
  calendar: string;
  uid: string;
  start: Date | null;
  line: string;
}

const EVENT_LINE = /^•\s*(.+?) — (.+?) · calendar: (.+?) · uid: (\S+)\s*$/;

/** The events out of `list_events`' text (src/lib/apple/tool-text.ts `formatOccurrence`). */
export function parseCalendarListing(body: string): CalendarEventLine[] {
  const out: CalendarEventLine[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const match = EVENT_LINE.exec(line);
    if (!match) continue;
    const when = match[2];
    const iso = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)?/.exec(when);
    const start = iso ? new Date(iso[2] ? `${iso[1]}${iso[2]}` : `${iso[1]}T00:00:00Z`) : null;
    out.push({
      summary: match[1].trim(),
      when,
      calendar: match[3].trim(),
      uid: match[4],
      start: start && Number.isFinite(start.getTime()) ? start : null,
      line,
    });
  }
  return out;
}

/** One message line of the mail connector's `search_messages` text. */
export interface MailMessageLine {
  mailbox: string | null;
  uid: number;
  subject: string;
  from: string;
  date: Date | null;
}

const MAIL_LINE = /^•\s*\[(?:(.+?) · )?uid (\d+)\]\s*(.*?) — from (.*?)(?: · (\d{4}-\d{2}-\d{2}T[^·]*?))?(?: · unread)?\s*$/;

/** The messages out of `search_messages`' text (src/app/api/mcp/[connector]/route.ts). */
export function parseMailListing(body: string): MailMessageLine[] {
  const out: MailMessageLine[] = [];
  for (const raw of body.split("\n")) {
    const match = MAIL_LINE.exec(raw.trim());
    if (!match) continue;
    const date = match[5] ? new Date(match[5].trim()) : null;
    out.push({
      mailbox: match[1]?.trim() || null,
      uid: Number(match[2]),
      subject: match[3].trim() || "(no subject)",
      from: match[4].trim(),
      date: date && Number.isFinite(date.getTime()) ? date : null,
    });
  }
  return out;
}

/** How many of the questions' content words a text shares. */
export function overlapScore(text: string, wanted: ReadonlySet<string>): number {
  let n = 0;
  for (const token of contentTokens(text)) if (wanted.has(token)) n += 1;
  return n;
}

/**
 * The words a mailbox is searched for: the most distinctive content words of
 * the questions, longest first (a mail server's text search matches a word,
 * not a question). The search happens inside the person's own mail account.
 */
export function mailSearchTerms(questions: readonly string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const question of questions) for (const token of contentTokens(question)) {
    if (token.length < 4 || /^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([token]) => token);
}

function dayOffset(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

const SKIP = {
  notUsable: "That connector is not connected or not available right now.",
  notRead: "That connector has no read-only search this run can use.",
  refused: "Your approval settings ask before any connector read, and a research run has nobody to ask, so it was skipped.",
} as const;

/**
 * Searches the enabled options for the questions. Never throws for one
 * source: a source that fails is reported in `skipped` and the others still
 * answer.
 */
export async function searchPrivateSourcesWith(
  ports: PrivateRetrievalPorts,
  input: {
    userId: string;
    runId: string;
    conversationId: string | null;
    options: readonly PrivateSourceOption[];
    enabled: readonly string[];
    questions: readonly string[];
    timeZone?: string | null;
    signal?: AbortSignal;
  }
): Promise<{ hits: PrivateResearchHit[]; skipped: Array<{ key: string; reason: string }> }> {
  const on = new Set(input.enabled);
  const options = input.options.filter((option) => on.has(option.key));
  const hits: PrivateResearchHit[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const questions = input.questions.map((q) => q.trim()).filter(Boolean);
  if (questions.length === 0) return { hits, skipped };
  const wanted = new Set<string>();
  for (const question of questions) for (const token of contentTokens(question)) wanted.add(token);
  const now = ports.now?.() ?? new Date();

  const knowledge = async (
    option: PrivateSourceOption,
    kind: "file" | "project" | "library",
    run: (query: string) => Promise<PrivatePassage[]>
  ) => {
    const passages: PrivatePassage[] = [];
    for (const query of questions) {
      if (input.signal?.aborted) break;
      passages.push(...(await run(query)).slice(0, PASSAGES_PER_QUESTION));
    }
    hits.push(...passagesToHits(passages, kind, option.key));
  };

  for (const option of options) {
    if (input.signal?.aborted) break;
    try {
      switch (option.kind) {
        case "file": {
          if (!ports.chatFiles || !input.conversationId) break;
          const conversationId = input.conversationId;
          await knowledge(option, "file", (query) => ports.chatFiles!({ userId: input.userId, conversationId, query, signal: input.signal }));
          break;
        }
        case "project": {
          if (!ports.project || !input.conversationId) break;
          const conversationId = input.conversationId;
          await knowledge(option, "project", (query) => ports.project!({ userId: input.userId, conversationId, query, signal: input.signal }));
          break;
        }
        case "library": {
          if (!ports.library) break;
          await knowledge(option, "library", (query) => ports.library!({ userId: input.userId, query, signal: input.signal }));
          break;
        }
        case "memory": {
          if (!ports.memory) break;
          const facts = [...new Set(await ports.memory({ userId: input.userId, query: questions.join("\n") }))].slice(0, 12);
          if (facts.length === 0) break;
          hits.push({
            url: privateSourceUrl({ kind: "memory", id: "saved" }),
            title: privateSourceTitle({ kind: "memory", name: "Your saved memories" }),
            text: facts.map((fact) => `- ${fact.replace(/\s+/g, " ").trim()}`).join("\n"),
            kind: "memory",
            optionKey: option.key,
          });
          break;
        }
        case "calendar":
        case "mail":
        case "connector": {
          if (!ports.openConnector || !option.connectorId) {
            skipped.push({ key: option.key, reason: SKIP.notUsable });
            break;
          }
          const session = await ports.openConnector({
            userId: input.userId,
            runId: input.runId,
            conversationId: input.conversationId,
            connectorId: option.connectorId,
            timeZone: input.timeZone,
          });
          if (!session) {
            skipped.push({ key: option.key, reason: SKIP.notUsable });
            break;
          }
          try {
            if (option.kind === "calendar") {
              const tool = `${option.connectorId}__list_events`;
              if (!session.isRead(tool)) {
                skipped.push({ key: option.key, reason: SKIP.notRead });
                break;
              }
              const result = await session.call(
                tool,
                { from: dayOffset(now, -CALENDAR_WINDOW_DAYS), to: dayOffset(now, CALENDAR_WINDOW_DAYS), limit: 200 },
                input.signal
              );
              if (!result.ok) {
                skipped.push({ key: option.key, reason: SKIP.refused });
                break;
              }
              const events = parseCalendarListing(result.body)
                .map((event) => ({ event, score: overlapScore(`${event.summary} ${event.calendar}`, wanted) }))
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_EVENTS);
              for (const { event } of events) {
                hits.push({
                  url: privateSourceUrl({ kind: "calendar", id: event.uid, ...(event.start ? { locator: event.start.toISOString().slice(0, 10) } : {}) }),
                  title: privateSourceTitle({ kind: "calendar", name: event.summary, date: event.start }),
                  text: `Calendar event: ${event.summary}\nWhen: ${event.when}\nCalendar: ${event.calendar}`,
                  kind: "calendar",
                  optionKey: option.key,
                  publishedAt: event.start,
                });
              }
            } else if (option.kind === "mail") {
              const search = `${option.connectorId}__search_messages`;
              const read = `${option.connectorId}__read_message`;
              if (!session.isRead(search) || !session.isRead(read)) {
                skipped.push({ key: option.key, reason: SKIP.notRead });
                break;
              }
              const seen = new Map<string, { message: MailMessageLine; score: number }>();
              let refused = false;
              for (const term of mailSearchTerms(questions)) {
                const result = await session.call(search, { mailbox: "all", query: term, limit: 10 }, input.signal);
                if (!result.ok) {
                  refused = true;
                  break;
                }
                for (const message of parseMailListing(result.body)) {
                  const key = `${message.mailbox ?? "INBOX"}:${message.uid}`;
                  if (!seen.has(key)) seen.set(key, { message, score: overlapScore(message.subject, wanted) });
                }
              }
              if (refused) {
                skipped.push({ key: option.key, reason: SKIP.refused });
                break;
              }
              const best = [...seen.values()]
                .sort((a, b) => b.score - a.score || (b.message.date?.getTime() ?? 0) - (a.message.date?.getTime() ?? 0))
                .slice(0, MAX_MESSAGES);
              for (const { message } of best) {
                const mailbox = message.mailbox ?? "INBOX";
                const body = await session.call(read, { mailbox, uid: message.uid }, input.signal);
                if (!body.ok || !body.body.trim()) continue;
                hits.push({
                  url: privateSourceUrl({ kind: "mail", id: `${mailbox}:${message.uid}` }),
                  title: privateSourceTitle({ kind: "mail", name: message.subject, date: message.date }),
                  text: body.body.trim(),
                  kind: "mail",
                  optionKey: option.key,
                  publishedAt: message.date,
                });
              }
            } else {
              // A generic connector has no search this run knows how to drive read-only.
              skipped.push({ key: option.key, reason: SKIP.notRead });
            }
          } finally {
            await session.close().catch(() => undefined);
          }
          break;
        }
      }
    } catch (error) {
      if (input.signal?.aborted) break;
      console.error("[research] private source failed", { kind: option.kind, error: error instanceof Error ? error.message : "unknown" });
      skipped.push({ key: option.key, reason: "That source could not be searched this time." });
    }
  }
  return { hits, skipped };
}
