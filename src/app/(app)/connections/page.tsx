"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ServerCard, type ConnectorStatus, type ServerState } from "@/components/connections/server-card";
import { ToolLogPanel } from "@/components/connections/tool-log-panel";
import { MOCK_LOG, MOCK_TOOLS, type LogEntry } from "@/lib/mcp-dashboard-fixture";

const ERRORS: Record<string, string> = {
  not_configured: "That connector isn’t set up on this server yet.",
  denied: "Connection was cancelled.",
  bad_state: "Connection couldn’t be verified. Please try again.",
  exchange_failed: "The provider rejected the connection. Please try again.",
  unknown: "Unknown connector.",
};

const ENABLED_KEY = "juno:mcp:enabled";

function Stat({ value, label }: { value: number | null; label: string }) {
  return (
    // Row layout on very narrow screens, stacked columns from 400px up.
    <div className="flex items-baseline justify-between gap-3 min-[400px]:block">
      <p className="font-mono text-[1.75rem] font-medium leading-tight tracking-tight tabular-nums">
        {value === null ? "—" : value}
      </p>
      <p className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground min-[400px]:mt-1 sm:tracking-[0.14em]">
        {label}
      </p>
    </div>
  );
}

export default function ConnectionsPage() {
  const router = useRouter();
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [error, setError] = React.useState(false);
  const [disconnectTarget, setDisconnectTarget] = React.useState<ConnectorStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({});
  const [logEntries, setLogEntries] = React.useState<LogEntry[]>(MOCK_LOG);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/connectors");
      if (!r.ok) throw new Error();
      setConnectors((await r.json()).connectors ?? []);
    } catch {
      setError(true);
      setConnectors([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  // Surface OAuth round-trip results (from the callback redirect), then clean the URL.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const err = params.get("error");
    let settle: ReturnType<typeof setTimeout> | undefined;
    if (connected) {
      toast.success(`Connected ${connected[0].toUpperCase()}${connected.slice(1)}.`);
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

  const appendLog = React.useCallback((entry: LogEntry) => {
    setLogEntries((prev) => [entry, ...prev].slice(0, 50));
  }, []);

  const connect = (c: ConnectorStatus) => {
    setConnectingId(c.id);
    // Full navigation — the OAuth flow redirects off-app and back.
    window.location.href = `/api/connectors/${c.id}/connect`;
  };

  const disconnect = async () => {
    if (!disconnectTarget) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/connectors/${disconnectTarget.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setConnectors(
        (prev) =>
          prev?.map((c) =>
            c.id === disconnectTarget.id ? { ...c, connected: false, accountLabel: null, connectedAt: null } : c
          ) ?? prev
      );
      toast.success(`Disconnected ${disconnectTarget.label}.`);
    } catch {
      toast.error("Couldn’t disconnect. Please try again.");
    } finally {
      setBusy(false);
      setDisconnectTarget(null);
    }
  };

  const stateFor = (c: ConnectorStatus): ServerState =>
    connectingId === c.id ? "connecting" : c.connected ? "active" : c.configured ? "inactive" : "unavailable";

  const loading = connectors === null;
  const connectedList = connectors?.filter((c) => c.connected) ?? [];
  const serversActive = loading ? null : connectedList.length;
  const toolsAvailable = loading
    ? null
    : connectedList.reduce((n, c) => n + (MOCK_TOOLS[c.id as keyof typeof MOCK_TOOLS]?.length ?? 0), 0);
  const labels = React.useMemo(
    () => Object.fromEntries((connectors ?? []).map((c) => [c.id, c.label])),
    [connectors]
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Connections</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">Connect your tools</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Link an app so Juno's models can work with your repositories, designs, docs, and workspace tools.
        </p>

        {/* Mesh-gradient stats strip */}
        <div
          className="mt-6 rounded-lg border border-border/60 p-5 shadow-soft"
          style={{
            background:
              "radial-gradient(90% 150% at 0% 0%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(80% 130% at 100% 15%, hsl(var(--source) / 0.06), transparent 60%)",
          }}
        >
          <div className="grid grid-cols-1 gap-2.5 min-[400px]:grid-cols-3 min-[400px]:gap-2 sm:gap-4">
            <Stat value={serversActive} label="Servers active" />
            <Stat value={toolsAvailable} label="Tools available" />
            <Stat value={logEntries.length} label="Calls today" />
          </div>
        </div>

        {error ? (
          <div className="mt-6 flex flex-wrap items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
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
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/70 p-2 shadow-soft">
                <div className="rounded-2xl border border-border/50 bg-background/60 p-4">
                  <div className="flex items-start gap-3">
                    <div className="skeleton h-11 w-11 rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
                    <div className="flex-1 space-y-2 pt-0.5">
                      <div className="skeleton h-4 w-2/5 rounded-md" style={{ animationDelay: `${i * 60 + 40}ms` }} />
                      <div className="skeleton h-3 w-4/5 rounded-md" style={{ animationDelay: `${i * 60 + 80}ms` }} />
                    </div>
                  </div>
                </div>
                <div className="skeleton h-9 rounded-2xl" style={{ animationDelay: `${i * 60 + 120}ms` }} />
                <div className="skeleton h-14 rounded-2xl" style={{ animationDelay: `${i * 60 + 160}ms` }} />
              </div>
            ))}
          </div>
        ) : connectors!.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-border/60 bg-muted/10 p-10 text-center motion-safe:animate-rise-in">
            <Plug className="mx-auto size-6 text-muted-foreground/50" />
            <p className="mt-3 font-serif text-heading">Nothing to connect</p>
            <p className="mt-1 text-sm text-muted-foreground">No connectors are registered on this server yet.</p>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {connectors!.map((c, i) => (
              <ServerCard
                key={c.id}
                connector={c}
                state={stateFor(c)}
                index={i}
                enabled={enabled[c.id] ?? true}
                onEnabledChange={(value) => setEnabledFor(c.id, value)}
                onConnect={() => connect(c)}
                onDisconnect={() => setDisconnectTarget(c)}
              />
            ))}
          </div>
        )}

        {!error && !loading && (
          <div className="mt-6">
            <ToolLogPanel entries={logEntries} onAppend={appendLog} labels={labels} />
          </div>
        )}

        <p className="mt-6 text-caption text-muted-foreground/70">
          Connected tools are available to the model when you enable them in a chat. Each provider shows the exact permissions during its consent flow.
        </p>
      </div>

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
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
