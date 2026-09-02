"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { useApp } from "@/components/app/app-provider";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PLANS } from "@/lib/plans";
import { describeCapSource, type BudgetCapSource } from "@/lib/spend-ceiling";
import { staggerDelay } from "@/lib/motion";

/** "4 hr 47 min" / "12 min" / "2 days" — time until a rolling window frees up. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.round(h / 24);
    return `${d} day${d > 1 ? "s" : ""}`;
  }
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

/** "Fri 6:59 PM" — the moment a rolling window next frees up, in local time. */
function formatResetMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "May 3, 2026" — an absolute date for billing renewals. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Euro amounts, with enough precision to be believed at the low end. */
function formatEur(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<0,01 €";
  return `${amount.toFixed(2).replace(".", ",")} €`;
}

function Meter({ label, subtitle, pct }: { label: string; subtitle: string; pct: number }) {
  const shown = Math.min(100, Math.round(pct * 100));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-caption text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex min-w-40 flex-1 items-center gap-3">
        <Progress value={shown} tone={pct >= 1 ? "destructive" : pct >= 0.9 ? "warning" : "primary"} aria-label={label} />
        <span className="w-16 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">
          {shown}% used
        </span>
      </div>
    </div>
  );
}

/**
 * The spend ceiling, said out loud. Lowering is the operation offered: the
 * effective ceiling is the MINIMUM of the plan's figure and this one, so a
 * bigger number here buys nothing a plan has not already paid for.
 */
