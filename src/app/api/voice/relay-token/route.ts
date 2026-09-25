import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { signState } from "@/lib/crypto";
import { evaluateVoiceAccess } from "@/lib/voice-access-policy";
import { checkProjectAccess } from "@/lib/project-collaboration";
import { parseVoiceMemoryRequest } from "@/lib/voice-memory";
import { parseVoiceConversationRequest } from "@/lib/voice-persona";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function resolveVoiceRelayURL(): string | null {
  const configured = process.env.NEXT_PUBLIC_VOICE_RELAY_URL || process.env.VOICE_RELAY_URL;
  if (configured?.trim()) return configured.trim().replace(/\/+$/, "");

  // The production deployment hosts the relay behind the same TLS origin at
  // `/voice-relay`. Keep the dedicated variables as the explicit override, but
  // derive this canonical same-host URL when an older environment forgot to add
  // them. This is particularly important for native clients: a missing
  // build-time NEXT_PUBLIC_* variable must not turn a healthy relay into a 503.
  const appURL = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (!appURL?.trim()) return null;
  try {
    const url = new URL(appURL.trim());
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;
    url.pathname = "/voice-relay";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Mints a short-lived token for the voice relay. The relay shares AUTH_SECRET
 * and verifies the same HMAC format (see relay/src/auth.ts) — no DB access on
 * the relay side. Token payload: {"uid", "exp"} (60s window to CONNECT; the
 * WebSocket session itself may run much longer), plus {"mem": 1, "pid"} when
 * the call should know what Juno remembers.
 *
 * MEMORY IS ASKED FOR, never assumed. `?memory=1` (and `&projectId=` for a
 * project chat) comes from a chat that is not incognito; without it the call
 * knows nothing, which is what the native apps and every other voice surface
 * keep until they ask. The request only reaches the token after the project is
 * shown to be one this person can use — a signed claim to a project they
 * cannot open would be a way to read its memory. Whether memory is ON, and
 * what it says, is decided when the relay asks for it
 * (src/app/api/voice/memory/route.ts), so memory paused after the token was
 * minted is still honoured.
 *
 * THE AGENT IS RESOLVED HERE, never named by the caller. `?conversationId=`
 * (from any chat that is not incognito, web or native — native knows only the
 * conversation) is looked up among this person's own conversations, and only
 * an agent's thread whose agent is still here puts {"aid"} in the token. The
 * relay asks for that agent's persona with it (src/app/api/voice/persona). A
 * lookup that fails signs no claim rather than failing the call: the call is
 * then Juno, as it was before the claim existed.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await evaluateVoiceAccess(user, "relay-token");
  if (!access.allowed && access.denial) {
    return NextResponse.json(
      { error: access.denial.error, ...(access.denial.message ? { message: access.denial.message } : {}) },
      { status: access.denial.status },
    );
  }

  const url = resolveVoiceRelayURL();
  if (!url) return NextResponse.json({ error: "Realtime voice is not configured." }, { status: 503 });

  const params = new URL(req.url).searchParams;
  let memory = parseVoiceMemoryRequest(params);
  if (memory?.projectId && !(await checkProjectAccess(user.id, memory.projectId, "VIEWER")).allowed) {
    // Not a project they can use: no memory at all, rather than the account's
    // — a project chat reading account memory is the leak isolation prevents.
    memory = null;
  }
  const agentId = await threadAgent(user.id, parseVoiceConversationRequest(params));
  const token = signState(
    JSON.stringify({
      uid: user.id,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...(memory ? { mem: 1, ...(memory.projectId ? { pid: memory.projectId } : {}) } : {}),
      ...(agentId ? { aid: agentId } : {}),
    })
  );

  // Best-effort provider availability from the relay's /healthz — the client
  // uses it to pick a working default and grey out dead providers. Failure
  // here must never block token minting: the WebSocket handshake itself is the
  // authoritative availability check and gives the native client a typed error.
  let providers: Record<string, boolean> | null = null;
  try {
    const healthUrl = `${url.replace(/^ws/i, "http")}/healthz`;
    const health = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (health.ok) {
      const body = (await health.json()) as { providers?: Record<string, boolean> };
      if (body.providers && typeof body.providers === "object") providers = body.providers;
    }
  } catch {
    // Relay unreachable — the session start will surface the transport failure.
  }

  return NextResponse.json(providers ? { token, url, providers } : { token, url });
}

/** The agent whose thread this conversation is, if it is this person's and the agent is not retired. */
async function threadAgent(userId: string, conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { agentId: true },
    });
    if (!conversation?.agentId) return null;
    const agent = await prisma.agent.findFirst({
      where: { id: conversation.agentId, userId, deletedAt: null },
      select: { id: true },
    });
    return agent?.id ?? null;
  } catch {
    return null;
  }
}
