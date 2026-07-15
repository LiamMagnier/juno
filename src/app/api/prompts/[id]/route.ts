import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

const promptSelect = {
  id: true,
  title: true,
  body: true,
  useCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    body: z.string().trim().min(1).max(10_000).optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined, { message: "Nothing to update" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.savedPrompt.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const prompt = await prisma.savedPrompt.update({
    where: { id, userId: user.id },
    data: parsed.data,
    select: promptSelect,
  });
  return NextResponse.json({
    prompt: { ...prompt, createdAt: prompt.createdAt.toISOString(), updatedAt: prompt.updatedAt.toISOString() },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { count } = await prisma.savedPrompt.deleteMany({ where: { id, userId: user.id } });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/**
 * Records an insertion. The client fires this without awaiting, so a failure here
 * must never be user-visible — it only costs an imprecise counter.
 *
 * The bump also refreshes @updatedAt, which is what the list orders by: a prompt
 * you just used floats to the top. That is deliberate.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `prompts:use:${user.id}`, limit: 240, windowSec: 3600 });
    if (!limit.success) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const { count } = await prisma.savedPrompt.updateMany({
    where: { id, userId: user.id },
    data: { useCount: { increment: 1 } },
  });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
