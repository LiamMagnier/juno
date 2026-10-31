import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import {
  COMPLETE_DEFAULT_MAX_TOKENS,
  COMPLETE_MAX_PROMPT_CHARS,
  COMPLETE_MAX_SYSTEM_CHARS,
  COMPLETE_MAX_TOKENS,
  isRuntimeTarget,
  type AlevrRuntimeTarget,
  type CompletionStreamEvent,
} from "@/lib/artifact-ai/protocol";
import { resolveRuntimeAccess } from "@/lib/artifact-ai/access";
import { admitArtifactCompletion, streamArtifactCompletion } from "@/lib/artifact-ai/complete";
import { artifactCompletionDeps, runtimeAccessDeps } from "@/lib/artifact-ai/server";
import { artifactCompletionLimited } from "@/lib/artifact-ai/rate-limits";
import { quickScreen } from "@/lib/moderation-ai";
import { recordFlag } from "@/lib/moderation";
import { moderationMessagePreview } from "@/lib/chat-moderation";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
// The reply is capped at COMPLETE_MAX_TOKENS on a background-tier model; the
// deadline below ends it well inside this.
export const maxDuration = 120;

/*
 * POST /api/artifact-runtime/complete — `window.alevr.complete` from an
 * artifact's code (src/lib/artifact-ai/protocol.ts).
 *
 * Called by the page that frames the artifact (bridge-host.ts), never by the
 * frame itself, which has no session. Signed-in only: the viewer is the
 * account that pays, and an anonymous visitor has no account to bill. The
 * order is the chat route's: who (session), what (body), which artifact and
 * whether this viewer may use it (access.ts), how often (rate-limits.ts),
 * whether it may be asked at all (the moderation pre-screen), how much
 * (admission and the hold, complete.ts) — and only then a provider.
 *
 * The answer is NDJSON (`CompletionStreamEvent` per line) once a model is
 * reached; every refusal before that is an ordinary JSON error with a `code`.
 * No prompt or reply text is logged.
 */

/** A prompt at its cap, a system prompt at its cap, and room for the envelope. */
const MAX_BODY_CHARS = COMPLETE_MAX_PROMPT_CHARS + COMPLETE_MAX_SYSTEM_CHARS + 4_096;
const DEADLINE_MS = 110_000;

const bodySchema = z.object({
  target: z.custom<AlevrRuntimeTarget>(isRuntimeTarget, "Unknown artifact."),
  prompt: z
    .string()
    .max(COMPLETE_MAX_PROMPT_CHARS)
    .refine((s) => s.trim().length > 0, "The prompt is empty."),
  system: z.string().max(COMPLETE_MAX_SYSTEM_CHARS).nullish(),
  maxTokens: z.number().int().min(1).max(COMPLETE_MAX_TOKENS).default(COMPLETE_DEFAULT_MAX_TOKENS),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to use this app's AI. It runs on your own account.", code: "sign_in_required" }, { status: 401 });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS * 4) return NextResponse.json({ error: "The request is too large.", code: "too_large" }, { status: 413 });
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: "The request is too large.", code: "too_large" }, { status: 413 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request.", code: "invalid_request" }, { status: 400 });
  }

  const access = await resolveRuntimeAccess(user.id, parsed.data.target, runtimeAccessDeps);
  if (!access.ok) return NextResponse.json({ error: access.error, code: access.code }, { status: access.status });

  const limited = await artifactCompletionLimited(user, access);
  if (limited) return limited;

  // The synchronous screen every chat turn and media request gets: the worst,
  // unambiguous content is flagged and refused before a provider sees it. An
  // app's prompt is the viewer's request as much as a chat message is.
  if (!isOwnerEmail(user.email)) {
    const screened = parsed.data.system ? `${parsed.data.system}\n${parsed.data.prompt}` : parsed.data.prompt;
    const urgent = quickScreen(screened);
    if (urgent && (urgent.severity === "high" || urgent.severity === "critical")) {
      await recordFlag({
        userId: user.id,
        severity: urgent.severity,
        category: urgent.category,
        detail: `${urgent.detail} (an app's AI request)`,
        source: "auto",
        messagePreview: moderationMessagePreview(screened, false),
      });
      return NextResponse.json({ error: "This request violates our Acceptable Use policy.", code: "policy_violation" }, { status: 403 });
    }
  }

  const plan = await getUserPlan(access.viewerId);
  const deps = artifactCompletionDeps(access.viewerId);
  const admitted = await admitArtifactCompletion(
    {
      viewerId: access.viewerId,
      plan,
      prompt: parsed.data.prompt,
      system: parsed.data.system ?? undefined,
      maxTokens: parsed.data.maxTokens,
    },
    deps
  );
  if (!admitted.ok) return NextResponse.json(admitted.body, { status: admitted.status });

  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = AbortSignal.any([req.signal, deadline]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CompletionStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The page went away; the generator still settles and bills.
        }
      };
      try {
        for await (const event of streamArtifactCompletion(admitted.admission, deps, signal)) send(event);
        if (deadline.aborted && !req.signal.aborted) {
          send({ type: "error", code: "failed", message: "The reply took too long. Ask for something shorter." });
        }
      } catch (err) {
        console.error("[artifact-runtime] completion failed:", err instanceof Error ? err.name : "error");
        send({ type: "error", code: "failed", message: "The reply could not be finished. Try again." });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a cancel.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
