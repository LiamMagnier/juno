"use client";

import * as React from "react";
import { ChevronDown, Clock, Plug, RefreshCw, ShieldCheck, Unplug, User, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { ConnectorLogoTile } from "@/components/connections/connector-logos";
import { MOCK_TOOLS } from "@/lib/mcp-dashboard-fixture";
import { cn } from "@/lib/utils";

export interface ConnectorStatus {
  id: string;
  kind: string;
  label: string;
  description: string;
  capability: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: string | null;
}

export type ServerState = "active" | "connecting" | "inactive" | "unavailable";

function StatusPill({ state }: { state: ServerState }) {
  if (state === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-caption font-medium text-success">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-success/70 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
        </span>
        Active
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-caption font-medium text-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse" />
        Connecting
      </span>
    );
  }
  if (state === "inactive") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-caption font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        Inactive
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2 py-0.5 text-caption font-medium text-muted-foreground/70">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      Unavailable
    </span>
  );
}

/** Deterministic per-server sync anchor (seconds) so SSR and hydration agree. */
function syncSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return 12 + (h % 48);
}

function formatSynced(sec: number): string {
  return sec < 90 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
}

export function ServerCard({
  connector,
  state,
  index,
  enabled,
  onEnabledChange,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorStatus;
  state: ServerState;
  index: number;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const tools = MOCK_TOOLS[connector.id as keyof typeof MOCK_TOOLS] ?? [];
  const connected = connector.connected;

  // Mock "Synced Ns ago" ticker — counts up from a per-server anchor; refresh resets it.
  const [syncedSec, setSyncedSec] = React.useState(() => syncSeed(connector.id));
  const [resyncing, setResyncing] = React.useState(false);
  const anchorRef = React.useRef<number | null>(null);
  const resyncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!connected) return;
    anchorRef.current ??= Date.now() - syncSeed(connector.id) * 1000;
    const t = setInterval(() => {
      if (anchorRef.current != null) setSyncedSec(Math.max(0, Math.round((Date.now() - anchorRef.current) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [connected, connector.id]);

  const resync = () => {
    if (resyncing) return;
    setResyncing(true);
    resyncTimer.current = setTimeout(() => {
      anchorRef.current = Date.now();
      setSyncedSec(0);
      setResyncing(false);
    }, 800);
  };

  // Tools expander — fake fetch shimmer on the first open only; open state is per-card.
  // Content stays mounted after the first open so the height collapse can animate.
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [toolsMounted, setToolsMounted] = React.useState(false);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const toolsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleTools = () => {
    if (!toolsOpen && !toolsMounted) {
      setToolsMounted(true);
      setToolsLoading(true);
      toolsTimer.current = setTimeout(() => setToolsLoading(false), 600);
    }
    setToolsOpen((v) => !v);
  };

  React.useEffect(
    () => () => {
      if (resyncTimer.current) clearTimeout(resyncTimer.current);
      if (toolsTimer.current) clearTimeout(toolsTimer.current);
    },
    []
  );

  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/70 p-2 shadow-soft backdrop-blur-sm transition-[transform,box-shadow] duration-base ease-out-soft hover:-translate-y-0.5 hover:shadow-float motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      {/* Identity + status */}
      <div className="rounded-2xl border border-border/50 bg-background/60 p-4">
        <div className="flex items-start gap-3">
          <ConnectorLogoTile id={connector.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-serif text-heading font-semibold">{connector.label}</h2>
              <StatusPill state={state} />
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{connector.description}</p>
            {state === "unavailable" && (
              <p className="mt-1.5 text-caption text-muted-foreground/70">
                {connector.kind === "credentials"
                  ? "Needs Apple developer keys configured on the server before it can be connected."
                  : "Needs an OAuth app configured on the server before it can be connected."}
              </p>
            )}
          </div>
        </div>

        {connected && (
          <>
            <DottedDivider className="my-3" />
            <div className="grid gap-x-4 gap-y-2 text-caption text-muted-foreground sm:grid-cols-2">
              {connector.accountLabel && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <User className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="truncate font-mono text-[11px]">{connector.accountLabel}</span>
                </span>
              )}
              {connector.connectedAt && (
                <span className="flex items-center gap-1.5">
                  <Clock className="size-3.5 shrink-0 text-muted-foreground/70" />
                  Connected <span className="font-mono text-[11px]">{timeAgo(connector.connectedAt)}</span>
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={resync}
                  disabled={resyncing}
                  aria-label={`Resync ${connector.label}`}
                  className="pressable flex size-6 shrink-0 items-center justify-center rounded-md border bg-background/60 text-muted-foreground hover:text-foreground coarse:h-11 coarse:w-11"
                >
                  <RefreshCw className={cn("size-3", resyncing && "animate-spin")} />
                </button>
                <span className="font-mono text-[11px]">{resyncing ? "Syncing…" : `Synced ${formatSynced(syncedSec)}`}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 shrink-0 text-success" />
                {connector.kind === "credentials"
                  ? connector.id === "apple-music"
                    ? "User token · encrypted at rest"
                    : "App password · encrypted at rest"
                  : "OAuth · token healthy"}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Tools */}
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-muted/20">
        <button
          type="button"
          aria-expanded={toolsOpen}
          onClick={toggleTools}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-muted/40"
        >
          <Wrench className="size-3.5 text-primary" />
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Tools</span>
          <span className="font-mono text-[10.5px] text-muted-foreground/60">{tools.length}</span>
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft",
              toolsOpen && "rotate-180"
            )}
          />
        </button>
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-base ease-out-soft",
            toolsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="min-h-0 overflow-hidden" inert={!toolsOpen}>
            {toolsMounted && (
              <div className="border-t border-border/50 bg-background/40 p-2">
                {toolsLoading ? (
                  <div className="flex flex-col gap-1.5 p-1">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="skeleton h-8 rounded-md" style={{ animationDelay: `${i * 60}ms` }} />
                    ))}
                  </div>
                ) : (
                  <ul className="flex flex-col">
                    {tools.map((tool, i) => (
                      <li
                        key={tool.name}
                        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-muted/40 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                        style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-[12px] text-foreground/90">{tool.name}</p>
                          <p className="truncate text-caption text-muted-foreground">{tool.description}</p>
                        </div>
                        <span className="inline-flex shrink-0 items-center rounded-full border bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {tool.paramCount} {tool.paramCount === 1 ? "param" : "params"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expose switch + real connect/disconnect flows */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/50 bg-muted/20 px-4 py-3">
        <div className={cn("flex items-center gap-2.5", !connected && "opacity-50")}>
          <Switch
            checked={connected ? enabled : false}
            disabled={!connected}
            onCheckedChange={onEnabledChange}
            aria-label={`Expose ${connector.label} tools to chats`}
          />
          <span className="text-sm text-foreground/85">Expose to chats</span>
        </div>
        {connected ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onDisconnect}>
            <Unplug className="h-3.5 w-3.5" /> Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!connector.configured || state === "connecting"}
            onClick={onConnect}
          >
            <Plug className="h-3.5 w-3.5" /> {state === "connecting" ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>
    </article>
  );
}
