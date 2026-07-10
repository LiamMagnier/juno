import { NextResponse } from "next/server";
import { z } from "zod";
import type { Theme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { isModelId } from "@/lib/models";
import { ACCENT_IDS } from "@/lib/accents";

const schema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  accent: z.string().max(30).regex(/^([a-z]+|#[0-9a-fA-F]{6})$/).optional(),
  defaultModel: z.string().optional(),
  customInstructions: z.string().max(4000).optional(),
  responseLanguage: z.string().max(40).optional(),
  memoryEnabled: z.boolean().optional(),
  voiceId: z.string().max(100).nullable().optional(),
  favoriteModels: z.array(z.string().max(120)).max(200).optional(),
  emailBudgetAlerts: z.boolean().optional(),
  emailWeeklyDigest: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const d = parsed.data;

  if (d.defaultModel && !isModelId(d.defaultModel)) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }

  await ensureUserDefaults(user.id);
  await prisma.settings.update({
    where: { userId: user.id },
    data: {
      ...(d.theme ? { theme: d.theme.toUpperCase() as Theme } : {}),
      ...(d.accent ? { accent: d.accent } : {}),
      ...(d.defaultModel ? { defaultModel: d.defaultModel } : {}),
      ...(d.customInstructions !== undefined ? { customInstructions: d.customInstructions } : {}),
      ...(d.responseLanguage !== undefined ? { responseLanguage: d.responseLanguage } : {}),
      ...(d.memoryEnabled !== undefined ? { memoryEnabled: d.memoryEnabled } : {}),
      ...(d.voiceId !== undefined ? { voiceId: d.voiceId } : {}),
      ...(d.favoriteModels !== undefined ? { favoriteModels: d.favoriteModels } : {}),
      ...(d.emailBudgetAlerts !== undefined ? { emailBudgetAlerts: d.emailBudgetAlerts } : {}),
      ...(d.emailWeeklyDigest !== undefined ? { emailWeeklyDigest: d.emailWeeklyDigest } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
