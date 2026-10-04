"use client";

import * as React from "react";
import type { Plan } from "@prisma/client";

import { AppProvider } from "@/components/app/app-provider";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { UpgradeView } from "@/components/billing/upgrade-view";
import { CodeUpgradeState } from "@/components/code/code-upgrade-state";
import { BillingSection } from "@/components/settings/sections/billing";
import type { AppBootstrap } from "@/types/app";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 4, 15, 0, 0);
const SELLABLE: Plan[] = ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"];

/** Enforced monthly budgets in micro-USD (spend.ts BUDGET_EUR at 0.92 €/$), for a believable meter. */
const BUDGET_MICRO_USD: Record<Plan, number | null> = {
  FREE: 217_000,
  LITE: 5_430_000,
  PRO: 11_960_000,
  PLUS: 29_890_000,
  MAX: 59_780_000,
  MAX20: 119_570_000,
  ULTRA: 298_910_000,
  OWNER: null,
};

function bootstrapFor(plan: Plan, usedShare: number, billing: boolean): AppBootstrap {
  const budget = BUDGET_MICRO_USD[plan];
  const spent = budget == null ? 0 : Math.round(budget * usedShare);
  return {
    user: { id: "dev-user", name: "Liam", email: "liam@example.com", image: null, username: null },
    settings: {
      theme: "system",
      accent: "coral",
      defaultModel: "anthropic:claude-haiku-4-5",
      personality: "default",
      customInstructions: "",
      responseLanguage: "auto",
      uiLocale: "auto",
      memoryEnabled: true,
      memorySensitiveTopics: [],
      memoryBackgroundLearning: false,
      backgroundProviderMode: "same_provider",
      voiceId: null,
      favoriteModels: [],
      emailBudgetAlerts: false,
      emailWeeklyDigest: false,
    },
    quota: { plan, used: 0, limit: null, remaining: null },
    spend: {
      spentMicroUsd: spent,
      budgetMicroUsd: budget,
      eurPerUsd: 0.92,
      reservedMicroUsd: 0,
      capSource: "plan",
      capDisabled: false,
      userCapEur: null,
      planBudgetMicroUsd: budget,
      windows: {
        session: { pct: usedShare * 0.6, spentMicroUsd: 0, budgetMicroUsd: budget, resetsAtMs: NOW + 3 * 3_600_000 },
        weekly: { pct: usedShare * 0.8, spentMicroUsd: 0, budgetMicroUsd: budget, resetsAtMs: NOW + 2 * DAY_MS },
      },
      billing: { renewsAtMs: plan === "FREE" ? null : NOW + 11 * DAY_MS, cancelAtPeriodEnd: false },
    },
    conversations: [],
    folders: [],
    features: {
      billing,
      purchasablePlans: billing ? SELLABLE : [],
      purchasableAnnualPlans: billing ? SELLABLE : [],
      serverStt: false,
      serverTts: false,
      ttsProvider: null,
      storage: true,
      webSearch: true,
      deepResearch: true,
      email: false,
      providers: ["anthropic", "openai", "google"],
      isOwner: plan === "OWNER",
    },
  };
}

export type PricingView = "upgrade" | "billing" | "code";

export function PricingGallery({
  view,
  plan,
  usedShare,
  billing,
}: {
  view: PricingView;
  plan: Plan;
  usedShare: number;
  billing: boolean;
}) {
  const bootstrap = React.useMemo(() => bootstrapFor(plan, usedShare, billing), [plan, usedShare, billing]);
  return (
    <AppProvider bootstrap={bootstrap}>
      <main className="app-main-canvas min-h-dvh">
        {view === "upgrade" && <UpgradeView currentPlan={plan} features={bootstrap.features} />}
        {view === "code" && <CodeUpgradeState plan={plan} />}
        {view === "billing" && (
          <AppPage measure="reading" scroll={false}>
            <AppPageHeader heading="Usage & billing" />
            <div className="@container/pane">
              <BillingSection />
            </div>
          </AppPage>
        )}
      </main>
    </AppProvider>
  );
}
