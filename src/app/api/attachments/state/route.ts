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
 * IT REPORTS WHAT THE MODEL WILL GET, NOT WHAT THE INDEXER DID. `parserState`
 * alone cannot answer the only question the composer is really asking, and the
 * gap between the two is where the tile started lying. A `degraded` PDF can
 * mean "nine pages of ten were read" or it can mean "this is a scan and
 * nothing was read at all" — the same word for a file that is almost entirely
 * available and a file that is entirely absent. `hasText` settles it, because
 * `extractedText` is literally the column every provider adapter reads.
 *
 * Owner-scoped through the guarded `prisma` client, and an id belonging to
 * somebody else simply does not appear in the answer — no 403, which would
 * confirm the row exists. The reply still carries no file name, no bytes and
 * no text: a state word, a boolean, and nothing else the caller did not
 * already send.
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
    select: { id: true, parserState: true, mimeType: true, kind: true, extractedText: true },
  });

  const states: Record<string, string> = {};
  const readable: Record<string, boolean> = {};
  const visual: Record<string, boolean> = {};
  for (const row of rows) {
    states[row.id] = row.parserState;
    // `select` cannot ask Postgres for "is this column non-empty", so the text
    // does come back here — and is deliberately never put in the response.
    readable[row.id] = !!row.extractedText && row.extractedText.trim().length > 0;
    // A file whose pages can be drawn is readable by any model that can see,
    // whatever the text extractor made of it. That is the whole of the
    // difference between "we failed" and "we will read it as pictures".
    visual[row.id] = row.kind === "IMAGE" || row.mimeType.toLowerCase() === "application/pdf";
  }
  return NextResponse.json({ states, readable, visual });
}
