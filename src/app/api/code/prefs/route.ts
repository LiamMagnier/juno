import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { mergeCodePrefs, parseCodePrefsPatch, sanitizeCodePrefs } from "@/lib/code-v2/code-prefs";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The account's Code defaults (src/lib/code-v2/code-prefs.ts): what a new
 * session starts with. Settings reads and writes them without a session open;
 * the Code workspace reads them as the last fallback after the thread's own
 * choice and its project's last.
 */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  const row = await prisma.settings.findUnique({ where: { userId: user.id }, select: { codePrefs: true } });
  return NextResponse.json({ prefs: sanitizeCodePrefs(row?.codePrefs ?? null) }, { headers: NO_STORE });
}

/** Merge a patch (`null` clears a key) and answer with what is now stored. */
export async function PATCH(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const parsed = parseCodePrefsPatch(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const prefs = await prisma.$transaction(async (tx) => {
    const row = await tx.settings.findUnique({ where: { userId: user.id }, select: { codePrefs: true } });
    const next = mergeCodePrefs(sanitizeCodePrefs(row?.codePrefs ?? null), parsed.patch);
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.settings.upsert({ where: { userId: user.id }, create: { userId: user.id, codePrefs: value }, update: { codePrefs: value } });
    return next;
  });
  return NextResponse.json({ prefs }, { headers: NO_STORE });
}
