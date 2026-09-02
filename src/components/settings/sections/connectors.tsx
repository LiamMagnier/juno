"use client";

import * as React from "react";
import Link from "next/link";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectorLogoTile } from "@/components/connections/connector-logos";
import type { ConnectorStatus } from "@/components/connections/types";
import { PermissionsSection } from "@/components/settings/permissions-section";
import { SettingsGroup } from "@/components/settings/setting-row";
import { staggerDelay } from "@/lib/motion";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Connected apps, and what they may do. The directory itself — every
 * connector this server offers, with its connect flow — is `/connections`;
 * this section is the short view: what is linked today, and the policy that
 * governs all of them.
 */
export function ConnectorsSection() {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/connectors");
      if (!r.ok) throw new Error();
      const data = (await r.json()) as { connectors?: ConnectorStatus[] };
      setConnectors(data.connectors ?? []);
    } catch {
      setError(true);
      setConnectors([]);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const connected = (connectors ?? []).filter((c) => c.connected);

  return (
    <>
      <SettingsGroup
        title="Connected apps"
        description="Apps Juno can read from and act on, on your behalf."
        aside={
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/connections">
              <AppIcons.connections className="size-3.5" aria-hidden="true" />
              Manage connections
            </Link>
          </Button>
        }
      >
        <div className="py-3">
          {error ? (
            <EmptyState
              tone="error"
              size="panel"
              title="Couldn't load your connections"
              description="The list didn't come back. Nothing has been disconnected."
              action={
                <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                  Try again
                </Button>
              }
            />
          ) : connectors === null ? (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-field" style={staggerDelay(i, "tight")} />
              ))}
            </div>
          ) : connected.length === 0 ? (
            <EmptyState
              size="panel"
              icon={AppIcons.connections}
              title="Nothing connected yet"
              description="Link GitHub, your calendar, mail or notes and Juno can work inside them."
              action={
                <Button asChild size="sm">
                  <Link href="/connections">Browse connectors</Link>
                </Button>
              }
            />
          ) : (
            <ul className="surface-inset divide-y divide-border/60 rounded-card p-1.5">
              {connected.map((c, i) => (
                <li
                  key={c.id}
                  style={staggerDelay(i, "tight")}
                  className="flex items-center gap-3 rounded-control px-2 py-2 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                >
                  <ConnectorLogoTile id={c.id} className="size-9 rounded-control [&>svg]:size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{c.label}</p>
                    <p className="truncate font-mono text-caption text-muted-foreground">
                      {c.accountLabel ?? c.capability}
                      {c.connectedAt ? ` · since ${formatDate(c.connectedAt)}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="gap-1.5 text-success-ink">
                    <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                    Connected
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsGroup>

      <PermissionsSection index={0} />
    </>
  );
}
