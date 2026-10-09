import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { SNIPPET_MAX_CHARS } from "@/lib/exec/snippets";
import { rateLimit } from "@/lib/rate-limit";
import { codeBlockConsoleDoc } from "@/lib/sandbox/console-doc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  language: z.string().min(1).max(20),
  code: z.string().min(1).max(SNIPPET_MAX_CHARS),
  theme: z.enum(["light", "dark"]).default("light"),
});

/**
 * The console document a chat code block runs in, for the native apps' Run
 * (owner, 2026-10-09: "On IOS & MacOS add ... the ability to run code like we
 * did on the website").
 *
 * The same document the web's frame shows under a block — JavaScript,
 * TypeScript, Python on Pyodide, SQL on SQLite against the HR sample — built
 * by src/lib/sandbox/console-doc.ts and returned as a string. Nothing runs
 * here: the app loads it in a non-persistent WKWebView with no bridge but the
 * size and status messages, so the code runs on the reader's device, as it
 * does in the reader's browser on the web. Languages that need the hosted
 * sandbox (C, Java, …) are refused; they go through /api/code/run.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const limit = await rateLimit({ key: `code-console:${user.id}`, limit: 60, windowSec: 60 });
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const doc = codeBlockConsoleDoc(parsed.data.language, parsed.data.code, parsed.data.theme);
  if (!doc) return NextResponse.json({ error: "unsupported_language" }, { status: 400 });
  return NextResponse.json(doc, { headers: { "Cache-Control": "no-store" } });
}
