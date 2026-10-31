"use client";
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingRow, SettingRowSkeleton, SettingsGroup, SettingsInlineError } from "@/components/settings/setting-row";
import { formatDate, useFormatLocale } from "@/components/settings/format";
import { useSettingsResource } from "@/components/settings/use-settings-resource";
import type { PublicPair } from "@/lib/code-v2/device-pairing";
import { PRODUCT_NAME } from "@/lib/brand/names";

function parse(body: unknown): { pairs: PublicPair[] } {
  const data = body as { pairs?: PublicPair[] };
  if (!Array.isArray(data?.pairs)) throw new Error("Invalid paired devices");
  return { pairs: data.pairs };
}

/**
 * Devices' second half: the Macs THIS BROWSER may drive, and how to reach one
 * from an iPhone.
 *
 * It was a "Remote" section of its own, beside Devices, so two sections
 * listed your Macs (under two names, with two ways to revoke). Devices' own
 * list is the account's Macs, which tasks can reach; this group is the
 * pairings held by this browser alone, so its button says what it undoes:
 * Unpair, not a second "Revoke".
 *
 * Unpairing is destructive, so it reads like every other destructive action
 * in settings: red ink on the row's button, and an in-app dialog with one red
 * button to confirm. The list re-reads when the tab comes back (a Mac paired
 * in another tab shows up), which is what a Refresh button beside "Pair a
 * Mac" used to be for.
 */
export function ThisBrowserGroups() {
  const { data, error, reload } = useSettingsResource("/api/code/pairing/pairs", parse);
  const formatAt = useFormatLocale();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<PublicPair | null>(null);
  // The Mac an unpair failed on, so "Try again" retries THAT (the confirm
  // dialog again) instead of reloading the list, which changes nothing.
  const [failedPair, setFailedPair] = React.useState<PublicPair | null>(null);

  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  async function unpair(pair: PublicPair) {
    setBusy(pair.id);
    setNotice(null);
    setFailedPair(null);
    try {
      const res = await fetch(`/api/code/pairing/pairs/${encodeURIComponent(pair.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn’t unpair this Mac. Try again.");
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn’t unpair this Mac.");
      setFailedPair(pair);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const lastConnected = (pair: PublicPair) => {
    const ms = Date.parse(pair.lastUsedAt);
    return Number.isFinite(ms) ? `Last connected ${formatDate(ms, formatAt)}` : undefined;
  };
  const confirmingName = confirming?.deviceName ?? "this Mac";

  return (
    <>
      <SettingsGroup
        title="This browser"
        description="Macs this browser can control, each paired with a code from the Mac."
        aside={
          <Button size="sm" variant="outline" asChild>
            <Link href="/pair">Pair a Mac</Link>
          </Button>
        }
      >
        {/* A placeholder row, as Your Macs above draws its own: a
            "Loading paired Macs…" line here was a second loading style in
            the same section. */}
        {!data && !error && (
          <div role="status" aria-label="Loading the Macs paired with this browser" className="divide-y divide-border/60">
            <SettingRowSkeleton />
          </div>
        )}
        {data?.pairs.map((pair) => (
          <SettingRow
            key={pair.id}
            label={pair.deviceName ?? "Mac"}
            description={lastConnected(pair)}
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy !== null}
                loading={busy === pair.id}
                onClick={() => setConfirming(pair)}
              >
                Unpair
              </Button>
            }
          />
        ))}
        {data?.pairs.length === 0 && (
          <p className="py-4 text-ui text-muted-foreground">No Macs paired with this browser yet.</p>
        )}
        {(error || notice) && (
          <SettingsInlineError onRetry={failedPair ? () => setConfirming(failedPair) : () => void reload()}>
            {notice ?? "Couldn’t load the Macs paired with this browser."}
          </SettingsInlineError>
        )}
      </SettingsGroup>
      <SettingsGroup title="Your iPhone">
        <SettingRow
          label="Control a Mac from your iPhone"
          description={`On your Mac, open ${PRODUCT_NAME} Settings › Remote, turn on Allow connections, and choose Add, then iPhone. Scan the QR code with your iPhone and approve in ${PRODUCT_NAME}. Hosting, staying awake and the folders a remote session can use are set on the Mac.`}
        />
      </SettingsGroup>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirming(null)}
        busy={busy !== null}
        title={`Unpair ${confirmingName}?`}
        description={`This browser stops controlling ${confirmingName} at once. To use it again, pair it with a new code from the Mac.`}
        confirmLabel="Unpair"
        onConfirm={() => confirming && void unpair(confirming)}
      />
    </>
  );
}
