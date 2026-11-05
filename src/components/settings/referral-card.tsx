"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { splitDisplayLink } from "@/components/settings/format";
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
  const { lead, tail } = splitDisplayLink(data.link);

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
      {/* The link as words under the label, not a 256px mono field that cut
          the code (the one part a person recognises) mid-glyph on a phone.
          The scheme goes and nothing is cut: a link too long for the column
          breaks after its path, so the code moves whole onto a second line
          (a host breaks inside only if it alone is wider than the column).
          Truncating the host left "app.alevr.example.co…" and a gap before
          the code. Copy still copies the whole URL. */}
      <SettingRow
        label="Your link"
        description={
          <span className="block min-w-0" translate="no">
            <span className="[overflow-wrap:anywhere]">{lead}</span>
            <wbr />
            <span className="whitespace-nowrap text-foreground">{tail}</span>
          </span>
        }
        control={
          <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy your link"}>
            {copied ? "Copied" : "Copy"}
          </Button>
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
