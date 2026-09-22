import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Where an attachment's indexing has got to, for the tiles in the composer.
 *
 * WHY THE COMPOSER NEEDS THIS AT ALL. Indexing is scheduled, not awaited: the
 * upload responds the moment the bytes are stored, so every attachment reaches
 * the client as `queued` and settles seconds later in a worker the client
 * never hears from. That was survivable while nothing was shown — and it is
 * exactly why a PDF Juno could not read looked identical to one it could, all
 * the way through writing a message, sending it, and waiting for a reply, with
 * the first and only word on the subject coming from the model.
 *
 * ONE ROUND TRIP FOR THE WHOLE ROW. A route per attachment would be five
 * requests for five files, repeated on every poll; the ids come in as one list
 * and go out as one map.
 *
 * Owner-scoped through the guarded `prisma` client, and an id belonging to
 * somebody else simply does not appear in the answer — no 403, which would
 * confirm the row exists. The reply carries no file name, no bytes and no
 * text: a state word, and nothing else the caller did not already send.
 */

/** Bounded so a crafted query cannot turn one request into a table scan. */
const MAX_IDS = 20;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ states: {} });

  const rows = await prisma.attachment.findMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    select: { id: true, parserState: true },
  });

  const states: Record<string, string> = {};
  for (const row of rows) states[row.id] = row.parserState;
  return NextResponse.json({ states });
}
