import "server-only";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/auth";
import { listConversations } from "@/lib/queries";
import { getQuota } from "@/lib/usage";
import { checkBudget, eurPerUsd } from "@/lib/spend";
import { isStripeConfigured, isStorageAvailable, isServerSttConfigured, isServerTtsConfigured } from "@/lib/env";
import { configuredProviders } from "@/lib/providers";
import { providerSupportsWebSearch } from "@/lib/models";
import { isOwnerEmail } from "@/lib/owner";
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

  const budget = await checkBudget(user.id, quota.plan);

  const clientSettings: ClientSettings = {
    theme: (settings?.theme.toLowerCase() as ClientSettings["theme"]) ?? "system",
    accent: settings?.accent ?? "coral",
    defaultModel: settings?.defaultModel ?? "claude-opus-4-8",
    customInstructions: settings?.customInstructions ?? "",
    responseLanguage: settings?.responseLanguage ?? "auto",
    memoryEnabled: settings?.memoryEnabled ?? true,
    voiceId: settings?.voiceId ?? null,
    favoriteModels: settings?.favoriteModels ?? [],
  };

  return {
    user: { id: user.id, name: account?.name ?? user.name ?? null, email: user.email ?? null, image: account?.image ?? user.image ?? null },
    settings: clientSettings,
    quota,
    spend: { spentMicroUsd: budget.spentMicroUsd, budgetMicroUsd: budget.budgetMicroUsd, eurPerUsd: eurPerUsd() },
    conversations,
    folders,
    features: {
      billing: isStripeConfigured(),
      voiceServer: isServerSttConfigured() || isServerTtsConfigured(),
      storage: isStorageAvailable(),
      webSearch: configuredProviders().some(providerSupportsWebSearch),
      providers: configuredProviders(),
      isOwner: isOwnerEmail(user.email),
    },
  };
}
