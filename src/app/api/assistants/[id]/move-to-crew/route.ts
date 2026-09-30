import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { moveAssistantToCrew } from "@/lib/agents/move-from-assistant-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * "Move to crew" (DECISIONS D-007): the assistant becomes a crew member with
 * its name, prompt (as the brief), model, apps and starter prompts (as ideas).
 * The assistant is marked moved, stays readable by id, and leaves the list.
 * Moving the same assistant twice answers with the member it already became.
 */
export async function POST(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({ key: `assistants:move:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many moves this hour. Try again shortly." },
      { status: 429 }
    );
  }

  const result = await moveAssistantToCrew(user, id);
  return NextResponse.json(result.body, { status: result.status });
}
