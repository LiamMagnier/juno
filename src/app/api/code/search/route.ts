import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { isWebSearchConfigured, webSearch } from "@/lib/web-search";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_RESULTS = 8;
const schema = z.object({
  query: z.string().trim().min(1).max(400),
  max_results: z.number().int().min(1).max(MAX_RESULTS).optional().default(5),
});

/**
 * The local Code agent's bounded web-search seam.
 *
 * The provider key never leaves the server and the Mac receives only title,
 * URL and snippet metadata. This is deliberately a separate route from the
 * chat stream: a tool call needs a small JSON response, not a second model
 * generation or a client-visible conversation message.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].webSearch) {
    return NextResponse.json(
      { error: "Web search is available on a paid Juno plan." },
      { status: 402 },
    );
  }
  if (!isWebSearchConfigured()) {
    return NextResponse.json(
      { error: "Web search is not configured on this Juno deployment." },
      { status: 503 },
    );
  }

  const limit = await rateLimit({
    key: `code-web-search:${user.id}`,
    limit: 30,
    windowSec: 60,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "Web search is being used too quickly. Try again in a moment." },
      { status: 429 },
    );
  }

  const sources = (await webSearch(parsed.data.query, parsed.data.max_results))
    .filter((source) => {
      try {
        const url = new URL(source.url);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    })
    .map((source) => ({
      title: source.title.slice(0, 400),
      url: source.url.slice(0, 2_000),
      snippet: source.snippet.slice(0, 1_000),
    }));

  return NextResponse.json(
    { query: parsed.data.query, sources },
    { headers: { "Cache-Control": "no-store" } },
  );
}
