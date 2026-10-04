"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useApp } from "@/components/app/app-provider";
import { useSaveStates, type SaveState } from "@/components/settings/save-status";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { UsageHistory } from "@/components/settings/usage-history";
import { TopUpCard } from "@/components/settings/top-up-card";
import { ReferralCard } from "@/components/settings/referral-card";
import {
  formatCountdown,
  formatDate,
  formatEur,
  formatEurWhole,
  formatResetMoment,
  useFormatLocale,
} from "@/components/settings/format";
import { PLANS } from "@/lib/plans";
import { describeCapSource } from "@/lib/spend-ceiling";
import { PRODUCT_NAME } from "@/lib/brand/names";

function meterTone(share: number) {
  return share >= 1 ? "destructive" : share >= 0.9 ? "warning" : "primary";
}

/** A usage window as a row: what it is and when it frees up, then how full it is. */
function WindowRow({ label, description, share }: { label: string; description: React.ReactNode; share: number }) {
  const shown = Math.min(100, Math.round(share * 100));
  return (
    <SettingRow
      label={label}
      description={description}
      wide
      control={
        <div className="flex w-full items-center gap-3 @[34rem]/pane:w-56">
          <Progress value={shown} tone={meterTone(share)} aria-label={label} className="h-1.5" />
          <span className="w-10 shrink-0 text-right text-ui tabular-nums text-muted-foreground">
            {shown}
            <span>%</span>
          </span>
        </div>
      }
    />
  );
}

/**
 * The plan, what it has left this period, the ceiling on it, and a month of
 * history. "Plan & billing" before, with the account's usage dashboard on a
 * different section under a second group also called "Usage".
 */
