import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { rateLimit } from "@/lib/rate-limit";
import { isWebSearchConfigured } from "@/lib/web-search";
import { isAutoModelId } from "@/lib/auto-model";
import {
  conversationContextFor,
  driveResearchInBackground,
  listResearchRunSummaries,
  readResearchRun,
  researchAccountFacts,
  researchEngine,
  researchStartCheck,
} from "@/lib/research/run";
import { RESEARCH_REFUSAL_COPY, researchEntitlement, type ResearchRefusal } from "@/lib/research/entitlement";
import { startResearchSchema, validLocale, validTimeZone } from "@/app/api/research/protocol";

export const runtime = "nodejs";

/**
 * Starting and listing durable research runs.
 *
 * POST answers as soon as the row exists and lets the job run on behind it.
 * Awaiting the run here would be the in-request pipeline this surface replaced:
 * a research run takes minutes, and a request that holds one open is a run that
 * dies when the platform's request timeout fires, with nothing to resume from.
 *
 * A run started here plans in the background and waits at the scope card
 * (SPEC §9.4, §9.6.2): the person sees the questions and the estimate before
 * anything is spent beyond the one planner call. It is sized from its scope
 * at Start, so a client-set ceiling and a depth level are both ignored.
 */

/** The HTTP status a refusal answers with: 402 for money and plan, 403 for policy, 429 for limits, 503 for the deployment. */
const REFUSAL_STATUS: Record<ResearchRefusal, number> = {
  plan: 402,
  budget: 402,
  not_configured: 503,
  workspace: 403,
  private: 403,
  lockdown: 403,
  voice: 403,
  live_runs: 429,
  daily_starts: 429,
};

function refused(reason: ResearchRefusal, params: Record<string, string | number> = {}) {
  return NextResponse.json(
    { error: `research.${reason}`, message: RESEARCH_REFUSAL_COPY.reasons[reason], params },
    { status: REFUSAL_STATUS[reason] }
  );
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = startResearchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // Accepted and ignored (§9.4, R1): the envelope sizes the run.
  if (parsed.data.budgetMicroUsd !== undefined) {
    console.info("research.start.client_budget_ignored", { userId: user.id });
  }
  if (parsed.data.effort !== undefined) {
    console.info("research.start.effort_ignored", { userId: user.id, effort: parsed.data.effort });
  }

  if (parsed.data.conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: parsed.data.conversationId, userId: user.id }, select: { id: true },
    });
    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const plan = await getUserPlan(user.id);
  const facts = await researchAccountFacts(user.id, parsed.data.conversationId);
  const entitled = researchEntitlement({
    plan,
    privateMode: false,
    lockdown: facts.lockdown,
    voiceMode: false,
    workspace: facts.workspace,
    configured: isWebSearchConfigured(),
  });
  if (!entitled.allowed) return refused(entitled.reason);

  // A research run is the most expensive thing Juno does, and the cheapest way
  // to spend a month's budget in a minute is a loop that presses Start.
  const limit = await rateLimit({ key: `research-start:${user.id}`, limit: 10, windowSec: 3_600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "research.rate_limited", message: "Too many research runs started. Try again shortly." },
      { status: 429 }
    );
  }

  const timeZone = validTimeZone(parsed.data.timeZone);
  const locale = validLocale(parsed.data.locale);
  const check = await researchStartCheck({ userId: user.id, plan, timeZone });
  if ("refused" in check) return refused(check.reason, check.params);

  const run = await researchEngine().start({
    userId: user.id,
    goal: parsed.data.goal,
    conversationId: parsed.data.conversationId ?? null,
    confirmation: "required",
    constraints: parsed.data.constraints,
    pinnedSources: parsed.data.pinnedSources,
    context: await conversationContextFor(parsed.data.conversationId, user.id),
    timeZone,
    locale,
    language: validLocale(parsed.data.language) ?? facts.responseLanguage,
    // The composer's model leads the run (§9.5.1), as on the chat's paths.
    preferredModel: isAutoModelId(parsed.data.preferredModel) ? null : parsed.data.preferredModel ?? null,
  });
  driveResearchInBackground({ runId: run.id, userId: user.id });

  const view = await readResearchRun({ runId: run.id, userId: user.id, after: 0 });
  return NextResponse.json(view, { status: 201 });
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // `?conversationId=` answers "which runs belong to this chat" in one fetch
  // (§9.4); `?live=1` is the account's live runs plus those finished in the
  // last ten minutes, for the completion watcher. Newest first, at most 20.
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  const live = url.searchParams.get("live") === "1";
  const runs = await listResearchRunSummaries({ userId: user.id, conversationId, live });
  return NextResponse.json({ runs });
}
