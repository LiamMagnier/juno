"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/components/app/app-provider";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { formatEur as formatPrice } from "@/lib/price-display";

interface ReferralsResponse {
  code: string;
  link: string;
  rewarded: number;
  pending: number;
  rewardEur: number;
  maxRewards: number;
}

/**
 * Invite a friend: the account's link, and what it has earned.
 *
 * Self-contained (reads /api/referrals) so the billing section mounts it with
 * one element. Both sides get the reward once the invited account's first
 * paid subscription payment goes through. Renders nothing until the link is
 * known, and nothing at all if referrals are unavailable.
 */
export function ReferralCard() {
  const { settings } = useApp();
  const locale = settings.uiLocale && settings.uiLocale !== "auto" ? settings.uiLocale : "en";
  const [data, setData] = React.useState<ReferralsResponse | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    fetch("/api/referrals")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ReferralsResponse | null) => live && setData(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  if (!data) return null;
  const reward = formatPrice(data.rewardEur, locale);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
    } catch {
      toast.error("Couldn’t copy the link.");
    }
  };

  const capped = data.rewarded >= data.maxRewards;

  return (
    <SettingsGroup
      title="Invite a friend"
      description={`When someone you invite starts a paid plan, you each get ${reward} of usage.`}
    >
      <SettingRow
        label="Your link"
        htmlFor="referral-link"
        wide
        control={
          <div className="flex w-full items-center gap-2 @[34rem]/pane:w-auto">
            <Input
              id="referral-link"
              readOnly
              value={data.link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 font-mono text-ui @[34rem]/pane:w-64 @[34rem]/pane:flex-none"
            />
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        }
      />
      <SettingRow
        label="Rewards"
        description={
          capped
            ? `You’ve reached the ${data.maxRewards} rewarded invitations an account can earn.`
            : data.pending > 0
              ? `${data.pending} ${data.pending === 1 ? "person has" : "people have"} joined and not started a paid plan yet.`
              : "Each invitation counts once its first payment goes through."
        }
        control={
          <span className="text-body tabular-nums">
            {data.rewarded} <span className="text-muted-foreground">of {data.maxRewards}</span>
          </span>
        }
      />
    </SettingsGroup>
  );
}
