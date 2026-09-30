import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { searchMentions } from "@/lib/mentions/search";
import {
  DEFAULT_MENTION_LIMIT,
  MAX_MENTION_LIMIT,
  MAX_MENTION_QUERY_CHARS,
  parseMentionIds,
  parseMentionKinds,
} from "@/lib/mentions/types";

export const runtime = "nodejs";

/**
 * GET /api/mentions — the "@" palette of every composer.
 *
 *   q          what has been typed after "@" (optional; empty lists the most
 *              recent few of each kind)
 *   kinds      comma list of crew, file, project, app, skill, chat, artifact
 *              (optional; unknown names are dropped, none means all)
 *   limit      rows per kind, 1–10 (default 6)
 *   ids        comma list of `kind:id` for exact lookups instead of a query,
 *              so a client can refresh tokens it already holds — a restored
 *              draft, an app that was just connected
 *   conversationId  the chat being written in, left out of the chat rows
 *
 * Owner-scoped to the signed-in account, ranked (src/lib/mentions/rank.ts),
 * and rate-limited per account: the palette asks on every keystroke, so the
 * bound is generous for typing and tight for a script. An app row says
 * whether it needs connecting and what using it will ask first
 * (`approval.summary`: "Sending, posting or changing anything in Slack will
 * ask you first."), from the same policy the approval broker enforces.
 *
 * GET for the reasons /api/search gives: it is a read, and the browser can
 * cancel and re-issue it as the person types. The query is never logged.
 */

const MENTION_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

const schema = z.object({
  q: z.string().max(MAX_MENTION_QUERY_CHARS).optional(),
  kinds: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_MENTION_LIMIT).optional(),
  ids: z.string().max(2_000).optional(),
  conversationId: z.string().max(60).optional(),
});

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const parsed = schema.safeParse({
    q: params.get("q") ?? undefined,
    kinds: params.get("kinds") ?? undefined,
    limit: params.get("limit") ?? undefined,
    ids: params.get("ids") ?? undefined,
    conversationId: params.get("conversationId") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const limited = await rateLimit({ key: `mentions:${user.id}`, ...MENTION_RATE_LIMIT });
  if (!limited.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many lookups. Try again in a moment." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil((limited.resetAt.getTime() - Date.now()) / 1000))) },
      }
    );
  }

  try {
    const result = await searchMentions({
      userId: user.id,
      query: parsed.data.q ?? "",
      kinds: parseMentionKinds(parsed.data.kinds),
      limitPerKind: parsed.data.limit ?? DEFAULT_MENTION_LIMIT,
      ids: parseMentionIds(parsed.data.ids),
      excludeConversationId: parsed.data.conversationId ?? null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    // The query is user content: log the failure, never the words.
    console.error("[mentions] search failed", { message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
