/**
 * The unified search engine: one query, eight sources, one grouped answer.
 *
 * Deliberately free of `server-only`, of Prisma's client and of node:crypto.
 * Everything it needs to reach the world arrives as `SearchDeps` — a statement
 * runner and a decrypt function — for two reasons.
 *
 * The first is testability: tests/unified-search.test.ts drives this with a
 * fake runner that honours the `userId` bound into each statement, which is how
 * cross-account isolation gets a real test in a repository with no test
 * database. A test that only inspected the SQL string would pass on a statement
 * whose scope was never actually applied; a runner that filters by the bound
 * parameter fails the moment a branch stops binding one.
 *
 * The second is that this file is where the product judgement lives — what is
 * searchable, what a hit's destination is, and what the user is told about the
 * parts that could not be searched — and none of that should need a database to
 * read or to change.
 *
 * src/lib/search/index.ts binds the real dependencies. Nothing else should.
 */

import type { Prisma } from "@prisma/client";
import {
  buildSnippet,
  groupHits,
  matchesAllTerms,
  markTerms,
  parseSearchQuery,
  TYPE_WEIGHT,
} from "@/lib/search/query";
import {
  artifactSearchSql,
  conversationSearchSql,
  fileSearchSql,
  knowledgeReadinessSql,
  knowledgeSearchSql,
  memorySearchSql,
  messageScanConversationsSql,
  messageScanSql,
  projectSearchSql,
  workEventSearchSql,
  workSessionSearchSql,
  type ArtifactRow,
  type ConversationRow,
  type FileRow,
  type KnowledgeRow,
  type MemoryRow,
  type MessageScanRow,
  type ProjectRow,
  type SearchSqlOptions,
  type WorkEventRow,
  type WorkSessionRow,
} from "@/lib/search/sql";
import {
  SEARCH_TYPES,
  windowSince,
  type SearchCoverage,
  type SearchHit,
  type SearchType,
  type SearchWindow,
  type UnifiedSearchResult,
} from "@/lib/search/types";

/**
 * What `decryptMessageTextSafe` returns for a body it cannot read. Duplicated
 * here rather than imported so this module stays free of node:crypto; the test
 * suite pins the two together.
 */
export const UNDECRYPTABLE_PLACEHOLDER = "[message could not be decrypted]";

/** Runs one statement and returns its rows. */
export interface SearchExecutor {
  run<T>(statement: Prisma.Sql): Promise<T[]>;
}

export interface SearchDeps {
  executor: SearchExecutor;
  /**
   * Decrypts a stored message body. Injected rather than imported so this
   * module carries no dependency on the keyring or on node:crypto — and so a
   * deployment with no key configured degrades through one obvious seam.
   */
  decryptMessage: (stored: string) => string;
  now?: Date;
}

export interface SearchRequest {
  userId: string;
  query: string;
  /** Which groups to search. Omitted means all of them. */
  types?: readonly SearchType[];
  projectId?: string | null;
  window?: SearchWindow;
  /** Hits per group, before grouping. Clamped. */
  limitPerType?: number;
}

const DEFAULT_LIMIT_PER_TYPE = 6;
const MAX_LIMIT_PER_TYPE = 25;

/**
 * The message scan window.
 *
 * Fifty conversations, fifteen hundred messages. Both numbers are a guess at
 * "the part of your history you were actually thinking of" rather than a
 * measured optimum, and both are visible in what the user is told, so the guess
 * is falsifiable rather than hidden. What matters is that they are bounded at
 * all: decrypting is the only way to search message text, and an unbounded
 * decrypt is a search box that gets slower every week the account is used.
 */
const MESSAGE_CONVERSATION_SCAN = 50;
const MESSAGE_ROW_SCAN = 1500;

/** Longest title synthesised from a body that has no title of its own. */
const SYNTHETIC_TITLE_CHARS = 80;

function complete(type: SearchType): SearchCoverage {
  return { type, state: "complete", detail: null };
}

function partial(type: SearchType, detail: string): SearchCoverage {
  return { type, state: "partial", detail };
}

function unavailable(type: SearchType, detail: string): SearchCoverage {
  return { type, state: "unavailable", detail };
}

/** "Showing the top 6 …" — said whenever a branch came back exactly full. */
function truncated(type: SearchType, count: number, limit: number): SearchCoverage {
  return count >= limit
    ? partial(type, `Showing the top ${limit} matches. Add another word to narrow the search.`)
    : complete(type);
}

/**
 * A one-line title for content that has none — a memory entry, a run event.
 *
 * Cut at a word boundary where one is near the limit: a title that ends
 * mid-word reads as corrupted data rather than as an excerpt.
 */
