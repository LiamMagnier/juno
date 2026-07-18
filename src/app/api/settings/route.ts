import { NextResponse } from "next/server";
import { z } from "zod";
import type { Theme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { isModelId } from "@/lib/models";
import { PERSONALITY_IDS } from "@/lib/personalities";
import { AUTO_LOCALE, normalizeWebLocale } from "@/lib/i18n";

const schema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  accent: z.string().max(30).regex(/^([a-z]+|#[0-9a-fA-F]{6})$/).optional(),
  defaultModel: z.string().optional(),
  personality: z.enum(PERSONALITY_IDS).optional(),
  // No app-side character cap — model context is the real limit (curriculum /
  // mentor system prompts regularly exceed the old 4k hard ceiling).
  customInstructions: z.string().optional(),
  responseLanguage: z.string().max(40).optional(),
  uiLocale: z.string().max(35).optional(),
  memoryEnabled: z.boolean().optional(),
  voiceId: z.string().max(100).nullable().optional(),
  favoriteModels: z.array(z.string().max(120)).max(200).optional(),
  emailBudgetAlerts: z.boolean().optional(),
  emailWeeklyDigest: z.boolean().optional(),
});

/**
 * The account's settings row, for the native app's pull-before-push hydration
 * (BackendClient.fetchSettings). Field names mirror ClientSettingsDTO and the
 * PATCH body above, so a client can round-trip what it reads. Serves
 * server-side truth: `ensureUserDefaults` materialises the row first, so a
 * brand-new account returns schema defaults rather than 404.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await ensureUserDefaults(user.id);
  const settings = await prisma.settings.findUnique({
    where: { userId: user.id },
    select: {
      customInstructions: true,
      responseLanguage: true,
      memoryEnabled: true,
      defaultModel: true,
      favoriteModels: true,
    },
  });
  if (!settings) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ settings });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const d = parsed.data;

  if (d.defaultModel && !isModelId(d.defaultModel)) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }

  // Store the canonical tag ("fr_fr" -> "fr-FR") so `<html lang>` and the
  // picker's value always agree, and a junk tag can never reach the renderer.
  let uiLocale: string | undefined;
  if (d.uiLocale !== undefined) {
    uiLocale = d.uiLocale === AUTO_LOCALE ? AUTO_LOCALE : normalizeWebLocale(d.uiLocale) ?? undefined;
    if (!uiLocale) return NextResponse.json({ error: "Unknown locale" }, { status: 400 });
  }

  await ensureUserDefaults(user.id);
  await prisma.settings.update({
    where: { userId: user.id },
    data: {
      ...(d.theme ? { theme: d.theme.toUpperCase() as Theme } : {}),
      ...(d.accent ? { accent: d.accent } : {}),
      ...(d.defaultModel ? { defaultModel: d.defaultModel } : {}),
      ...(d.personality ? { personality: d.personality } : {}),
      ...(d.customInstructions !== undefined ? { customInstructions: d.customInstructions } : {}),
      ...(d.responseLanguage !== undefined ? { responseLanguage: d.responseLanguage } : {}),
      ...(uiLocale !== undefined ? { uiLocale } : {}),
      ...(d.memoryEnabled !== undefined ? { memoryEnabled: d.memoryEnabled } : {}),
      ...(d.voiceId !== undefined ? { voiceId: d.voiceId } : {}),
      ...(d.favoriteModels !== undefined ? { favoriteModels: d.favoriteModels } : {}),
      ...(d.emailBudgetAlerts !== undefined ? { emailBudgetAlerts: d.emailBudgetAlerts } : {}),
      ...(d.emailWeeklyDigest !== undefined ? { emailWeeklyDigest: d.emailWeeklyDigest } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
