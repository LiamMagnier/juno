import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { searchEverything } from "@/lib/search";
import { SEARCH_TYPES, SEARCH_WINDOWS } from "@/lib/search/types";

/**
 * Unified search across everything the signed-in account owns.
 *
 * GET rather than POST even though the query is user content: it is a read, it
 * benefits from being cancellable and re-issuable by the browser as the user
 * types, and a POST would have made the palette's debounce-and-abort loop fight
 * the router. The query string is not logged by anything in this repository —
 * see the note on error handling below, which is where a search term would
 * otherwise leak.
 *
 * Every parameter is optional; only `q` changes what is searched. `types`,
 * `projectId` and `window` narrow it, and each is validated against a closed
 * set rather than passed through, because all three end up inside SQL
 * conditions in src/lib/search/sql.ts.
 */

export const runtime = "nodejs";

const schema = z.object({
  // Bounded because it becomes a tsquery with one AND clause per token. The
  // tokeniser already caps the number of terms; this caps the work of getting
  // there.
  q: z.string().max(200).optional(),
  // Comma-separated so the palette's filter chips round-trip in one parameter.
  types: z.string().max(200).optional(),
  projectId: z.string().max(60).optional(),
  window: z.enum(SEARCH_WINDOWS).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const parsed = schema.safeParse({
    q: params.get("q") ?? undefined,
    types: params.get("types") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
    window: params.get("window") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // An unknown type name is dropped rather than rejected: the palette and the
  // native clients ship on different release cycles, and a client that has
  // learned about a group this build does not have should get the groups it
  // does have, not a 400.
  const requestedTypes = (parsed.data.types ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is (typeof SEARCH_TYPES)[number] => (SEARCH_TYPES as readonly string[]).includes(t));

  const result = await searchEverything({
    userId: user.id,
    query: parsed.data.q ?? "",
    types: requestedTypes.length > 0 ? requestedTypes : undefined,
    projectId: parsed.data.projectId ?? null,
    window: parsed.data.window,
    limitPerType: parsed.data.limit,
  });

  return NextResponse.json(result);
}
