import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { backgroundDenialMessage } from "@/lib/background-provider-policy";
import { consolidateProjectMemory, getProjectMemorySummary, utilityModelCandidates } from "@/lib/memory";
import { checkProjectAccess } from "@/lib/project-collaboration";

export const runtime = "nodejs";
export const maxDuration = 60;

/*
 * One project's memory, as the project page shows it: the summary its chats
 * read, and the facts learned in it.
 *
 * YOURS, even in a shared project. Access to the project is checked (a VIEWER
 * is enough), and then every read is scoped to the caller's own rows — a
 * collaborator sees what Juno learned from THEIR chats in the project, never
 * another member's. Memory is personal; sharing a project shares its files and
 * instructions, not what each person has told Juno.
 */

/** The rail shows three; the page links to the rest. Enough for a count and a preview. */
const PREVIEW_FACTS = 12;

// Hoisted for the i18n extractor, like the account consolidate route's copy.
const FAILURE_MESSAGE = {
  busy: "The AI provider is busy right now — wait a minute and try again.",
  unusable: "Couldn’t generate a summary right now — try again in a moment.",
};

async function authorize(projectId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { allowed } = await checkProjectAccess(user.id, projectId, "VIEWER");
  if (!allowed) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  return { user } as const;
}

function serializeSummary(summary: { content: string; updatedAt: Date; entryCount: number } | null) {
  return summary
    ? { content: summary.content, updatedAt: summary.updatedAt.toISOString(), entryCount: summary.entryCount }
    : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;
  const now = new Date();

  const active = {
    userId,
    projectId: id,
    kind: "FACT" as const,
    status: "active",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
  const [summary, facts, activeCount] = await Promise.all([
    getProjectMemorySummary(userId, id),
    prisma.memoryEntry.findMany({
      where: active,
      orderBy: { createdAt: "desc" },
      take: PREVIEW_FACTS,
      select: { id: true, content: true, createdAt: true },
    }),
    prisma.memoryEntry.count({ where: active }),
  ]);

  return NextResponse.json({
    summary: serializeSummary(summary),
    facts: facts.map((fact) => ({ id: fact.id, content: fact.content, createdAt: fact.createdAt.toISOString() })),
    activeCount,
  });
}

/** Rebuild this project's summary now — the project page's and the memory page's "Rebuild". */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  if (utilityModelCandidates().length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  const outcome = await consolidateProjectMemory({ userId, projectId: id });

  // The account route's contract, so one client handles both: a policy
  // refusal is a 409 naming the setting, a model failure a 502.
  if (outcome.status === "denied") {
    return NextResponse.json(
      {
        error: backgroundDenialMessage(outcome.reason),
        code: "background_policy_denied",
        policyMode: outcome.mode,
      },
      { status: 409 }
    );
  }
  if (outcome.status === "empty") return NextResponse.json({ summary: null });
  if (outcome.status === "failed") {
    return NextResponse.json(
      {
        error: outcome.transient ? FAILURE_MESSAGE.busy : FAILURE_MESSAGE.unusable,
        code: "provider_failed",
      },
      { status: 502 }
    );
  }
  return NextResponse.json({ summary: serializeSummary(await getProjectMemorySummary(userId, id)) });
}