function SpendCeiling({
  ceilingEur,
  storedCapEur,
  capSource,
  capDisabled,
  onSave,
}: {
  ceilingEur: number | null;
  storedCapEur: number | null;
  capSource: BudgetCapSource;
  capDisabled: boolean;
  onSave: (eur: number | null) => Promise<boolean>;
}) {
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
    const ok = await onSave(parsed);
    setSaving(false);
    if (ok) toast.success("Spend ceiling updated.");
  };

  if (capDisabled) {
    return (
      <div role="status" className="rounded-field border border-warning/40 bg-warning/10 p-4">
        <p className="text-sm font-medium text-warning-foreground">Spend ceiling is switched off</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Nothing is capping what this account can spend on models. This is a development escape hatch — turn
          it back on before using the account normally.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <p aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">
        {describeCapSource(capSource)}. Juno stops generating once a billing period reaches this figure.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <Label htmlFor="spend-cap" className="mb-1.5 block text-xs text-muted-foreground">
            Your own ceiling, in euros
          </Label>
          <Input
            id="spend-cap"
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Use the default"
            aria-invalid={!valid}
            aria-describedby="spend-cap-help"
          />
        </div>
        <Button type="submit" disabled={!valid || !dirty || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      <p id="spend-cap-help" className="mt-2 text-caption text-muted-foreground">
        {valid
          ? `Currently ${ceilingEur == null ? "unset" : formatEur(ceilingEur)}. Leave it empty to fall back to the default — the lower of the two always wins.`
          : "Enter a whole number of euros between 0 and 100000."}
      </p>
    </form>
  );
}

export function BillingSection() {
  const router = useRouter();
  const { quota, spend, features } = useApp();
  const plan = PLANS[quota.plan];
  const windows = spend.windows;
  const unlimited = spend.budgetMicroUsd == null;
  const generating = quota.plan !== "FREE" && !spend.capDisabled;

  const [portalLoading, setPortalLoading] = React.useState(false);
  const openPortal = async () => {
    setPortalLoading(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else {
      setPortalLoading(false);
      toast.error(data.error ?? "Could not open billing portal.");
    }
  };

  // Live clock so the rolling-window countdowns tick without a reload. Kept null
  // until mount so SSR and the first client render agree.
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const sessionSubtitle =
    nowMs == null ? "5-hour window" : `Resets in ${formatCountdown(windows.session.resetsAtMs - nowMs)}`;
  const weeklySubtitle =
    nowMs == null ? "7-day window" : `Resets ${formatResetMoment(windows.weekly.resetsAtMs)}`;

  const eurPerUsd = spend.eurPerUsd > 0 ? spend.eurPerUsd : 1;
  const spentEur = (spend.spentMicroUsd / 1_000_000) * eurPerUsd;
  const budgetEur = spend.budgetMicroUsd == null ? null : (spend.budgetMicroUsd / 1_000_000) * eurPerUsd;
  const heldEur = (spend.reservedMicroUsd / 1_000_000) * eurPerUsd;
  const remainingEur = budgetEur == null ? null : Math.max(0, budgetEur - spentEur - heldEur);
  const monthPct = budgetEur && budgetEur > 0 ? Math.min(1, (spentEur + heldEur) / budgetEur) : 0;

  const saveSpendCap = React.useCallback(
    async (monthlySpendCapEur: number | null) => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlySpendCapEur }),
      });
      if (!res.ok) {
        toast.error("Could not save the spend ceiling.");
        return false;
      }
      router.refresh();
      return true;
    },
    [router]
  );

  const renewsAtMs = spend.billing.renewsAtMs;
  const cancelAtPeriodEnd = spend.billing.cancelAtPeriodEnd;

  return (
    <>
      <SettingsGroup title="Plan">
        <div className="surface-raised my-3 rounded-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-heading">{plan.name}</span>
                {generating && (
                  <Badge variant="outline" className="gap-1.5 text-success-ink">
                    <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                    Active
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
              <ul className="mt-3 space-y-1.5">
                {plan.features.slice(0, 3).map((feat, idx) => (
                  <li key={idx} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusIcons.success className="size-3 shrink-0 text-primary" />
                    <span className="truncate">{feat}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {plan.price > 0 ? `${plan.price} € HT/mo` : "Free"}
              </span>
              {features.billing && quota.plan === "FREE" && (
                <Button asChild size="sm">
                  <Link href="/upgrade">Upgrade</Link>
                </Button>
              )}
              {features.billing && quota.plan !== "FREE" && (
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href="/upgrade">Change plan</Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void openPortal()} disabled={portalLoading}>
                    {portalLoading ? "Opening…" : "Manage subscription"}
                  </Button>
                </div>
              )}
            </div>
          </div>
          {renewsAtMs != null && (
            <p className="mt-4 flex items-center gap-1.5 border-t border-border/60 pt-3 text-caption text-muted-foreground">
              <CalendarClock className="size-3.5 opacity-70" aria-hidden="true" />
              {cancelAtPeriodEnd ? "Access ends" : "Renews"} {formatDate(renewsAtMs)}
            </p>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Usage" description="What you have spent this period, and the rolling windows that pace it.">
        <div className="space-y-5 py-3">
          {unlimited ? (
            <div>
              <div className="flex items-center gap-[3.5px] py-1.5" aria-hidden>
                {Array.from({ length: 32 }).map((_, i) => (
                  <span
                    key={i}
                    className="size-[5px] rounded-full bg-primary/75 motion-safe:animate-pulse"
                    style={staggerDelay(i, "tight")}
                  />
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Nothing is metering this account right now.
              </p>
            </div>
          ) : quota.plan === "FREE" ? (
            <p className="text-sm text-muted-foreground">
              Free is a browse-only tier. Upgrade to Pro to start using models.
            </p>
          ) : (
            <>
              {budgetEur != null && (
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-heading tabular-nums">
                      {formatEur(remainingEur ?? 0)}{" "}
                      <span className="text-caption font-normal text-muted-foreground">left this month</span>
                    </span>
                    <span className="font-mono text-caption tabular-nums text-muted-foreground">
                      {formatEur(spentEur)} of {formatEur(budgetEur)}
                    </span>
                  </div>
                  <Progress
                    value={Math.round(monthPct * 100)}
                    tone={monthPct >= 1 ? "destructive" : monthPct >= 0.9 ? "warning" : "primary"}
                    className="mt-2"
                    aria-label="Monthly budget used"
                  />
                </div>
              )}
              <Meter label="Current session" subtitle={sessionSubtitle} pct={windows.session.pct} />
              <Meter label="This week" subtitle={weeklySubtitle} pct={windows.weekly.pct} />
            </>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Spend ceiling">
        <SettingBlock
          label="Monthly spend ceiling"
          aside={
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {budgetEur == null ? "—" : formatEur(budgetEur)}
            </span>
          }
        >
          <SpendCeiling
            ceilingEur={budgetEur}
            storedCapEur={spend.userCapEur}
            capSource={spend.capSource}
            capDisabled={spend.capDisabled}
            onSave={saveSpendCap}
          />
        </SettingBlock>
        {plan.price > 0 && (
          <SettingRow
            label="Invoices and payment method"
            description="Handled by Stripe's billing portal."
            control={
              features.billing ? (
                <Button variant="outline" size="sm" onClick={() => void openPortal()} disabled={portalLoading}>
                  {portalLoading ? "Opening…" : "Open portal"}
                </Button>
              ) : (
                <Badge variant="secondary">Billing off</Badge>
              )
            }
          />
        )}
      </SettingsGroup>
    </>
  );
}
