import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";
import { canUseModel } from "@/lib/plans";
import { resolveModel } from "@/lib/models";
import {
  computeNextRunAt,
  isValidTimezone,
  serializeTask,
  LATEST_RUN_INCLUDE,
} from "@/lib/scheduled-tasks";

export const runtime = "nodejs";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  cadence: z.enum(["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"]).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  weekday: z.number().int().min(0).max(6).nullish(),
  monthday: z.number().int().min(1).max(28).nullish(),
  timezone: z.string().trim().min(1).max(64).optional(),
  webSearch: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.scheduledTask.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const input = parsed.data;

  if (input.model !== undefined) {
    const model = resolveModel(input.model);
    if (!model || model.modality !== "chat" || model.comingSoon) {
      return NextResponse.json({ error: "Pick a chat model for this task." }, { status: 400 });
    }
    if (!canUseModel(await getUserPlan(user.id), model.id)) {
      return NextResponse.json({ error: "Your plan doesn't include this model." }, { status: 403 });
    }
    input.model = model.id;
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    return NextResponse.json({ error: "Unknown timezone — use an IANA name like Europe/Paris." }, { status: 400 });
  }

  // Validate the MERGED schedule (a cadence flip must come with its day field),
  // then recompute nextRunAt — cheap, and re-enabling restarts from now.
  const schedule = {
    cadence: input.cadence ?? existing.cadence,
    hour: input.hour ?? existing.hour,
    minute: input.minute ?? existing.minute,
    weekday: input.weekday === undefined ? existing.weekday : input.weekday,
    monthday: input.monthday === undefined ? existing.monthday : input.monthday,
    timezone: input.timezone ?? existing.timezone,
  };
  if (schedule.cadence === "WEEKLY" && schedule.weekday == null) {
    return NextResponse.json({ error: "Weekly tasks need a weekday." }, { status: 400 });
  }
  if (schedule.cadence === "MONTHLY" && schedule.monthday == null) {
    return NextResponse.json({ error: "Monthly tasks need a day of the month." }, { status: 400 });
  }

  const task = await prisma.scheduledTask.update({
    where: { id, userId: user.id },
    data: { ...input, ...schedule, nextRunAt: computeNextRunAt(schedule) },
    include: LATEST_RUN_INCLUDE,
  });

  return NextResponse.json({ task: serializeTask(task) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.scheduledTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Runs cascade-delete; the results conversation is kept — it's a normal chat.
  await prisma.scheduledTask.delete({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
