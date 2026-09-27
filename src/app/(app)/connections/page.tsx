"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Link2Off, Loader2, Plus } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type ConnectorStatus } from "@/components/connections/types";
import { CredentialsDialog } from "@/components/connections/credentials-dialog";
import { ConnectorDirectory, tileAnchor, type DirectoryItem } from "@/components/connections/connector-directory";
import { AddCustomConnectorDialog } from "@/components/connections/add-custom-connector-dialog";
import { CustomConnectorDialog } from "@/components/connections/custom-connector-dialog";
import { beginCustomConnectorSignIn } from "@/components/connections/custom-connector-api";
import { ConnectorTileSkeleton } from "@/components/connections/connector-tile-skeleton";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";

const ERRORS: Record<string, string> = {
  not_configured: "That connector isn’t set up on this server yet.",
  denied: "Connection was cancelled.",
  bad_state: "Connection couldn’t be verified. Please try again.",
  connection_busy: "That app already has a connection change in progress. Please wait a moment and try again.",
  rate_limited: "Too many connection attempts. Please wait a moment and try again.",
  exchange_failed: "The provider rejected the connection. Please try again.",
  // Not retryable: Composio ships no shared OAuth app for this toolkit, so it
  // needs the user's own app credentials added in the Composio dashboard first.
  needs_auth_config:
    "That app has no shared Composio sign-in. Add your own app credentials for it in the Composio dashboard, then connect it here.",
  use_credentials: "That app connects with credentials, not OAuth — use its Connect button here.",
  invalid_credentials: "Apple didn’t accept those credentials. Check the Apple ID and app-specific password.",
  unknown: "Unknown connector.",
  custom_unreachable: "Juno couldn’t start signing in to that server. Check it’s up and try again.",
};

const CONNECTOR_BRAND_LABELS: Record<string, string> = {
  github: "GitHub",
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  google_calendar: "Google Calendar",
  microsoftteams: "Microsoft Teams",
  microsoft_teams: "Microsoft Teams",
};

function connectorResultLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (CONNECTOR_BRAND_LABELS[normalized]) return CONNECTOR_BRAND_LABELS[normalized];
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export default function ConnectionsPage() {
  const router = useRouter();
  const { features } = useApp();
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [composioConfigured, setComposioConfigured] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [disconnectTarget, setDisconnectTarget] = React.useState<DirectoryItem | null>(null);
  const [credentialsTarget, setCredentialsTarget] = React.useState<ConnectorStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  /**
   * "Use in chats" is Settings' per-app block list, the one the approval
   * broker enforces: switching an app off here refuses its tools in every
   * chat, and Settings → Connectors shows the same switch. (It used to be a
   * localStorage flag nothing read.)
   */
  const [blocked, setBlocked] = React.useState<string[]>([]);
  const [addOpen, setAddOpen] = React.useState(false);
  const [manageId, setManageId] = React.useState<string | null>(null);
  const [landedId, setLandedId] = React.useState<string | null>(null);
  const [justConnected, setJustConnected] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/connectors");
      if (!r.ok) throw new Error();
      const data = (await r.json()) as { connectors?: ConnectorStatus[]; composioConfigured?: boolean };
      setConnectors(data.connectors ?? []);
      setComposioConfigured(data.composioConfigured === true);
    } catch {
      setError(true);
      setConnectors([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  React.useEffect(() => {
    window.addEventListener("juno:connections-changed", load);
    return () => window.removeEventListener("juno:connections-changed", load);
  }, [load]);

  // Surface OAuth round-trip results (from the callback redirect), then clean the URL.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const err = params.get("error");
    let settle: ReturnType<typeof setTimeout> | undefined;
    if (connected) {
      // The toast waits for the list: a custom server's id is not its name.
      setJustConnected(connected);
      // Brief "Connecting" hold so the tile visibly settles into Connected.
      setConnectingId(connected);
      settle = setTimeout(() => setConnectingId(null), 1400);
    }
    if (err) toast.error(ERRORS[err] ?? "Something went wrong connecting.");
    if (connected || err) router.replace("/connections");
    return () => clearTimeout(settle);
  }, [router]);

  // Once the list is in: say what connected, by name, and show where it went.
  React.useEffect(() => {
    if (!justConnected || !connectors) return;
    const match = connectors.find((c) => c.id === justConnected);
    const label = match?.label ?? connectorResultLabel(justConnected);
    toast.success(`${label} is connected and ready to use.`);
    setJustConnected(null);
    setLandedId(justConnected);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(tileAnchor(justConnected))?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    });
    const clear = setTimeout(() => setLandedId(null), 2600);
    return () => clearTimeout(clear);
  }, [connectors, justConnected]);

  React.useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { settings?: { blockedConnectors?: string[] } } | null) => {
        if (live && data?.settings?.blockedConnectors) setBlocked(data.settings.blockedConnectors);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const enabled = React.useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const c of connectors ?? []) map[c.id] = !blocked.includes(c.id);
    return map;
  }, [blocked, connectors]);

  const setEnabledFor = async (id: string, value: boolean) => {
    const before = blocked;
    const next = value ? blocked.filter((b) => b !== id) : [...new Set([...blocked, id])];
    setBlocked(next);
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockedConnectors: next }),
      });
      if (!r.ok) throw new Error();
    } catch {
      setBlocked(before);
      toast.error("Couldn’t save that. Try again.");
    }
  };

  const connect = (c: ConnectorStatus) => {
    // Credentials connectors link in-app via a dialog — no OAuth redirect.
    if (c.kind === "credentials") {
      setCredentialsTarget(c);
      return;
    }
    setConnectingId(c.id);
    // Full navigation — the OAuth flow redirects off-app and back.
    window.location.href = `/api/connectors/${c.id}/connect`;
  };

  const credentialsConnected = (c: ConnectorStatus, accountLabel: string | null) => {
    setCredentialsTarget(null);
    setConnectors(
      (prev) =>
        prev?.map((x) =>
          x.id === c.id ? { ...x, connected: true, accountLabel, connectedAt: new Date().toISOString() } : x
        ) ?? prev
    );
    toast.success(`Connected ${c.label}.`);
  };

  // One dialog for both backends — each has its own disconnect endpoint.
  const disconnect = async () => {
    if (!disconnectTarget) return;
    const target = disconnectTarget;
    setBusy(true);
    try {
      const url =
        target.source === "composio"
          ? `/api/connectors/composio/${encodeURIComponent(target.slug!)}`
          : `/api/connectors/${encodeURIComponent(target.id)}`;
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setConnectors(
        (prev) =>
          prev?.map((c) => (c.id === target.id ? { ...c, connected: false, accountLabel: null, connectedAt: null } : c)) ??
          prev
      );
      toast.success(`Disconnected ${target.label}.`);
      // Composio apps live in the directory's own fetched list — refetch both.
      window.dispatchEvent(new CustomEvent("juno:connections-changed"));
    } catch {
      toast.error("Couldn’t disconnect. Please try again.");
    } finally {
      setBusy(false);
      setDisconnectTarget(null);
    }
  };

  const loading = connectors === null;

  return (
    <AppPage measure="wide">
      {/* No count in the header. It carried a "{n} connected" badge directly
          above a toolbar whose "Connected" segment prints the same number —
          and the segment is the control that filters to them, so its copy of
          the integer is the one that earns its place. */}
      <AppPageHeader
        /* No eyebrow: it restated the sidebar row that opens this page, above
           a title that already means the same thing. See the note in
           app/(app)/library/page.tsx — same fix, same rule. */
        heading="Connections"
        lede="Link your repositories, designs and docs so Juno can work with them."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)} className="gap-1.5" aria-haspopup="dialog">
            <Plus className="size-4" />
            Add MCP server
          </Button>
        }
      />

      {error ? (
        <LoadError
          title="Couldn’t load your connections"
          description="Nothing was disconnected. Check your connection and try again."
          onRetry={load}
        />
      ) : loading ? (
        // The toolbar's placeholder too, as loading.tsx draws it: without it
        // the grid dropped 60px the moment the connectors arrived.
        <div role="status" aria-label="Loading connections">
          <div className="mb-6 flex flex-wrap items-center gap-2" aria-hidden="true">
            <Skeleton className="h-9 w-56 rounded-menu" />
            <Skeleton className="h-9 w-72 max-w-full rounded-field" />
          </div>
          <div className="grid gap-4 @[40rem]/page:grid-cols-2 @5xl/page:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <ConnectorTileSkeleton key={i} index={i} />
            ))}
          </div>
        </div>
      ) : (
        <ConnectorDirectory
          connectors={connectors ?? []}
          composioConfigured={composioConfigured}
          canConfigureServer={features.isOwner}
          enabled={enabled}
          onEnabledChange={setEnabledFor}
          onConnectNative={connect}
          onDisconnect={setDisconnectTarget}
          connectingId={connectingId}
          onAddCustom={() => setAddOpen(true)}
          onManageCustom={setManageId}
          onConnectCustom={(id) => {
            setConnectingId(id);
            beginCustomConnectorSignIn(id);
          }}
          landedId={landedId}
        />
      )}

      <p className="mt-8 text-caption text-muted-foreground">
        Connected tools are available to the model when you enable them in a chat, and Juno asks before any tool
        that changes something. Each provider shows the exact permissions during its consent flow.
      </p>

      <AddCustomConnectorDialog open={addOpen} onOpenChange={setAddOpen} />

      <CustomConnectorDialog
        connectorId={manageId}
        onOpenChange={(open) => !open && setManageId(null)}
        onChanged={load}
        onDisconnect={(c) => {
          setManageId(null);
          setDisconnectTarget({
            key: `custom:${c.id}`,
            source: "custom",
            id: c.id,
            label: c.name,
            description: c.host,
            connected: true,
            connecting: false,
            configured: true,
          });
        }}
      />

      <CredentialsDialog
        connector={credentialsTarget}
        onOpenChange={(open) => !open && setCredentialsTarget(null)}
        onConnected={credentialsConnected}
      />

      <Dialog open={!!disconnectTarget} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {disconnectTarget?.label}?</DialogTitle>
            <DialogDescription>
              Juno will lose access to your {disconnectTarget?.label} account. You can reconnect anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisconnectTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2Off className="size-4" />}
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
