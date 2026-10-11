"use client";
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup, SettingsInlineError } from "@/components/settings/setting-row";
import { useSettingsResource } from "@/components/settings/use-settings-resource";
import type { PublicPair } from "@/lib/code-v2/device-pairing";
function parse(body: unknown): { pairs: PublicPair[] } {
  const data = body as { pairs?: PublicPair[] };
  if (!Array.isArray(data?.pairs)) throw new Error("Invalid paired devices");
  return { pairs: data.pairs };
}
export function RemoteSection() {
  const { data, error, reload } = useSettingsResource("/api/code/pairing/pairs", parse);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  async function revoke(pair: PublicPair) {
    if (!window.confirm(`Revoke this browser's access to ${pair.deviceName ?? "this Mac"}?`)) return;
    setBusy(pair.id); setNotice(null);
    try {
      const res = await fetch(`/api/code/pairing/pairs/${encodeURIComponent(pair.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not revoke access. Try again.");
      await reload();
    } catch (e) { setNotice(e instanceof Error ? e.message : "Could not revoke access."); }
    finally { setBusy(null); }
  }
  return <>
    <SettingsGroup title="Macs this browser can control" aside={<><Button size="sm" variant="ghost" onClick={() => void reload()}>Refresh</Button><Button size="sm" asChild><Link href="/pair">Add</Link></Button></>}>
      {!data && !error && <p className="py-4 text-ui text-muted-foreground">Loading paired Macs…</p>}
      {data?.pairs.map(pair => <SettingRow key={pair.id} label={pair.deviceName ?? "Mac"} description={`Last connected ${new Date(pair.lastUsedAt).toLocaleString()}`} control={<Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void revoke(pair)}>{busy === pair.id ? "Revoking…" : "Revoke access"}</Button>} />)}
      {data?.pairs.length === 0 && <p className="py-4 text-ui text-muted-foreground">No paired Macs yet. Choose Add to enter the code shown on your Mac.</p>}
    </SettingsGroup>
    <SettingsGroup title="Connect an iPhone">
      <p className="py-4 text-ui text-muted-foreground">On your Mac, open Alevr Settings › Remote, turn on Allow connections, and choose Add. Select iPhone to show the QR code, then scan it with your iPhone and approve in Alevr.</p>
      <p className="py-4 text-ui text-muted-foreground">Hosting and keeping your Mac awake are controlled on the Mac. Remote sessions use its shared folders and permissions.</p>
    </SettingsGroup>
    {(error || notice) && <SettingsInlineError onRetry={() => void reload()}>{notice ?? "Could not load paired Macs."}</SettingsInlineError>}
  </>;
}
