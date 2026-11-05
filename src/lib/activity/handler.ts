import { NextResponse } from "next/server";
import { decodeCursor, parseLimit } from "@/lib/activity/model";
import { readActivityCounts, readActivityPage, type ActivityDb } from "@/lib/activity/store";

/*
 * The two Activity routes as factories, so the tests drive the real handlers
 * with a stand-in session and database. `src/app/api/activity/**` only binds
 * them to `requireUser` (a browser session or a native bearer) and the
 * ownership-guarded Prisma client.
 */

export interface ActivityDeps {
  authenticate: () => Promise<{ user: { id: string } | null }>;
  db: ActivityDb;
  now?: () => Date;
}

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
}

/** `GET /api/activity?limit=&cursor=`: one page of live items plus the account's counts. */
export function createActivityListHandler(deps: ActivityDeps) {
  return async function GET(req: Request): Promise<Response> {
    const { user } = await deps.authenticate();
    if (!user) return unauthorized();

    const params = new URL(req.url).searchParams;
    const limit = parseLimit(params.get("limit"));
    if (limit === null) {
      return NextResponse.json({ error: "Invalid input", parameter: "limit" }, { status: 400, headers: NO_STORE });
    }
    const rawCursor = params.get("cursor");
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && cursor === null) {
      return NextResponse.json({ error: "Invalid input", parameter: "cursor" }, { status: 400, headers: NO_STORE });
    }

    const page = await readActivityPage(deps.db, { userId: user.id, limit, cursor, now: deps.now?.() ?? new Date() });
    return NextResponse.json(page, { headers: NO_STORE });
  };
}

/** `GET /api/activity/counts`: the four numbers alone, for a badge. Three group-bys. */
export function createActivityCountsHandler(deps: ActivityDeps) {
  return async function GET(): Promise<Response> {
    const { user } = await deps.authenticate();
    if (!user) return unauthorized();
    const counts = await readActivityCounts(deps.db, user.id, deps.now?.() ?? new Date());
    return NextResponse.json({ counts }, { headers: NO_STORE });
  };
}