export function BillingSection() {
  const router = useRouter();
  const { quota, spend, features } = useApp();
  const saves = useSaveStates();
  const plan = PLANS[quota.plan];
  const formatAt = useFormatLocale();
  const windows = spend.windows;
  const unlimited = spend.budgetMicroUsd == null;
  const generating = quota.plan !== "FREE" && !spend.capDisabled;

  // The Stripe portal holds the subscription, invoices and payment method, so
  // it is one button. There used to be a second row, "Invoices and payment
  // method", with no control, pointing back up at this button.
  const [portalLoading, setPortalLoading] = React.useState(false);
  const openPortal = async () => {
    setPortalLoading(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && data.url) window.location.href = data.url;
    else {
      setPortalLoading(false);
      toast.error("Couldn’t open the billing portal.", data.error ? { description: data.error } : undefined);
    }
  };

  // A live clock so the countdowns tick without a reload. Null until mount
  // so the server render and the first client render agree.
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const eurPerUsd = spend.eurPerUsd > 0 ? spend.eurPerUsd : 1;
  const spentEur = (spend.spentMicroUsd / 1_000_000) * eurPerUsd;
  const budgetEur = spend.budgetMicroUsd == null ? null : (spend.budgetMicroUsd / 1_000_000) * eurPerUsd;
  const heldEur = (spend.reservedMicroUsd / 1_000_000) * eurPerUsd;
  const remainingEur = budgetEur == null ? null : Math.max(0, budgetEur - spentEur - heldEur);
  const monthShare = budgetEur && budgetEur > 0 ? Math.min(1, (spentEur + heldEur) / budgetEur) : 0;

  const saveSpendCap = React.useCallback(
    async (monthlySpendCapEur: number | null) => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlySpendCapEur }),
      }).catch(() => null);
      if (!res?.ok) {
        toast.error("Couldn’t save the spend ceiling.");
        return false;
      }
      router.refresh();
      return true;
    },
    [router]
  );

  const renewsAtMs = spend.billing.renewsAtMs;

  return (
    <>
      <SettingsGroup>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-heading" translate="no">
                {plan.name}
              </p>
              {/* Plain words, not a green "Active" badge (owner directive,
                  2026-09-26): being on the plan you are on is the normal case. */}
              {generating && <span className="text-ui text-muted-foreground">Your plan</span>}
            </div>
            <p className="mt-0.5 text-ui text-muted-foreground">{plan.tagline}</p>
            <p className="mt-2 text-ui text-muted-foreground">
              {plan.price > 0 ? (
                <>
                  <span className="tabular-nums text-foreground">{formatEurWhole(plan.price, formatAt)}</span>{" "}
                  <span>a month, excluding VAT.</span>
                </>
              ) : (
                <span>Free.</span>
              )}
              {renewsAtMs != null && (
                <>
                  {" "}
                  <span>{spend.billing.cancelAtPeriodEnd ? "Access ends" : "Renews"}</span>{" "}
                  <span>{formatDate(renewsAtMs, formatAt)}</span>.
                </>
              )}
            </p>
          </div>
          {features.billing && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {quota.plan === "FREE" ? (
                <Button asChild size="sm">
                  <Link href="/upgrade">Upgrade</Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/upgrade">Change plan</Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void openPortal()} loading={portalLoading}>
                    Manage billing
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Usage">
        {unlimited ? (
          <p className="py-4 text-ui text-muted-foreground">
            {`Nothing is metering this account. A task ${PRODUCT_NAME} starts on its own still stops at a small backstop ceiling, so an unattended loop can’t run all night.`}
          </p>
        ) : quota.plan === "FREE" ? (
          <p className="py-4 text-ui text-muted-foreground">
            <span>The Free plan doesn’t include any messages. Pro unlocks every model and a monthly budget.</span>
          </p>
        ) : (
          <>
            {budgetEur != null && (
              <WindowRow
                label="This month"
                description={
                  <>
                    <span className="tabular-nums">{formatEur(remainingEur ?? 0, formatAt)}</span> <span>left of</span>{" "}
                    <span className="tabular-nums">{formatEur(budgetEur, formatAt)}</span>
                  </>
                }
                share={monthShare}
              />
            )}
            <WindowRow
              label="Current session"
              description={
                nowMs == null ? (
                  "A rolling 5-hour window."
                ) : windows.session.resetsAtMs <= nowMs ? (
                  "Resetting now."
                ) : (
                  <>
                    <span>Resets in</span> <span>{formatCountdown(windows.session.resetsAtMs - nowMs)}</span>
                  </>
                )
              }
              share={windows.session.pct}
            />
            <WindowRow
              label="This week"
              description={
                nowMs == null ? (
                  "A rolling 7-day window."
                ) : windows.weekly.resetsAtMs <= nowMs ? (
                  "Resetting now."
                ) : (
                  <>
                    <span>Resets</span> <span>{formatResetMoment(windows.weekly.resetsAtMs, formatAt)}</span>
                  </>
                )
              }
              share={windows.weekly.pct}
            />
          </>
        )}
      </SettingsGroup>

      {features.billing && <TopUpCard />}
      {features.billing && <ReferralCard />}
      <SettingsGroup title="Spend ceiling">
        {spend.capDisabled ? (
          <p role="status" className="flex items-start gap-2 py-4 text-ui text-warning-foreground">
            <StatusIcons.warning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>
              The spend ceiling is switched off for this account, so nothing caps what it can spend on models. Turn
              it back on before using the account normally.
            </span>
          </p>
        ) : (
          <SpendCeilingRow
            ceilingEur={budgetEur}
            storedCapEur={spend.userCapEur}
            sourceNote={describeCapSource(spend.capSource)}
            status={saves.status("cap")}
            onSave={(eur) => saves.track("cap", () => saveSpendCap(eur))}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="History" description="Replies per day across chat, code and tasks.">
        <UsageHistory eurPerUsd={eurPerUsd} showCost={quota.plan !== "FREE"} />
      </SettingsGroup>
    </>
  );
}

/**
 * The spend ceiling, said out loud. Lowering is the operation offered: the
 * effective ceiling is the MINIMUM of the plan's figure and this one, so a
 * bigger number here buys nothing a plan has not already paid for. Saved
 * with a button rather than on blur, because it decides when Juno stops.
 */
function SpendCeilingRow({
  ceilingEur,
  storedCapEur,
  sourceNote,
  status,
  onSave,
}: {
  ceilingEur: number | null;
  storedCapEur: number | null;
  sourceNote: string;
  status: SaveState;
  onSave: (eur: number | null) => Promise<boolean>;
}) {
  const formatAt = useFormatLocale();
  const [draft, setDraft] = React.useState(storedCapEur == null ? "" : String(storedCapEur));
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    setDraft(storedCapEur == null ? "" : String(storedCapEur));
  }, [storedCapEur]);

  const parsed = draft.trim() === "" ? null : Number(draft);
  const valid = parsed == null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000);
  const dirty = (parsed ?? null) !== (storedCapEur ?? null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !dirty || saving) return;
    setSaving(true);
    await onSave(parsed);
    setSaving(false);
  };

  return (
    <SettingRow
      label="Monthly ceiling"
      htmlFor="spend-cap"
      description={
        valid ? (
          <>
            <span>{sourceNote}.</span>{" "}
            {ceilingEur != null && (
              <>
                <span>{`${PRODUCT_NAME} stops at`}</span> <span className="tabular-nums">{formatEur(ceilingEur, formatAt)}</span>{" "}
                <span>this period. Leave the field empty to use the default; the lower of the two applies.</span>
              </>
            )}
          </>
        ) : (
          <span className="text-destructive-ink">Enter a whole number of euros from 0 to 100,000.</span>
        )
      }
      wide
      status={status}
      control={
        <form onSubmit={submit} className="flex w-full items-center gap-2 @[34rem]/pane:w-auto">
          <Input
            id="spend-cap"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Default"
            aria-invalid={!valid}
            className="min-w-0 flex-1 @[34rem]/pane:w-32 @[34rem]/pane:flex-none"
          />
          <Button type="submit" variant="outline" disabled={!valid || !dirty} loading={saving}>
            Save
          </Button>
        </form>
      }
    />
  );
}
