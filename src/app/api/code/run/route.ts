import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { isExecConfigured } from "@/lib/exec/config";
import { executeRunCode } from "@/lib/exec/runtime";
import { SNIPPET_MAX_CHARS, serverSnippetLanguage, snippetProgram } from "@/lib/exec/snippets";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  language: z.string().min(1).max(20),
  code: z.string().min(1).max(SNIPPET_MAX_CHARS),
  conversationId: z.string().max(100).nullish(),
});

/** Whether this server runs the sandbox languages, so the web shows Run on them only when it can. */
export async function GET() {
  const { error } = await requireUser();
  if (error) return error;
  return NextResponse.json({ sandbox: isExecConfigured() });
}

/**
 * Run one code block from the chat (or a Live UI exercise) in the hosted
 * sandbox, for the languages the browser cannot run (src/lib/exec/snippets.ts).
 *
 * The same path as the model's run_code: paid plans only, never in lockdown,
 * metered by sandbox time, one fresh workspace per run, no network, and no
 * conversation files mounted (a snippet reads nothing it was not given).
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const language = serverSnippetLanguage(parsed.data.language);
  if (!language) return NextResponse.json({ error: "unsupported_language" }, { status: 400 });
  if (!isExecConfigured()) return NextResponse.json({ error: "unavailable", message: "Running this language needs the code sandbox, which this server does not have yet." }, { status: 503 });

  if ((await getUserPlan(user.id)) === "FREE") {
    return NextResponse.json({ error: "plan", message: "Running code on the server is part of the paid plans." }, { status: 402 });
  }
  const limit = await rateLimit({ key: `code-run:${user.id}`, limit: 30, windowSec: 60 });
  if (!limit.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const callId = randomUUID();
  const program = snippetProgram(language, parsed.data.code);
  const outcome = await executeRunCode(
    { language: program.language, code: program.code, timeout_seconds: 30, reason: "Run a code block" },
    {
      surface: "chat",
      userId: user.id,
      sessionId: `snippet-${callId}`,
      callId,
      conversationId: parsed.data.conversationId ?? null,
      projectId: null,
      inputs: async () => [],
      signal: req.signal,
    },
    { checkRunAvailable: false },
  );

  return NextResponse.json({
    status: outcome.status,
    output: outcome.body,
    exitCode: outcome.run?.exitCode ?? null,
    durationMs: outcome.run?.durationMs ?? null,
    error: outcome.error?.code ?? null,
  });
}
