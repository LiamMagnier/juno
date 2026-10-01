import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Standing approvals belong to the account, including project-scoped grants. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const grants = await prisma.actionApprovalGrant.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, connectorId: true, projectId: true, toolName: true, action: true, maxRiskClass: true, createdAt: true },
  });
  return NextResponse.json({ grants }, { headers: { "Cache-Control": "private, no-store" } });
}
