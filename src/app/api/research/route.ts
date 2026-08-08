import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { researchSearchConfigured } from "@/lib/research/tools";
import {
  driveResearchInBackground,
  readResearchRun,
  researchEngine,
} from "@/lib/research/run";
import { startResearchSchema } from "@/app/api/research/protocol";
import {
  RESEARCH_TERMINAL_STATES,
  isResearchState,
  isTerminalResearchState,
  stageForState,
} from "@/lib/research/domain";

export const runtime = "nodejs";

/**
 * Starting and listing durable research runs.
 *
 * POST answers as soon as the row exists and lets the job run on behind it.
 * Awaiting the run here would be the in-request pipeline this surface replaced:
 * a research run takes minutes, and a request that holds one open is a run that
 * dies when the platform's request timeout fires, with nothing to resume from.
 */

/** Runs one account may have going at once. */
const MAX_LIVE_RUNS = 3;
/** Listing page size — this is a sidebar, not an archive. */
const LIST_LIMIT = 20;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = startResearchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].webSearch) {
    return NextResponse.json(
      { error: "Deep research is available on a paid Juno plan." },
      { status: 402 }
    );
  }
  if (!researchSearchConfigured()) {
    return NextResponse.json(
      { error: "Research is not configured on this Juno deployment." },
      { status: 503 }
    );
  }

  // A research run is the most expensive thing Juno does, and the cheapest way
  // to spend a month's budget in a minute is a loop that presses Start.
  const limit = await rateLimit({ key: `research-start:${user.id}`, limit: 10, windowSec: 3_600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many research runs started. Try again shortly." },
      { status: 429 }
    );
  }

  const live = await prisma.researchRun.count({
    where: { userId: user.id, state: { notIn: [...RESEARCH_TERMINAL_STATES] } },
  });
  if (live >= MAX_LIVE_RUNS) {
    return NextResponse.json(
      {
        error: "too_many_runs",
        message: `You already have ${live} research runs going. Finish or cancel one first.`,
      },
      { status: 409 }
    );
  }

  // A run started from this surface always shows its plan first: the user typed
  // a goal and has not yet seen what Juno intends to search for, and the next
  // stage is where the money goes. The chat path pre-confirms instead — the
  // per-send research toggle IS that user's confirmation.
  const run = await researchEngine().start({
    userId: user.id,
    goal: parsed.data.goal,
    conversationId: parsed.data.conversationId ?? null,
    budgetMicroUsd: parsed.data.budgetMicroUsd ? BigInt(parsed.data.budgetMicroUsd) : null,
    confirmation: "required",
    constraints: parsed.data.constraints,
    pinnedSources: parsed.data.pinnedSources,
  });
  driveResearchInBackground({ runId: run.id, userId: user.id });

  const view = await readResearchRun({ runId: run.id, userId: user.id, after: 0 });
  return NextResponse.json(view, { status: 201 });
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The chat panel asks "is there a run for this conversation?" and nothing
  // else, so the filter belongs here rather than in a client that downloads
  // every run the account has ever made and throws most of them away.
  const conversationId = new URL(req.url).searchParams.get("conversationId");
  const rows = await prisma.researchRun.findMany({
    where: { userId: user.id, ...(conversationId ? { conversationId } : {}) },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: {
      id: true,
      goal: true,
      state: true,
      conversationId: true,
      costMicroUsd: true,
      createdAt: true,
      finishedAt: true,
      _count: { select: { sources: true } },
    },
  });
  return NextResponse.json({
    runs: rows.map((row) => ({
      id: row.id,
      goal: row.goal,
      state: row.state,
      // A state the app no longer knows is shown as finished rather than
      // crashing the list: the column is TEXT and rows outlive deployments.
      stage: stageForState(isResearchState(row.state) ? row.state : "failed"),
      conversationId: row.conversationId,
      // Strings, because BigInt does not survive JSON.stringify — a number here
      // would throw at serialisation time, in production, on the list endpoint.
      costMicroUsd: row.costMicroUsd.toString(),
      sourceCount: row._count.sources,
      live: !isTerminalResearchState(row.state),
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    })),
  });
}
