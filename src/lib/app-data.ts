import "server-only";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/auth";
import { listConversations } from "@/lib/queries";
import { getQuota } from "@/lib/usage";
import { checkBudget, eurPerUsd, getUsageWindows, billingPeriodFor } from "@/lib/spend";
import { env, isStripeConfigured, isStorageAvailable, isServerSttConfigured, isServerTtsConfigured } from "@/lib/env";
import { isEmailEnabled } from "@/lib/email";
import { configuredProviders } from "@/lib/providers";
import { providerSupportsWebSearch } from "@/lib/models";
import { isWebSearchConfigured } from "@/lib/web-search";
import { isOwnerEmail } from "@/lib/owner";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
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
  const period = billingPeriodFor(quota.plan, subscription);
  const [budget, windows] = await Promise.all([
    checkBudget(user.id, quota.plan, period),
    getUsageWindows(user.id, quota.plan, period),
  ]);

  const clientSettings: ClientSettings = {
    theme: (settings?.theme.toLowerCase() as ClientSettings["theme"]) ?? "system",
    accent: settings?.accent ?? "coral",
    defaultModel: settings?.defaultModel ?? "claude-opus-4-8",
    personality: settings?.personality ?? DEFAULT_PERSONALITY,
    customInstructions: settings?.customInstructions ?? "",
    responseLanguage: settings?.responseLanguage ?? "auto",
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
