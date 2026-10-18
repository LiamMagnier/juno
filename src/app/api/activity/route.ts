import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { createActivityListHandler } from "@/lib/activity/handler";
import type { ActivityDb } from "@/lib/activity/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/activity` — the reader's live Work tasks, Code tasks and Research
 * runs in one keyset-paged list, with the account's Needs you / Running /
 * Ready / Blocked counts (audit gap G70). The web Activity page, the Mac
 * sidebar destination and the iPhone drawer entry all read this one route.
 *
 * The cast narrows the guarded client to the slice `src/lib/activity/store.ts`
 * calls; every query there carries `userId`, so the guard still checks them.
 */
export const GET = createActivityListHandler({
  authenticate: requireUser,
  db: prisma as unknown as ActivityDb,
});
