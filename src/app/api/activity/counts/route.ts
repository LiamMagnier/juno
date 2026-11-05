import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { createActivityCountsHandler } from "@/lib/activity/handler";
import type { ActivityDb } from "@/lib/activity/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/activity/counts` — the four Activity counts without the rows, for
 * the sidebar's Needs you badge and the native badges. Three group-bys.
 */
export const GET = createActivityCountsHandler({
  authenticate: requireUser,
  db: prisma as unknown as ActivityDb,
});
