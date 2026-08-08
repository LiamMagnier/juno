import { NextResponse } from "next/server";
import { getOwnerUser } from "@/lib/admin";
import { loadAvailableModels } from "@/lib/model-catalog-api";
import { probeAndPersistModelCapability } from "@/lib/model-capability";

export const runtime = "nodejs";

function publicSnapshot(snapshot: Awaited<ReturnType<typeof probeAndPersistModelCapability>>) {
  return {
    modelId: snapshot.modelId,
    provider: snapshot.provider,
    status: snapshot.status,
    checkedAt: snapshot.checkedAt,
    expiresAt: snapshot.expiresAt,
    detail: snapshot.detail,
    evidence: snapshot.evidence,
  };
}

/**
 * Owner-only model health control plane.
 *
 * GET is the read side used by an operator dashboard. POST is intentionally
 * explicit: probing spends one provider request per model, so a deployment
 * never starts paid probes merely because a user opened the model picker.
 */
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prismaRows();
  return NextResponse.json({ probes: rows });
}

export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const requestedId =
    body && typeof body === "object" && typeof (body as { modelId?: unknown }).modelId === "string"
      ? (body as { modelId: string }).modelId.trim()
      : "";
  const models = (await loadAvailableModels()).filter((model) => model.modality === "chat" && !model.comingSoon);
  const targets = requestedId ? models.filter((model) => model.id === requestedId) : models;
  if (requestedId && targets.length === 0) {
    return NextResponse.json({ error: "Unknown or unavailable model." }, { status: 400 });
  }

  const snapshots = [];
  for (const model of targets) {
    snapshots.push(publicSnapshot(await probeAndPersistModelCapability(model)));
  }
  return NextResponse.json({ probes: snapshots, count: snapshots.length });
}

async function prismaRows() {
  // Keep the route's payload free of Prisma BigInt/Date objects and cap the
  // list so a stale table cannot turn an admin page into an unbounded query.
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.modelCapabilityProbe.findMany({
    orderBy: [{ status: "asc" }, { checkedAt: "desc" }],
    take: 500,
  });
  return rows.map((row) => ({
    modelId: row.modelId,
    provider: row.provider,
    status: row.status,
    probeVersion: row.probeVersion,
    evidence: row.evidence,
    detail: row.detail,
    checkedAt: row.checkedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}
