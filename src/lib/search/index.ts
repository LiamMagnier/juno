import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { runUnifiedSearch, type SearchRequest } from "@/lib/search/engine";
import type { UnifiedSearchResult } from "@/lib/search/types";

/**
 * Unified search across everything one account owns: conversation titles and
 * message text, projects, files, knowledge blocks, artifact versions, memory
 * entries, and Work sessions and their run events.
 *
 * This module is the only place the engine meets the database. It exists as a
 * separate file from engine.ts for the usual reason `server-only` modules split
 * in this codebase — the half with the judgement in it should be readable and
 * testable without a Postgres connection — and for one specific one: the engine
 * is what the cross-account isolation test drives, and a `server-only` import
 * makes a module unimportable from `tsx --test`.
 *
 * ## What this supersedes
 *
 * `listConversations({ q })` in src/lib/queries.ts already implemented a
 * server-side search: `title contains q`, reachable through
 * `GET /api/conversations?q=`. Nothing has ever called it with a `q`. Every
 * client in the repository fetches that route without the parameter and the
 * palette filters titles in the browser instead, over the at-most-200
 * conversations the app context happens to hold — which silently excludes
 * archived chats and everything past the 200th.
 *
 * It is superseded rather than wired up. The parameter stays (the route is a
 * documented API surface and the native clients may yet use it), but the
 * palette now searches through here, because the dead path could not be made
 * correct by calling it: `contains` is a substring match with no ranking, no
 * snippet, and no notion of a match anywhere other than a title. Extending it
 * to eight sources would have meant rewriting it into this. What is kept from
 * it is the decision recorded in its comment — that message bodies are
 * encrypted and SQL cannot see them — which is why the message branch here
 * decrypts a bounded window and says so rather than pretending SQL can.
 *
 * ## Raw SQL and the ownership guard
 *
 * Every statement runs through `$queryRaw`, which the ownership guard in
 * src/lib/db.ts does not intercept — it wraps model operations, not raw SQL.
 * The scoping is therefore entirely manual and lives in one file,
 * src/lib/search/sql.ts, where it can be read in one sitting and is asserted
 * statement by statement by tests/unified-search.test.ts.
 */
export async function searchEverything(
  request: SearchRequest
): Promise<UnifiedSearchResult> {
  return runUnifiedSearch(request, {
    executor: {
      // The generic parameter is the row shape each statement's select list
      // produces; `$queryRaw` cannot check that, which is why sql.ts keeps the
      // row interfaces immediately beside the statements that produce them.
      run: (statement) => prisma.$queryRaw(statement) as Promise<never[]>,
    },
    decryptMessage: decryptMessageTextSafe,
  });
}

export type { SearchRequest } from "@/lib/search/engine";
export type {
  SearchCoverage,
  SearchGroup,
  SearchHit,
  SearchType,
  SearchWindow,
  UnifiedSearchResult,
} from "@/lib/search/types";
