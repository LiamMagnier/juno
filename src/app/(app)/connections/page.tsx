"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, GitBranch, PenTool, Plug, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ConnectorStatus {
  id: string;
  label: string;
  description: string;
  capability: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: string | null;
}

const ICONS: Record<string, typeof Plug> = { github: GitBranch, figma: PenTool };

const ERRORS: Record<string, string> = {
  not_configured: "That connector isn’t set up on this server yet.",
  denied: "Connection was cancelled.",
  bad_state: "Connection couldn’t be verified. Please try again.",
  exchange_failed: "The provider rejected the connection. Please try again.",
  unknown: "Unknown connector.",
};

export default function ConnectionsPage() {
  const router = useRouter();
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [error, setError] = React.useState(false);
  const [disconnectTarget, setDisconnectTarget] = React.useState<ConnectorStatus | null>(null);
  const [busy, setBusy] = React.useState(false);

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
    if (connected) toast.success(`Connected ${connected[0].toUpperCase()}${connected.slice(1)}.`);
    if (err) toast.error(ERRORS[err] ?? "Something went wrong connecting.");
    if (connected || err) router.replace("/connections");
  }, [router]);

  const disconnect = async () => {
    if (!disconnectTarget) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/connectors/${disconnectTarget.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setConnectors((prev) => prev?.map((c) => (c.id === disconnectTarget.id ? { ...c, connected: false, accountLabel: null } : c)) ?? prev);
      toast.success(`Disconnected ${disconnectTarget.label}.`);
    } catch {
      toast.error("Couldn’t disconnect. Please try again.");
    } finally {
      setBusy(false);
      setDisconnectTarget(null);
    }
  };

  const loading = connectors === null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Connections</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">Connect your tools</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Link an app so Juno’s models can work with your GitHub repositories and Figma designs.
        </p>

        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load your connections.</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : loading ? (
          <div className="mt-6 space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {connectors!.map((c) => {
              const Icon = ICONS[c.id] ?? Plug;
              return (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 shadow-soft"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-background">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{c.label}</p>
                      {c.connected && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-caption font-medium text-primary">
                          <Check className="h-3 w-3" /> Connected
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {c.connected && c.accountLabel ? `Linked as ${c.accountLabel}` : c.capability}
                    </p>
                    {!c.configured && (
                      <p className="mt-1 text-caption text-muted-foreground/70">
                        Needs an OAuth app configured on the server before it can be connected.
                      </p>
                    )}
                  </div>
                  <div className="shrink-0">
                    {c.connected ? (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDisconnectTarget(c)}>
                        <Unplug className="h-3.5 w-3.5" /> Disconnect
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className={cn("gap-1.5", !c.configured && "pointer-events-none opacity-50")}
                        disabled={!c.configured}
                        onClick={() => {
                          // Full navigation — the OAuth flow redirects off-app and back.
                          window.location.href = `/api/connectors/${c.id}/connect`;
                        }}
                      >
                        <Plug className="h-3.5 w-3.5" /> Connect
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-6 text-caption text-muted-foreground/70">
          Connected tools are available to the model when you enable them in a chat. Juno only requests read access.
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
