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
  taskLimitForPlan,
  DEFAULT_TASK_TIMEZONE,
  LATEST_RUN_INCLUDE,
} from "@/lib/scheduled-tasks";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  const tasks = await prisma.scheduledTask.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: LATEST_RUN_INCLUDE,
  });

  return NextResponse.json({ tasks: tasks.map(serializeTask), limit: taskLimitForPlan(plan) });
}

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(4000),
    model: z.string().trim().min(1).max(120),
    cadence: z.enum(["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6).nullish(),
    // 1–28 so MONTHLY lands inside every month (no Feb 30 dead schedule).
    monthday: z.number().int().min(1).max(28).nullish(),
    timezone: z.string().trim().min(1).max(64).default(DEFAULT_TASK_TIMEZONE),
    webSearch: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.cadence === "WEEKLY" && v.weekday == null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekday"], message: "Weekly tasks need a weekday." });
    if (v.cadence === "MONTHLY" && v.monthday == null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["monthday"], message: "Monthly tasks need a day of the month." });
  });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const input = parsed.data;

  const plan = await getUserPlan(user.id);
  const limit = taskLimitForPlan(plan);
  if (limit === 0) {
    return NextResponse.json(
      { error: "plan_locked", message: "Scheduled tasks are part of Pro. Upgrade to schedule your first one." },
      { status: 403 }
    );
  }
  const count = await prisma.scheduledTask.count({ where: { userId: user.id } });
  if (count >= limit) {
    return NextResponse.json(
      { error: "task_limit", message: `Your plan allows ${limit} scheduled ${limit === 1 ? "task" : "tasks"}.` },
      { status: 403 }
    );
  }

  const model = resolveModel(input.model);
  if (!model || model.modality !== "chat" || model.comingSoon) {
    return NextResponse.json({ error: "Pick a chat model for this task." }, { status: 400 });
  }
  if (!canUseModel(plan, model.id)) {
    return NextResponse.json({ error: "Your plan doesn't include this model." }, { status: 403 });
  }
  if (!isValidTimezone(input.timezone)) {
    return NextResponse.json({ error: "Unknown timezone — use an IANA name like Europe/Paris." }, { status: 400 });
  }

  const schedule = {
    cadence: input.cadence,
    hour: input.hour,
    minute: input.minute,
    weekday: input.weekday ?? null,
    monthday: input.monthday ?? null,
    timezone: input.timezone,
  };
  const task = await prisma.scheduledTask.create({
    data: {
      userId: user.id,
      name: input.name,
      prompt: input.prompt,
      model: model.id,
      webSearch: input.webSearch,
      ...schedule,
      nextRunAt: computeNextRunAt(schedule),
    },
    include: LATEST_RUN_INCLUDE,
  });

  return NextResponse.json({ task: serializeTask(task) }, { status: 201 });
}
