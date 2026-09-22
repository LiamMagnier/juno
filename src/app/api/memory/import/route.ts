import { NextResponse, after } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { consolidateWithFallback, saveCandidates } from "@/lib/memory";
import { MEMORY_IMPORT_MAX_FACTS, looksLikeSecret } from "@/lib/memory-import";
import { MEMORY_CONTENT_LIMIT } from "@/lib/memory-suppression";

export const runtime = "nodejs";
export const maxDuration = 60;

/*
 * Commit the facts the user ticked in the import review.
 *
 * MANUAL, because every one of these was read and chosen by the user: it gets
 * the confidence of a fact they typed, wins a conflict against something a
 * background model inferred, and — like anything typed by hand — is not
 * refused by the sensitive-subject gate, whose review default already made
 * the user tick each sensitive row deliberately. Everything else is the
 * ordinary write path: the block-list still refuses a forgotten statement, a
 * restated fact refreshes rather than duplicates, and a contradiction
 * supersedes with a reason rather than sitting beside the older belief.
 *
 * `sourceRef: "import"` is the provenance the memory page shows ("Imported
 * from another assistant"), so a fact that turns out wrong can be traced to
 * where it came from.
 */

const bodySchema = z.object({
  facts: z.array(z.string().trim().min(1).max(MEMORY_CONTENT_LIMIT)).min(1).max(MEMORY_IMPORT_MAX_FACTS),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Nothing to import." }, { status: 400 });

  // Secrets cannot be ticked in the review, and are dropped again here so a
  // request that skipped the review cannot store one either.
  const facts = parsed.data.facts.filter((fact) => !looksLikeSecret(fact));
  if (facts.length === 0) return NextResponse.json({ error: "Nothing to import." }, { status: 400 });

  const result = await saveCandidates(user.id, facts, "import", { source: "MANUAL" });

  // The summary should reflect a whole new profile's worth of facts before the
  // next chat, not whenever a chat happens to trigger it. After the response,
  // so a large import does not wait on an LLM call to say it worked.
  if (result.created > 0 || result.superseded > 0) {
    after(() => consolidateWithFallback(user.id).then(() => undefined, () => undefined));
  }

  return NextResponse.json({
    created: result.created,
    refreshed: result.refreshed,
    superseded: result.superseded,
    rejected: result.rejected,
  });
}
