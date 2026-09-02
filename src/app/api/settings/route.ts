import { NextResponse } from "next/server";
import { z } from "zod";
import type { Theme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { isModelId } from "@/lib/models";
import { PERSONALITY_IDS } from "@/lib/personalities";
import { AUTO_LOCALE, normalizeWebLocale } from "@/lib/i18n";
import { BACKGROUND_PROVIDER_MODES } from "@/lib/background-provider-policy";
import { ACTION_PERMISSION_POLICIES } from "@/lib/action-approval";

const schema = z.object({
  // The display name — what the sidebar and the greeting call you. Lives on
  // User, not Settings, and is the one field here that writes there.
  name: z.string().trim().max(80).optional(),
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
  // Where background work (memory extraction, titles, planning, moderation)
  // may be sent. Validated against the union rather than accepted as free text,
  // so an unknown value cannot be stored and later read as permission to cross
  // providers.
  backgroundProviderMode: z.enum(BACKGROUND_PROVIDER_MODES).optional(),
  backgroundProviderSelected: z.string().max(60).nullable().optional(),
  voiceId: z.string().max(100).nullable().optional(),
  favoriteModels: z.array(z.string().max(120)).max(200).optional(),
  emailBudgetAlerts: z.boolean().optional(),
  emailWeeklyDigest: z.boolean().optional(),
  // The account's own monthly API-spend ceiling in EUR. null restores "use the
  // plan's figure" — which for an account whose plan states none is
  // PERSONAL_DEFAULT_CAP_EUR, not "no ceiling". Bounded rather than open: the
  // effective ceiling is the MINIMUM of this and the plan's, so a large number
  // can never buy more than the plan already permits, but an unbounded one
  // would still overflow the Int column on the way in.
  monthlySpendCapEur: z.int().min(0).max(100_000).nullable().optional(),
  // How much Juno must ask before an action leaves the account. Enumerated for
  // the same reason as backgroundProviderMode: the column is TEXT, and an
  // unrecognised value falls back to the default at read time, so a typo stored
  // here would silently loosen or tighten permissions with nothing to show for
  // it. It is also an input to the policy digest, so accepting free text would
  // let a client invalidate every pending approval by writing nonsense.
  actionApprovalPolicy: z.enum(ACTION_PERMISSION_POLICIES).optional(),
  lockdownMode: z.boolean().optional(),
  // Bounded because this list is read on every connector call and hashed into
  // the policy digest; an unbounded array turns one settings write into a slow
  // path for every subsequent action.
  blockedConnectors: z.array(z.string().max(120)).max(200).optional(),
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
      // Exposed so macOS and iOS show the same policy the web does, rather
      // than each client assuming a default.
      backgroundProviderMode: true,
      backgroundProviderSelected: true,
      defaultModel: true,
      favoriteModels: true,
      // The approval policy is enforced server-side on every connector call, so
      // a client cannot weaken it by not reading it. It is exposed so macOS and
      // iOS can draw the same permission state the web shows, rather than each
      // one guessing and then surprising the user with a prompt it said would
      // not appear.
      actionApprovalPolicy: true,
      lockdownMode: true,
      blockedConnectors: true,
      // The spend ceiling and its one bypass. Both exposed read-only here so
      // macOS and iOS can draw the same "who set this ceiling" line the web
      // does — and, in particular, so a client can never render an account with
      // enforcement switched off as an account on a generous plan.
      monthlySpendCapEur: true,
      spendCapDisabled: true,
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
  if (d.name !== undefined) {
    await prisma.user.update({ where: { id: user.id }, data: { name: d.name || null } });
  }
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
      ...(d.backgroundProviderMode !== undefined
        ? { backgroundProviderMode: d.backgroundProviderMode }
        : {}),
      ...(d.backgroundProviderSelected !== undefined
        ? { backgroundProviderSelected: d.backgroundProviderSelected }
        : {}),
      ...(d.voiceId !== undefined ? { voiceId: d.voiceId } : {}),
      ...(d.favoriteModels !== undefined ? { favoriteModels: d.favoriteModels } : {}),
      ...(d.emailBudgetAlerts !== undefined ? { emailBudgetAlerts: d.emailBudgetAlerts } : {}),
      ...(d.emailWeeklyDigest !== undefined ? { emailWeeklyDigest: d.emailWeeklyDigest } : {}),
      // Note what is NOT writable here: `spendCapDisabled`. It is the single
      // bypass for the spend ceiling and the one control a compromised session
      // must not be able to flip, so it stays out of the client's reach
      // entirely — a deliberate development escape hatch, set in the database.
      ...(d.monthlySpendCapEur !== undefined ? { monthlySpendCapEur: d.monthlySpendCapEur } : {}),
      ...(d.actionApprovalPolicy !== undefined ? { actionApprovalPolicy: d.actionApprovalPolicy } : {}),
      ...(d.lockdownMode !== undefined ? { lockdownMode: d.lockdownMode } : {}),
      // Deduplicated on the way in. `resolveActionPolicy` sorts and de-dupes
      // before hashing, so a list that differs only by repeats would produce an
      // identical digest — storing the repeats would just make the settings UI
      // show the same connector twice.
      ...(d.blockedConnectors !== undefined
        ? { blockedConnectors: [...new Set(d.blockedConnectors)] }
        : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
