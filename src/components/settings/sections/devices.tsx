"use client";

import * as React from "react";
import Link from "next/link";
import { CodeIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsGroup } from "@/components/settings/setting-row";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkHostRow } from "@/components/work/work-host-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { WORK_POLL_MS, WORK_SYNC_EVENT, fetchWorkHosts } from "@/components/work/work-transport";
import type { ClientWorkHost } from "@/lib/work/serializers";

/**
 * The Macs Juno can reach.
 *
 * This is what the sidebar's "More, Permissions" entry opened: a page whose
 * useful half was this list. It lives with the rest of the account's
 * settings now. Each row still opens `/permissions/<id>`, where the Mac's
 * capabilities are switched and where it can be revoked, because that page
 * owns those writes and a second copy of them here would be a second place
 * to disagree. What Juno always asks before doing, on any Mac under any
 * setting, is one link away.
 *
 * Polling matches /permissions: the shared WORK_POLL_MS interval, the Work
 * sync event and a re-read when the tab comes back, so a Mac waking up shows
 * as awake without a reload.
 */
export function DevicesSection() {
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await fetchWorkHosts();
    if (result.kind === "ok") {
      setHosts(result.value);
      setFailed(false);
      return;
    }
    // `hosts` is left alone: before the first success an empty list and a
    // failed request would be the same picture, and after one, a dropped poll
    // says nothing about the Macs that would justify blanking them.
    setFailed(true);
  }, []);

  React.useEffect(() => {
    void load();
    const tick = () => {
      if (!document.hidden) void load();
    };
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  return <DevicesView hosts={hosts} failed={failed} onRetry={() => void load()} />;
}

/** The Devices section, drawn from data: the dev gallery renders this with fixtures. */
export function DevicesView({
  hosts,
  failed,
  onRetry,
}: {
  hosts: ClientWorkHost[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  // Revoked Macs last, otherwise the route's order (most recently seen first).
  const ordered = React.useMemo(() => {
    const rows = hosts ?? [];
    return [...rows.filter((h) => h.revokedAt === null), ...rows.filter((h) => h.revokedAt !== null)];
  }, [hosts]);

  return (
    <SettingsGroup
      title="Your Macs"
      description="Where a task can reach a folder, an app or your signed-in browser. Open one to choose what it may do, or to revoke it."
    >
      <div className="py-4">
        {failed && hosts === null ? (
          <WorkLoadError onRetry={onRetry}>
            Couldn’t load your Macs. Anything already signed in can still be reached, with the permissions it had.
          </WorkLoadError>
        ) : hosts === null ? (
          <WorkList>
            <WorkRowSkeletons count={2} />
          </WorkList>
        ) : hosts.length === 0 ? (
          <EmptyState
            size="panel"
            icon={CodeIcons.device}
            title="No Macs yet"
            description="Install Juno on your Mac, sign in, and turn on Work in the app. It appears here on its own."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/download">Get the Mac app</Link>
              </Button>
            }
          />
        ) : (
          <WorkList>
            {ordered.map((host) => (
              <WorkHostRow key={host.id} host={host} />
            ))}
          </WorkList>
        )}
        <p className="mt-4 text-ui text-muted-foreground">
          Some actions wait for you on every Mac, whatever it is allowed to do.{" "}
          <Link
            href="/permissions"
            className="rounded-xs text-foreground underline decoration-border underline-offset-4 transition-colors duration-fast ease-out-soft hover:decoration-foreground"
          >
            See what Juno always asks first
          </Link>
        </p>
      </div>
    </SettingsGroup>
  );
}
