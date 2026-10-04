import "server-only";
import { NextResponse } from "next/server";
import { effectiveBudget } from "@/lib/spend-ceiling";
import { prisma } from "@/lib/prisma";
import { planFromAccount } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { billingPeriodFor, budgetForPlan, budgetExceededMessage, eurPerUsd } from "@/lib/spend";
import type { TurnUser } from "./types";

/*
 * Pipeline stage 2 — the account a turn is billed to: one account read, one
 * settings read, and everything derived from them (plan, billing period,
 * spend ceiling). Refuses a plan that includes no messages before any model
 * is resolved.
 */

export async function resolveAccount(user: TurnUser) {
  // ONE WAVE, not two. The plan and the settings row are independent lookups —
  // nothing between them reads the other — and awaiting them in turn spent a
  // whole round trip on an ordering nothing needed. Free against a database in
  // the same process; 20-40ms against a hosted one, on the path the reader is
  // watching a spinner on. Same reasoning as the bootstrap's first wave
  // (lib/app-data.ts).
  //
  // Resolve the model: requested → user default → app default, then ensure the
  // provider is configured and the plan allows it, falling back if not.
  // "juno:auto" is a routing sentinel: classify the prompt and pick the cheapest
  // chat model that can handle it (vision / web-search constraints applied).
  const [account, settings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        email: true,
        // Folded in from the durable-submission branch below, which used to
        // read this column on its own.
        emailVerified: true,
        subscription: {
          select: { plan: true, status: true, createdAt: true, currentPeriodEnd: true },
        },
      },
    }),
    prisma.settings.findUnique({ where: { userId: user.id } }),
  ]);

  /*
   * ONE ACCOUNT, ONE SETTINGS ROW, AND EVERYTHING DERIVED FROM THEM.
   *
   * These three values were each resolved by whoever needed them, from their
   * own query, several times per send: the plan through `getUserPlan` (a
   * User+Subscription join), the billing period through `resolveBillingPeriod`
   * (the Subscription again), and the ceiling through `resolveEffectiveBudget`
   * (the Settings row again, a third of whose columns this function already
   * has in hand). `cache()` cut each to once per request, but once per request
   * each is still three round trips for two rows that were already read.
   *
   * Derived here and PASSED DOWN instead — `checkBudget`, `checkUsageWindows`
   * and `reserveSpend` all take `period` and `budget` precisely so a caller
   * that knows them does not make them look again. It is also the only way the
   * gate and the meters are guaranteed to be reading the same numbers, which
   * is the argument lib/app-data.ts makes for doing exactly this in the app
   * bootstrap.
   */
  const subscription = account?.subscription ?? null;
  const plan = planFromAccount(account?.email ?? null, subscription);
  const period = billingPeriodFor(subscription);
  const effective = effectiveBudget({
    planBudgetMicroUsd: budgetForPlan(plan),
    userCapEur: settings?.monthlySpendCapEur ?? null,
    capDisabled: settings?.spendCapDisabled ?? false,
    eurPerUsd: eurPerUsd(),
  });

  // Every model needs a paid plan. A plan that includes no messages is refused
  // here, before model resolution: past this point Auto finds no eligible model
  // and the reader got "No AI model is available for your plan" — a 503 that
  // reads like an outage — or a per-model 403, instead of the paywall.
  if (PLANS[plan].monthlyMessages === 0) {
    return NextResponse.json(
      { error: "budget_exceeded", code: "PLAN_REQUIRED", message: budgetExceededMessage(plan) },
      { status: 402 }
    );
  }

  /*
   * Whether the thought-process panel receives connector ARGUMENTS and RESULTS
   * rather than only the tool's name.
   *
   * Read ONCE, here, before the stream, and passed into the emitter as a
   * boolean. It is never a client-side filter: data that must not be shown is
   * data that must not be SENT.
   *
   * Lockdown is a hard override. It already means "a hard network/tool stop",
   * and it must not be the mode in which Juno gets chattier about what its
   * connectors returned.
   */
  const toolDetailEnabled = !settings?.lockdownMode;

  return { account, settings, plan, period, effective, toolDetailEnabled };
}

export type TurnAccount = Exclude<Awaited<ReturnType<typeof resolveAccount>>, Response>;
export type TurnSettings = TurnAccount["settings"];
