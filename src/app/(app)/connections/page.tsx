"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Link2Off, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type ConnectorStatus } from "@/components/connections/types";
import { CredentialsDialog } from "@/components/connections/credentials-dialog";
import { ConnectorDirectory, type DirectoryItem } from "@/components/connections/connector-directory";

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
};

const ENABLED_KEY = "juno:mcp:enabled";

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
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [composioConfigured, setComposioConfigured] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [disconnectTarget, setDisconnectTarget] = React.useState<DirectoryItem | null>(null);
  const [credentialsTarget, setCredentialsTarget] = React.useState<ConnectorStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({});

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
      const label = connectorResultLabel(connected);
      toast.success(`${label} is connected and ready to use.`);
      // Brief "Connecting" hold so the pill visibly settles into Active.
      setConnectingId(connected);
      settle = setTimeout(() => setConnectingId(null), 1400);
    }
    if (err) toast.error(ERRORS[err] ?? "Something went wrong connecting.");
    if (connected || err) router.replace("/connections");
    return () => clearTimeout(settle);
  }, [router]);

  // "Expose to chats" toggles — client-side only, persisted per connector.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ENABLED_KEY);
      if (raw) setEnabled(JSON.parse(raw) as Record<string, boolean>);
    } catch {}
  }, []);

  const setEnabledFor = (id: string, value: boolean) => {
    const next = { ...enabled, [id]: value };
    setEnabled(next);
    try {
      window.localStorage.setItem(ENABLED_KEY, JSON.stringify(next));
    } catch {}
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
          : `/api/connectors/${target.id}`;
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
  const connectedCount = connectors?.filter((c) => c.connected).length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Connections</span>
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-display font-medium tracking-tight">Connect your tools</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Link an app so Juno can work with your repositories, designs, docs, and workspace tools.
            </p>
          </div>
          {!loading && !error && connectedCount > 0 && (
            <span className="hidden shrink-0 rounded-full border border-border/60 bg-card/60 px-3 py-1 font-mono text-caption text-muted-foreground shadow-soft sm:inline-block">
              {connectedCount} connected
            </span>
          )}
        </div>

        {error ? (
          <div className="mt-6 flex flex-wrap items-start gap-3 rounded-[16px] border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Couldn’t load your connections.</p>
              <p className="mt-0.5 text-destructive/80">
                The server may still be starting up, or the database isn’t reachable yet.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-[132px] rounded-[16px]" style={{ animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        ) : (
          <ConnectorDirectory
            connectors={connectors ?? []}
            composioConfigured={composioConfigured}
            enabled={enabled}
            onEnabledChange={setEnabledFor}
            onConnectNative={connect}
            onDisconnect={setDisconnectTarget}
            connectingId={connectingId}
          />
        )}

        <p className="mt-8 text-caption text-muted-foreground/70">
          Connected tools are available to the model when you enable them in a chat. Each provider shows the exact permissions during its consent flow.
        </p>
      </div>

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
            <Button
              variant="destructive"
              onClick={disconnect}
              disabled={busy}
              className="group/disconnect gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2Off className="size-4 transition-transform duration-fast ease-out-soft group-hover/disconnect:rotate-6 group-hover/disconnect:scale-105 motion-reduce:transform-none motion-reduce:transition-none" />
              )}
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
