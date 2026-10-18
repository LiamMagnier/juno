import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { recordWorkAudit } from "@/lib/work/audit";
import { linkHub } from "@/lib/code-v2/env-link-select";
import { controllerFor, requireRemotePair } from "@/lib/code-v2/device-pairing-guard";
import { handleAgentControl, type AgentControlDeps, type StoredAgentControl } from "@/lib/code-v2/agent-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 35;

const MAX_BODY_BYTES = 32 * 1024;

/**
 * A person's controls over one agent of a Code run on their Mac (REA backlog
 * 10, the web Agents tree): Steer, Stop, Pause, Resume, Top-up. Shared by every
 * remote surface (web, and the phone through its native bearer). The checks,
 * the idempotency and the audit live in src/lib/code-v2/agent-control.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* parseAgentControl rejects it */
  }

  const actor = (await controllerFor(req)).kind === "phone" ? "ios" : "web";
  const deps: AgentControlDeps = {
    rateLimit: async (key, limit, windowSec) => (await rateLimit({ key, limit, windowSec })).success,
    findDevice: (userId, id) => prisma.codeDevice.findFirst({ where: { id, userId }, select: { id: true, name: true } }),
    checkPair: async (userId, id) => {
      const refused = await requireRemotePair(req, userId, id);
      if (!refused) return null;
      const payload = (await refused.json().catch(() => ({}))) as { error?: string; code?: string };
      return { status: refused.status, error: payload.error ?? "This browser is not paired with that computer.", ...(payload.code ? { code: payload.code } : {}) };
    },
    findPrior: async (userId, idempotencyKey, since) => {
      const rows = await prisma.workAuditEvent.findMany({
        where: { userId, kind: "agent_control", createdAt: { gte: since }, detail: { path: ["idempotencyKey"], equals: idempotencyKey } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { detail: true },
      });
      const details = rows.map((r) => r.detail as Record<string, unknown>);
      const decisive = details.find((d) => d.outcome === "accepted" || d.outcome === "refused") ?? details[0];
      if (!decisive || typeof decisive.outcome !== "string") return null;
      return {
        outcome: decisive.outcome as StoredAgentControl["outcome"],
        ...(typeof decisive.contentHash === "string" ? { contentHash: decisive.contentHash } : {}),
        ...(typeof decisive.reason === "string" ? { reason: decisive.reason } : {}),
        ...(typeof decisive.count === "number" ? { count: decisive.count } : {}),
      };
    },
    relay: (userId, id, command, options) => linkHub().link(userId, id).rpc(command, options),
    audit: (userId, detail) =>
      recordWorkAudit({
        userId,
        kind: "agent_control",
        severity: detail.outcome === "refused" ? "refusal" : "info",
        actor,
        detail: { ...detail },
      }),
    newCommandId: () => `agent_${randomUUID()}`,
    now: () => Date.now(),
  };

  const reply = await handleAgentControl(deps, { userId: user.id, deviceId, body });
  return NextResponse.json(reply.body, { status: reply.status, headers: { "Cache-Control": "no-store" } });
}
