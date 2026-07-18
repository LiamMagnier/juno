import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

/** Per-user ceiling. The dialog loads the whole library in one request, so it has to stay bounded. */
const MAX_PROMPTS = 200;

const promptSelect = {
  id: true,
  title: true,
  body: true,
  useCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PromptRow = {
  id: string;
  title: string;
  body: string;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
};

function serializePrompt(p: PromptRow) {
  return { ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The whole library ships in one response — MAX_PROMPTS keeps that honest, and
  // the client searches locally rather than round-tripping per keystroke.
  const prompts = await prisma.savedPrompt.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: promptSelect,
    take: MAX_PROMPTS,
  });

  return NextResponse.json({ prompts: prompts.map(serializePrompt) });
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(80),
  // No app-side body cap — long system / mentor prompts are a normal use case.
  body: z.string().trim().min(1),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `prompts:create:${user.id}`, limit: 40, windowSec: 3600 });
    if (!limit.success) {
      return NextResponse.json({ error: "You're saving prompts very fast — try again later." }, { status: 429 });
    }
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  // Soft cap: two concurrent creates could both pass this check, which is
  // acceptable — the limit exists to bound the payload, not to be exact.
  const count = await prisma.savedPrompt.count({ where: { userId: user.id } });
  if (count >= MAX_PROMPTS) {
    return NextResponse.json(
      { error: `You've saved the maximum of ${MAX_PROMPTS} prompts. Delete one to make room.` },
      { status: 409 }
    );
  }

  const prompt = await prisma.savedPrompt.create({
    data: { userId: user.id, title: parsed.data.title, body: parsed.data.body },
    select: promptSelect,
  });
  return NextResponse.json({ prompt: serializePrompt(prompt) }, { status: 201 });
}
