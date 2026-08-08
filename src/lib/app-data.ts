import "server-only";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/auth";
import { listConversations } from "@/lib/queries";
import { getQuota } from "@/lib/usage";
import { budgetForPlan, checkBudget, eurPerUsd, getUsageWindows, billingPeriodFor } from "@/lib/spend";
import { effectiveBudget } from "@/lib/spend-ceiling";
import { env, isStripeConfigured, isStorageAvailable, isServerSttConfigured, isServerTtsConfigured } from "@/lib/env";
import { isEmailEnabled } from "@/lib/email";
import { purchasablePlans } from "@/lib/stripe";
import { configuredProviders } from "@/lib/providers";
import { providerSupportsWebSearch } from "@/lib/models";
import { isWebSearchConfigured } from "@/lib/web-search";
import { isOwnerEmail } from "@/lib/owner";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
import { AUTO_LOCALE } from "@/lib/i18n";
import type { AppBootstrap, ClientSettings } from "@/types/app";
import type { SessionUser } from "@/lib/session";

export async function getAppBootstrap(user: SessionUser): Promise<AppBootstrap> {
  let settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  if (!settings) {
    await ensureUserDefaults(user.id);
    settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  }

  const [quota, conversations, folders, account] = await Promise.all([
    getQuota(user.id),
    listConversations(user.id),
    prisma.folder.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    // Read name/image from the DB (not the JWT) so profile-picture changes show everywhere.
    prisma.user.findUnique({ where: { id: user.id }, select: { name: true, image: true } }),
  ]);

  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    select: { createdAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  const period = billingPeriodFor(subscription);
  // The settings row is already in hand, so the effective ceiling costs nothing
  // extra here — and passing it to both calls keeps the gate and the meters
  // reading the same number, which is the whole point of there being one.
  const effective = effectiveBudget({
    planBudgetMicroUsd: budgetForPlan(quota.plan),
    userCapEur: settings?.monthlySpendCapEur ?? null,
    capDisabled: settings?.spendCapDisabled ?? false,
    eurPerUsd: eurPerUsd(),
  });
  const [budget, windows] = await Promise.all([
    checkBudget(user.id, quota.plan, period, effective),
    getUsageWindows(user.id, effective.budgetMicroUsd, period),
  ]);

  const clientSettings: ClientSettings = {
    theme: (settings?.theme.toLowerCase() as ClientSettings["theme"]) ?? "system",
    accent: settings?.accent ?? "coral",
    // An account with no settings row yet. Must name a CURRENT model: this is
    // what the picker shows as selected before the user has chosen anything,
    // and it was still pointing at Opus 4.8, two generations superseded.
    defaultModel: settings?.defaultModel ?? "claude-sonnet-5",
    personality: settings?.personality ?? DEFAULT_PERSONALITY,
    customInstructions: settings?.customInstructions ?? "",
    responseLanguage: settings?.responseLanguage ?? "auto",
    uiLocale: settings?.uiLocale ?? AUTO_LOCALE,
    memoryEnabled: settings?.memoryEnabled ?? true,
    voiceId: settings?.voiceId ?? null,
    favoriteModels: settings?.favoriteModels ?? [],
    emailBudgetAlerts: settings?.emailBudgetAlerts ?? true,
    emailWeeklyDigest: settings?.emailWeeklyDigest ?? false,
  };

  return {
    user: { id: user.id, name: account?.name ?? user.name ?? null, email: user.email ?? null, image: account?.image ?? user.image ?? null },
    settings: clientSettings,
    quota,
    spend: {
      spentMicroUsd: budget.spentMicroUsd,
      budgetMicroUsd: budget.budgetMicroUsd,
      eurPerUsd: eurPerUsd(),
      reservedMicroUsd: budget.reservedMicroUsd,
      capSource: budget.capSource,
      capDisabled: budget.capDisabled,
      // The account's own number, so the settings tile can prefill the field
      // with what is stored rather than with the ceiling it resolved to.
      userCapEur: settings?.monthlySpendCapEur ?? null,
      planBudgetMicroUsd: budgetForPlan(quota.plan),
      windows: {
        session: { pct: windows.session.pct, resetsAtMs: windows.session.resetsAtMs },
        weekly: { pct: windows.weekly.pct, resetsAtMs: windows.weekly.resetsAtMs },
      },
      billing: {
        renewsAtMs: budget.resetsAtMs,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      },
    },
    conversations,
    folders,
    features: {
      billing: isStripeConfigured(),
      purchasablePlans: purchasablePlans("month"),
      purchasableAnnualPlans: purchasablePlans("year"),
      serverStt: isServerSttConfigured(),
      serverTts: isServerTtsConfigured(),
      // The voice picker lists OpenAI voices, so it must know which provider is live.
      ttsProvider: isServerTtsConfigured() ? (env.voice.ttsProvider === "elevenlabs" ? "elevenlabs" : "openai") : null,
      storage: isStorageAvailable(),
      webSearch: configuredProviders().some(providerSupportsWebSearch),
      deepResearch: isWebSearchConfigured(),
      email: isEmailEnabled(),
      providers: configuredProviders(),
      isOwner: isOwnerEmail(user.email),
    },
  };
}
