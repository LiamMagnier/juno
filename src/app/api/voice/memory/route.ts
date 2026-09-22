import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyState } from "@/lib/crypto";
import { getMemoryProfile } from "@/lib/memory";
import { checkProjectAccess } from "@/lib/project-collaboration";
import { parseWorkspaceConfig, workspacePermits } from "@/lib/projects/workspace-config";
import { voiceMemoryInstructions } from "@/lib/voice-memory";

export const runtime = "nodejs";

/*
 * What a voice call knows about its caller — asked for by the voice relay,
 * server to server, when a call that wants memory starts.
 *
 * The relay has no database and no cookie; like its spend reports
 * (/api/voice/spend), it proves itself with a short-lived HMAC token under the
 * shared AUTH_SECRET. The audience is this route's own, so a spend token
 * cannot read memory and a token for this cannot bill. The project, when there
 * is one, rides INSIDE the signed token — it was checked when the call's token
 * was minted, and is checked again here — so the relay never names a project
 * nobody signed.
 *
 * Every rule a typed chat applies, applied again: memory paused means nothing;
 * a project chat reads that project's memory in isolation, and a project that
 * turned memory recall off gets none. The block itself is src/lib/voice-memory.ts.
 */

const AUDIENCE = "juno.voice.memory";

/** A small budget: a voice call's instructions have less room than a chat's. */
const VOICE_MEMORY_BUDGET_TOKENS = 450;

function relayCaller(header: string | null): { userId: string; projectId: string | null } | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const body = verifyState(token);
  if (!body) return null;
  try {
    const payload = JSON.parse(body) as { uid?: unknown; exp?: unknown; aud?: unknown; pid?: unknown };
    if (payload.aud !== AUDIENCE) return null;
    if (typeof payload.uid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    const projectId = typeof payload.pid === "string" && payload.pid ? payload.pid : null;
    return { userId: payload.uid, projectId };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const caller = relayCaller(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { userId, projectId } = caller;

  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.settings.findUnique({ where: { userId }, select: { memoryEnabled: true } }),
  ]);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Paused is nothing — read or written, by anything. A missing settings row
  // is the column default (on), as the chat bootstrap reads it.
  if (settings?.memoryEnabled === false) return NextResponse.json({ instructions: null });

  if (projectId) {
    if (!(await checkProjectAccess(userId, projectId, "VIEWER")).allowed) {
      return NextResponse.json({ instructions: null });
    }
    const workspace = await prisma.projectWorkspace.findFirst({
      where: { projectId, userId },
      select: { config: true },
    });
    if (!workspacePermits(parseWorkspaceConfig(workspace?.config), "memoryRecall")) {
      return NextResponse.json({ instructions: null });
    }
  }

  const profile = await getMemoryProfile(userId, {
    projectId,
    budgetTokens: VOICE_MEMORY_BUDGET_TOKENS,
  });
  return NextResponse.json({
    instructions: voiceMemoryInstructions({
      summary: profile.summary,
      recent: profile.recent,
      scope: profile.summaryScope,
    }),
  });
}
