import "server-only";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/auth";
import { listConversations } from "@/lib/queries";
import { getQuota, planFromAccount } from "@/lib/usage";
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
import {
  normalizeBackgroundProviderPolicy,
  type BackgroundProviderMode,
} from "@/lib/background-provider-policy";
import type { AppBootstrap, ClientSettings } from "@/types/app";
import type { SessionUser } from "@/lib/session";

export async function getAppBootstrap(user: SessionUser): Promise<AppBootstrap> {
  /*
   * The settings row rides in the SAME WAVE as the account, not ahead of it.
   *
   * These are two independent single-row lookups and they were awaited one
   * after the other, so the bootstrap was four serial waves deep (settings →
   * account → list wave → spend wave) where three will do. At 20-40ms a round
   * trip on a hosted database that is a whole wave of latency spent on
   * ordering that nothing needed.
   *
   * The `ensureUserDefaults` re-read stays serial and stays rare: it only runs
   * for an account that has no settings row yet, which is once in its life.
   */

  /*
   * ONE READ OF THE ACCOUNT, not three.
   *
   * This block used to issue three separate queries for one user: `getQuota`
   * called `getUserPlan`, which reads User joined to Subscription; then a
   * second `user.findUnique` for name/image; then a third round trip for the
   * Subscription row again, SEQUENTIALLY, after the Promise.all had already
   * settled. Measured on a warm local build, a single navigation to /chat
   * issued 20 SQL round trips, and these were three of them.
   *
   * On a database in the same process that is free, which is why it survived.
   * On a hosted one at 20-40ms per round trip it is most of the answer to
   * "switching modes is slow" — and the sequential subscription read was the
   * worst of the three, because a serial query costs its latency in full while
   * parallel ones overlap.
   *
   * So: one query that carries name, image, email and the subscription, and
   * the plan derived from what is already in hand rather than re-read.
   * `getUserPlan` is `cache()`d as well (usage.ts), which covers the callers
   * further down that legitimately cannot be handed a plan.
   */
  const [settings0, account] = await Promise.all([
    prisma.settings.findUnique({ where: { userId: user.id } }),
    prisma.user.findUnique({
    where: { id: user.id },
    select: {
      // From the DB, not the JWT, so a profile-picture change shows everywhere.
      name: true,
      image: true,
      email: true,
      subscription: {
        select: { plan: true, status: true, createdAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
      },
    },
    }),
  ]);

  let settings = settings0;
  if (!settings) {
    await ensureUserDefaults(user.id);
    settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  }

  const subscription = account?.subscription ?? null;
  const plan = planFromAccount(account?.email ?? null, subscription);

  const [quota, conversations, folders] = await Promise.all([
    // The plan is passed, so `getQuota` does not re-derive it — that is the
    // User+Subscription join above, a second time.
    getQuota(user.id, plan),
    listConversations(user.id),
    prisma.folder.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
  ]);

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
    // `reap: false` — the bootstrap is a READ that paints two meters, and the
    // reservation sweep it used to trigger is a findMany plus a serial loop of
    // write transactions on every single page render. The sweep stays on the
    // paths that are about to spend; the argument is on the option itself.
    checkBudget(user.id, quota.plan, period, effective, { reap: false }),
    getUsageWindows(user.id, effective.budgetMicroUsd, period),
  ]);

  const clientSettings: ClientSettings = {
    theme: (settings?.theme.toLowerCase() as ClientSettings["theme"]) ?? "system",
    accent: settings?.accent ?? "coral",
    // An account with no settings row yet. Must name a CURRENT model: this is
    // what the picker shows as selected before the user has chosen anything,
    // and it was still pointing at Opus 4.8, two generations superseded.
    defaultModel: settings?.defaultModel ?? "qwen:qwen3.6-flash",
    personality: settings?.personality ?? DEFAULT_PERSONALITY,
    customInstructions: settings?.customInstructions ?? "",
    responseLanguage: settings?.responseLanguage ?? "auto",
    uiLocale: settings?.uiLocale ?? AUTO_LOCALE,
    memoryEnabled: settings?.memoryEnabled ?? true,
    // Read through the normalizer rather than cast: the column is TEXT, and a
    // value this build does not recognise must show as the safe mode rather
    // than as a blank control the user cannot reason about.
    backgroundProviderMode: normalizeBackgroundProviderPolicy({
      mode: settings?.backgroundProviderMode as BackgroundProviderMode,
    }).mode,
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
        // Spend and budget as well as the percentage: `runLimitFrom` has to
        // name the binding window by the same rule the gate uses, which is
        // absolute room left rather than percentage used.
        session: {
          pct: windows.session.pct,
          spentMicroUsd: windows.session.spentMicroUsd,
          budgetMicroUsd: windows.session.budgetMicroUsd,
          resetsAtMs: windows.session.resetsAtMs,
        },
        weekly: {
          pct: windows.weekly.pct,
          spentMicroUsd: windows.weekly.spentMicroUsd,
          budgetMicroUsd: windows.weekly.budgetMicroUsd,
          resetsAtMs: windows.weekly.resetsAtMs,
        },
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
