import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { loadAllowedSensitiveTopics } from "@/lib/memory";
import {
  MEMORY_IMPORT_MAX_CHARS,
  parseImportedMemories,
  reviewImportCandidates,
} from "@/lib/memory-import";
import type { LifecycleEntry } from "@/lib/memory-lifecycle";

export const runtime = "nodejs";

/*
 * Parse a pasted memory list into reviewable candidates. WRITES NOTHING.
 *
 * Deterministic, and deliberately so — see src/lib/memory-import.ts. The text
 * is another assistant's output and is treated as data from end to end: it is
 * never put in front of a model, so nothing written inside it can act as an
 * instruction. The review the user does next is the only judgement applied.
 *
 * Server-side rather than in the browser because "already remembered" and
 * "you asked Juno to forget this" need the account's rows, and shipping every
 * fact and suppression to the client to compute two badges would be a worse
 * trade than one round-trip.
 */

const bodySchema = z.object({ text: z.string().min(1).max(MEMORY_IMPORT_MAX_CHARS * 2) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Paste the list first." }, { status: 400 });

  const facts = parseImportedMemories(parsed.data.text);
  if (facts.length === 0) {
    return NextResponse.json(
      {
        error:
          "No facts found in that. Paste the list the other assistant wrote — one fact per line works best.",
      },
      { status: 422 }
    );
  }

  const [rows, allowedSensitiveTopics] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        content: true,
        normalized: true,
        category: true,
        projectId: true,
        source: true,
        kind: true,
        confidence: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    loadAllowedSensitiveTopics(user.id),
  ]);
  const entries: LifecycleEntry[] = rows.filter((row) => row.kind === "FACT");
  const suppressions = rows.filter((row) => row.kind === "SUPPRESSION").map((row) => row.content);

  return NextResponse.json({
    candidates: reviewImportCandidates(facts, { entries, suppressions, allowedSensitiveTopics }),
  });
}
