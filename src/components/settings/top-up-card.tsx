"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { formatDate, useFormatLocale } from "@/components/settings/format";
import { formatEur as formatPrice, withVat } from "@/lib/price-display";

interface CreditsResponse {
  availableEur: number;
  nextExpiryMs: number | null;
  canBuy: boolean;
  plan: string;
  packs: Array<{ id: "5" | "20"; htEur: number; creditEur: number }>;
}

/**
 * Usage top-ups: the credit an account holds and the packs it can add.
 *
 * Self-contained (reads /api/billing/credits, posts /api/stripe/topup) so the
 * billing section mounts it with one element. Prices are shown tax included
 * (price-display.ts); the credit a pack adds is model budget, shown as is.
 * Renders nothing when there is nothing to say: no credit and nothing to buy.
 */
export function TopUpCard() {
  const { settings } = useApp();
  const formatAt = useFormatLocale();
  const locale = settings.uiLocale && settings.uiLocale !== "auto" ? settings.uiLocale : "en";
  const [data, setData] = React.useState<CreditsResponse | null>(null);
  const [buying, setBuying] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    fetch("/api/billing/credits")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CreditsResponse | null) => live && setData(d))
      .catch(() => {});
    // Back from a paid checkout: the credit is granted by the webhook, which
    // can land a moment after the redirect.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("topup") === "1") {
      toast.success("Top-up received. It's added as soon as the payment clears.");
    }
    return () => {
      live = false;
    };
  }, []);

  if (!data) return null;
  const hasCredit = data.availableEur > 0;
  if (!hasCredit && data.packs.length === 0) return null;

  const buy = async (pack: "5" | "20") => {
    setBuying(pack);
    const res = await fetch("/api/stripe/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && body.url) {
      window.location.href = body.url;
      return;
    }
    setBuying(null);
    toast.error("Couldn’t start the top-up.", body.message || body.error ? { description: body.message ?? body.error } : undefined);
  };

  return (
    <SettingsGroup
      title="Top-ups"
      description="Extra usage for a month that runs short. It’s used only once your plan’s budget is spent, and lasts twelve months."
    >
      <SettingRow
        label="Credit"
        description={
          hasCredit && data.nextExpiryMs != null ? (
            <>
              <span>Next expiry</span> <span>{formatDate(data.nextExpiryMs, formatAt)}</span>
            </>
          ) : (
            "None yet."
          )
        }
        control={<span className="text-body tabular-nums">{formatPrice(data.availableEur, locale)}</span>}
      />
      {data.canBuy ? (
        data.packs.map((pack) => (
          <SettingRow
            key={pack.id}
            label={
              <span className="tabular-nums">
                {formatPrice(withVat(pack.htEur), locale)} <span className="text-muted-foreground">incl. VAT</span>
              </span>
            }
            description={
              <>
                <span>Adds</span> <span className="tabular-nums">{formatPrice(pack.creditEur, locale)}</span>{" "}
                <span>of usage</span>
              </>
            }
            control={
              <Button
                variant="outline"
                size="sm"
                loading={buying === pack.id}
                disabled={buying != null && buying !== pack.id}
                onClick={() => void buy(pack.id)}
              >
                Add
              </Button>
            }
          />
        ))
      ) : data.plan === "FREE" && data.packs.length > 0 ? (
        <p className="py-4 text-ui text-muted-foreground">
          <span>Top-ups extend a paid plan.</span>{" "}
          <Link href="/upgrade" className="text-foreground underline underline-offset-4">
            See plans
          </Link>
        </p>
      ) : null}
    </SettingsGroup>
  );
}
