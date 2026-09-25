import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyState } from "@/lib/crypto";
import { agentChatContext } from "@/lib/agents/store";
import { agentVoiceSlot, voicePersonaInstructions } from "@/lib/voice-persona";

export const runtime = "nodejs";

/*
 * Who a voice call in an agent's thread is — asked for by the voice relay,
 * server to server, when such a call starts.
 *
 * Authenticated exactly as the memory route is (src/app/api/voice/memory):
 * a short-lived HMAC token under the shared AUTH_SECRET, with an audience of
 * its own, so neither a spend nor a memory token can read a persona. The agent
 * rides INSIDE the signed token — the relay-token route put it there only after
 * finding it behind one of this person's own conversations — and is checked
 * again here, because an agent retired since is nobody.
 *
 * The block is the chat's (agentChatContext), built without `start_task`: a
 * call has no tools, and the block only describes tools a turn has. Memory
 * being paused does not silence it, as it does not in a typed turn: the brief
 * and the agent's notes are the agent, not what Juno remembers about someone.
 * Shaped for speech in src/lib/voice-persona.ts.
 */

const AUDIENCE = "juno.voice.persona";

function relayCaller(header: string | null): { userId: string; agentId: string } | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const body = verifyState(token);
  if (!body) return null;
  try {
    const payload = JSON.parse(body) as { uid?: unknown; exp?: unknown; aud?: unknown; aid?: unknown };
    if (payload.aud !== AUDIENCE) return null;
    if (typeof payload.uid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.aid !== "string" || !payload.aid) return null;
    return { userId: payload.uid, agentId: payload.aid };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const caller = relayCaller(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { userId, agentId } = caller;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const context = await agentChatContext(user, agentId, { taskHandoff: false }).catch(() => null);
  if (!context) return NextResponse.json({ instructions: null });
  return NextResponse.json({
    instructions: voicePersonaInstructions(context.block, user.name),
    voiceSlot: agentVoiceSlot(context.agent.id),
  });
}
