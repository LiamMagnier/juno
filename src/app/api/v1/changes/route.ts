import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { requireNativeRequest } from "@/lib/native-request";
import { prisma } from "@/lib/prisma";
import { changeEnvelope, parseChangeLimit, parseCursor } from "@/lib/sync-protocol";
import { NativeAuthError } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const url = new URL(request.url);
    let after: bigint;
    let limit: number;
    try {
      after = parseCursor(url.searchParams.get("after"));
      limit = parseChangeLimit(url.searchParams.get("limit"));
    } catch {
      throw new NativeAuthError("invalid_request", 400, "The change cursor or page limit is invalid.");
    }
    const rows = await prisma.accountChange.findMany({
      where: { accountId: current.user.id, cursor: { gt: after } },
      orderBy: { cursor: "asc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = page.at(-1)?.cursor ?? after;
    return apiV1Json({
      after: after.toString(),
      changes: page.map(changeEnvelope),
      nextCursor: nextCursor.toString(),
      compactionFloorCursor: "0",
      hasMore,
    });
  } catch (error) {
    return apiV1Error(error);
  }
}
