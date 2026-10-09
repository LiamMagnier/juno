"use client";

/**
 * Settings › Connections, subscriptions half: finds the user's Mac, reaches
 * its env server (device link), and shows what it reports. The API keys group
 * below it stays the models lane's (it carries 30-day usage).
 */
import "./code-v2.css";
import * as React from "react";
import { ConnectionsPanel } from "./connections";
import { useEnvLink } from "./use-env-link";
import { fallbackSetupCommand } from "@/lib/code-v2/providers-view";
import type { DeviceInfo } from "./types";

interface DeviceRow {
  id: string;
  name: string;
  online?: boolean;
  lastSeenAt: string;
}

export function SubscriptionConnections() {
  const [device, setDevice] = React.useState<DeviceInfo | null>(null);
  React.useEffect(() => {
    fetch("/api/code/devices")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { devices?: DeviceRow[] } | null) => {
        const list = (b?.devices ?? []).sort((a, z) => Number(!!z.online) - Number(!!a.online) || z.lastSeenAt.localeCompare(a.lastSeenAt));
        const d = list[0];
        if (d) setDevice({ id: d.id, name: d.name, online: !!d.online, lastSeenAt: d.lastSeenAt });
      })
      .catch(() => undefined);
  }, []);
  const env = useEnvLink(device ? { id: device.id, online: device.online } : null, null);
  return (
    <ConnectionsPanel
      embedded
      showKeys={false}
      instances={env.instances}
      device={device ? { ...device, online: device.online && env.ready } : null}
      onProbe={env.ready ? env.probe : undefined}
      onSetup={async (instance, action) => {
        let command: string | null = null;
        try {
          command = (await env.client?.request("provider.setup", { instanceId: instance.id, action }))?.step?.command ?? null;
        } catch {
          command = null;
        }
        command ??= fallbackSetupCommand(instance, action);
        if (!command) throw new Error("Run the vendor's own setup on your Mac, then press Re-check.");
        // Settings has no terminal pane: say the command; the Code workspace opens one with it typed in.
        return `Run ${command} in Terminal on ${device?.name ?? "your Mac"}, then Re-check. In a Code session, Alevr opens a terminal with it typed in.`;
      }}
    />
  );
}