function syntheticTitle(text: string, max = SYNTHETIC_TITLE_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Turn per-source `ts_rank` values into one comparable scale.
 *
 * `ts_rank` is not comparable across sources and never was: it is normalised by
 * document length, so a match in a four-word chat title and a match in a
 * 4,000-word artifact produce numbers that mean different things. Rather than
 * pretend otherwise, each source's ranks are scaled to its own best hit and
 * then multiplied by the type weight. Within a group the engine's order is
 * exactly Postgres's; between groups the order is a stated editorial choice
 * (TYPE_WEIGHT) instead of an accident of column length.
 */
function scaled(ranks: readonly number[], weight: number): number[] {
  const max = Math.max(0, ...ranks);
  if (max <= 0) return ranks.map(() => weight * 0.5);
  return ranks.map((r) => weight * (r / max));
}

function href(parts: string, params: Record<string, string | number | undefined> = {}): string {
  const search = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return search ? `${parts}?${search}` : parts;
}

/** "Page 4", "Sheet2!B7", "src/app.ts:120" — where in the document this block is. */
function knowledgeLocator(row: KnowledgeRow): string | null {
  if (row.page != null) return `Page ${row.page}`;
  if (row.slide != null) return `Slide ${row.slide}`;
  if (row.sheet) return row.cellRange ? `${row.sheet}!${row.cellRange}` : row.sheet;
  if (row.path) return row.lineStart != null ? `${row.path}:${row.lineStart}` : row.path;
  return null;
}

/**
 * Where a knowledge block lives, in descending order of how specific we can be.
 *
 * There is no standalone knowledge browser in the product yet, so the honest
 * destination is the place the document is already reachable from: its project,
 * the chat it was uploaded to, or — failing both — the file itself. The block
 * id travels along either way, so the moment a viewer exists it lands on the
 * right paragraph without this having to change.
 */
function knowledgeHref(row: KnowledgeRow): string {
  if (row.projectId) return href(`/projects/${row.projectId}`, { doc: row.documentId, block: row.id });
  if (row.attachmentConversationId) {
    return href(`/chat/${row.attachmentConversationId}`, { doc: row.documentId, block: row.id });
  }
  if (row.storageKey) return `/api/files/${row.storageKey}`;
  return "/projects";
}

/**
 * Where an attachment lives: the project or chat it belongs to, and inside that
 * chat, the exact message it was attached to. The raw object is the last
 * resort — a palette that navigates someone into a file download when it could
 * have shown them the conversation has answered a different question.
 */
function fileHref(row: FileRow): string {
  if (row.projectId) return href(`/projects/${row.projectId}`, { file: row.id });
  if (row.conversationId) return href(`/chat/${row.conversationId}`, { m: row.messageId ?? undefined });
  return `/api/files/${row.storageKey}`;
}

/**
 * One source's work: run it, map it, and say what it covered. A source that
 * throws is reported as unavailable rather than taken down with the whole
 * search — a missing Work table on a stale deployment should cost the Work
 * group, not the chats someone was actually looking for.
 */
async function attempt(
  type: SearchType,
  work: () => Promise<{ hits: SearchHit[]; coverage: SearchCoverage }>
): Promise<{ hits: SearchHit[]; coverage: SearchCoverage }> {
  try {
    return await work();
  } catch (err) {
    // The query text can carry the user's own words; the error message is
    // logged, the query is not.
    console.error("[search] source failed", { type, message: err instanceof Error ? err.message : String(err) });
    return {
      hits: [],
      coverage: unavailable(type, "This part of your account could not be searched just now."),
    };
  }
}

export async function runUnifiedSearch(
  request: SearchRequest,
  deps: SearchDeps
): Promise<UnifiedSearchResult> {
  const parsed = parseSearchQuery(request.query);
  // No searchable token — "/" or "…" on its own. Not an error and not an empty
  // account: the caller shows recents for this, exactly as it does for "".
  if (!parsed) {
    return { query: request.query.trim(), groups: [], total: 0, coverage: [], partial: false };
  }

  const { executor, decryptMessage } = deps;
  const now = deps.now ?? new Date();
  const limit = Math.min(Math.max(1, Math.floor(request.limitPerType ?? DEFAULT_LIMIT_PER_TYPE)), MAX_LIMIT_PER_TYPE);
  const wanted = new Set<SearchType>(request.types?.length ? request.types : SEARCH_TYPES);
  const since = windowSince(request.window ?? "any", now);
  const projectId = request.projectId ?? null;

  const base: SearchSqlOptions = {
    userId: request.userId,
    tsquery: parsed.tsquery,
    firstTerm: parsed.terms[0],
    limit,
    since,
    projectId,
  };
  const terms = parsed.terms;

  const tasks: Array<Promise<{ hits: SearchHit[]; coverage: SearchCoverage }>> = [];

  if (wanted.has("conversation")) {
    tasks.push(
      attempt("conversation", async () => {
        const rows = await executor.run<ConversationRow>(conversationSearchSql(base));
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.conversation);
        return {
          coverage: truncated("conversation", rows.length, limit),
          hits: rows.map((row, i) => ({
            id: `conversation:${row.id}`,
            type: "conversation" as const,
            title: row.title || "New chat",
            // A conversation matched on its title; the title is already shown
            // in full with its marks, so a snippet would repeat it.
            snippet: null,
            href: `/chat/${row.id}`,
            locator: null,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("project")) {
    tasks.push(
      attempt("project", async () => {
        const rows = await executor.run<ProjectRow>(projectSearchSql(base));
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.project);
        return {
          coverage: truncated("project", rows.length, limit),
          hits: rows.map((row, i) => ({
            id: `project:${row.id}`,
            type: "project" as const,
            title: row.name || "Untitled project",
            snippet: buildSnippet(row.snippetSource ?? "", terms),
            href: `/projects/${row.id}`,
            locator: null,
            projectId: row.id,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("file")) {
    tasks.push(
      attempt("file", async () => {
        const rows = await executor.run<FileRow>(fileSearchSql(base));
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.file);
        return {
          coverage: truncated("file", rows.length, limit),
          hits: rows.map((row, i) => ({
            id: `file:${row.id}`,
            type: "file" as const,
            title: row.fileName,
            snippet: buildSnippet(row.snippetSource ?? "", terms),
            href: fileHref(row),
            locator: null,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("knowledge")) {
    tasks.push(
      attempt("knowledge", async () => {
        const [rows, readiness] = await Promise.all([
          executor.run<KnowledgeRow>(knowledgeSearchSql(base)),
          executor.run<{ pending: number; impaired: number }>(knowledgeReadinessSql(request.userId)),
        ]);
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.knowledge);
        const pending = readiness[0]?.pending ?? 0;
        const impaired = readiness[0]?.impaired ?? 0;

        // The index being incomplete is the single most misleading thing that
        // can happen to this source, so it outranks "showing the top N" when
        // both are true: a person told their results were merely trimmed will
        // rephrase the query, which cannot possibly help.
        let coverage = truncated("knowledge", rows.length, limit);
        if (pending > 0 || impaired > 0) {
          const parts: string[] = [];
          if (pending > 0) parts.push(`${pending} ${pending === 1 ? "document is" : "documents are"} still being indexed`);
          if (impaired > 0) parts.push(`${impaired} could not be fully read`);
          coverage = partial("knowledge", `${parts.join(", and ")}. Those are not searchable yet.`);
        }

        return {
          coverage,
          hits: rows.map((row, i) => ({
            id: `knowledge:${row.id}`,
            type: "knowledge" as const,
            title: row.fileName,
            snippet: buildSnippet(row.text ?? "", terms),
            href: knowledgeHref(row),
            locator: knowledgeLocator(row),
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("artifact")) {
    tasks.push(
      attempt("artifact", async () => {
        const rows = await executor.run<ArtifactRow>(artifactSearchSql(base));
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.artifact);
        return {
          coverage: truncated("artifact", rows.length, limit),
          hits: rows.map((row, i) => ({
            id: `artifact:${row.id}:${row.version}`,
            type: "artifact" as const,
            title: row.title || "Untitled artifact",
            snippet: buildSnippet(row.snippetSource ?? "", terms),
            // ?artifact= is the deep link the library already uses; ?v= names
            // the version that matched, which may not be the current one.
            href: href(`/chat/${row.conversationId}`, { artifact: row.identifier, v: row.version }),
            locator: `v${row.version}`,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("memory")) {
    tasks.push(
      attempt("memory", async () => {
        const rows = await executor.run<MemoryRow>(memorySearchSql(base));
        const scores = scaled(rows.map((r) => r.rank), TYPE_WEIGHT.memory);
        return {
          coverage: truncated("memory", rows.length, limit),
          hits: rows.map((row, i) => ({
            id: `memory:${row.id}`,
            type: "memory" as const,
            title: syntheticTitle(row.snippetSource ?? ""),
            snippet: buildSnippet(row.snippetSource ?? "", terms),
            href: href("/memory", { entry: row.id }),
            // A superseded belief is still findable, but it says so — an old
            // fact presented as current is worse than not finding it.
            locator: row.status !== "active" ? row.status : row.category,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: scores[i],
          })),
        };
      })
    );
  }

  if (wanted.has("work")) {
    tasks.push(
      attempt("work", async () => {
        const [sessions, events] = await Promise.all([
          executor.run<WorkSessionRow>(workSessionSearchSql(base)),
          executor.run<WorkEventRow>(workEventSearchSql(base)),
        ]);
        const sessionScores = scaled(sessions.map((r) => r.rank), TYPE_WEIGHT.work);
        // Events sit slightly below sessions of equal relevance: "the task
        // about X" is nearly always what someone means, and a step inside it is
        // the follow-up question.
        const eventScores = scaled(events.map((r) => r.rank), TYPE_WEIGHT.work * 0.9);

        const hits: SearchHit[] = [
          ...sessions.map((row, i) => ({
            id: `work:${row.id}`,
            type: "work" as const,
            title: row.title || "Untitled task",
            snippet: buildSnippet(row.goal ?? "", terms),
            href: `/work/${row.id}`,
            locator: row.status,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: sessionScores[i],
          })),
          ...events.map((row, i) => ({
            id: `work-event:${row.id}`,
            type: "work" as const,
            title: row.sessionTitle || "Untitled task",
            snippet: buildSnippet(row.snippetSource ?? "", terms),
            href: href(`/work/${row.sessionId}`, { run: row.runId, event: row.seq }),
            locator: `Step ${row.seq}`,
            projectId: row.projectId,
            updatedAt: row.updatedAt.toISOString(),
            score: eventScores[i],
          })),
        ];

        return {
          coverage:
            sessions.length >= limit || events.length >= limit
              ? partial("work", `Showing the top ${limit} matches. Add another word to narrow the search.`)
              : complete("work"),
          hits,
        };
      })
    );
  }

  if (wanted.has("message")) {
    tasks.push(
      attempt("message", async () => {
        const conversations = await executor.run<{ id: string; title: string; projectId: string | null }>(
          messageScanConversationsSql({
            userId: request.userId,
            since,
            projectId,
            limit: MESSAGE_CONVERSATION_SCAN,
          })
        );
        if (conversations.length === 0) return { hits: [], coverage: complete("message") };

        const rows = await executor.run<MessageScanRow>(
          messageScanSql({
            userId: request.userId,
            conversationIds: conversations.map((c) => c.id),
            since,
            limit: MESSAGE_ROW_SCAN,
          })
        );

        const hits: SearchHit[] = [];
        const marksPerHit: number[] = [];
        let undecryptable = 0;
        for (const row of rows) {
          const content = decryptMessage(row.content);
          // decryptMessageTextSafe substitutes a placeholder rather than
          // throwing, so a wrong or missing key looks like a corpus of
          // identical strings. Counted, because that is the difference between
          // "nothing matched" and "Juno cannot read your messages".
          if (content === UNDECRYPTABLE_PLACEHOLDER) {
            undecryptable += 1;
            continue;
          }
          if (!matchesAllTerms(content, terms)) continue;
          const snippet = buildSnippet(content, terms);
          if (!snippet) continue;
          hits.push({
            id: `message:${row.id}`,
            type: "message",
            title: row.conversationTitle || "New chat",
            snippet,
            href: href(`/chat/${row.conversationId}`, { m: row.id }),
            locator: row.role === "USER" ? "You" : "Juno",
            projectId: row.projectId,
            updatedAt: row.createdAt.toISOString(),
            score: 0,
          });
          marksPerHit.push(markTerms(content, terms).length);
          if (hits.length >= limit) break;
        }

        // No ts_rank to lean on here, so relevance is the count of matched
        // spans in the body — the same signal ts_rank leads with, computed on
        // plaintext that only ever existed in memory.
        const scores = scaled(marksPerHit, TYPE_WEIGHT.message);
        hits.forEach((hit, i) => {
          hit.score = scores[i];
        });

        if (undecryptable > 0 && hits.length === 0) {
          return {
            hits: [],
            coverage: unavailable(
              "message",
              "Message text could not be read with the current encryption key, so messages were not searched."
            ),
          };
        }

        const scanCapped = rows.length >= MESSAGE_ROW_SCAN || conversations.length >= MESSAGE_CONVERSATION_SCAN;
        return {
          hits,
          coverage: scanCapped
            ? partial(
                "message",
                `Message text is encrypted at rest, so Juno searched your ${MESSAGE_CONVERSATION_SCAN} most recent chats rather than all of them. Open a chat and press ⌘F to search it in full.`
              )
            : complete("message"),
        };
      })
    );
  }

  const settled = await Promise.all(tasks);
  const hits = settled.flatMap((r) => r.hits);
  const coverage = settled.map((r) => r.coverage);

  return {
    query: parsed.raw,
    groups: groupHits(hits),
    total: hits.length,
    coverage,
    partial: coverage.some((c) => c.state !== "complete"),
  };
}
