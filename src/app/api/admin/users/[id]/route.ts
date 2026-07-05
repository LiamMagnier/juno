import { NextResponse } from "next/server";
import { z } from "zod";
import { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOwnerUser } from "@/lib/admin";
import { isOwnerEmail } from "@/lib/owner";
import { getUserPlan } from "@/lib/usage";
import { deleteUserByAdmin } from "@/lib/moderation";

export const runtime = "nodejs";

const patchSchema = z.object({ plan: z.enum(Plan) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, image: true, createdAt: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (user.id === owner.id) {
    return NextResponse.json({ error: "cannot change your own plan" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  const { plan } = parsed.data;

  const oldPlan = await getUserPlan(id);
  const subscription = await prisma.subscription.upsert({
    where: { userId: id },
    // Force ACTIVE so the granted plan actually takes effect (getUserPlan only
    // honors ACTIVE/TRIALING subscriptions).
    create: { userId: id, plan, status: "ACTIVE" },
    update: { plan, status: "ACTIVE" },
    select: { status: true },
  });

  console.log(`[admin] plan change by ${owner.email}: ${user.email} ${oldPlan} -> ${plan}`);

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      createdAt: user.createdAt.toISOString(),
      plan: await getUserPlan(id),
      subscriptionStatus: subscription.status,
    },
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await getOwnerUser();
  if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, image: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (user.id === owner.id || isOwnerEmail(user.email)) {
    return NextResponse.json({ error: "cannot delete an owner" }, { status: 400 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => null);
  const reason =
    url.searchParams.get("reason") ?? (body && typeof body.reason === "string" ? body.reason : undefined);

  await deleteUserByAdmin(user, owner.email!, reason ?? undefined);

  return NextResponse.json({ ok: true });
}
