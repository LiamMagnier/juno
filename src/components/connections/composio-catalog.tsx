"use client";

import * as React from "react";
import { Check, Link2, Link2Off, Loader2, Plug, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CatalogItem {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  noAuth: boolean;
  status: string | null;
  connectedAt: string | null;
}

type Filter = "all" | "connected";

function appLabel(item: Pick<CatalogItem, "name" | "slug">): string {
  const name = item.name.trim();
  if (name) return name;
  return item.slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function ComposioCatalog({ configured }: { configured: boolean }) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [items, setItems] = React.useState<CatalogItem[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(configured);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [action, setAction] = React.useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<CatalogItem | null>(null);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor });
      if (query.trim()) params.set("q", query.trim());
      if (filter === "connected") params.set("connected", "1");
      const response = await fetch(`/api/connectors/composio/catalog?${params}`);
      if (!response.ok) throw new Error("catalog failed");
      const data = (await response.json()) as { items?: CatalogItem[]; cursor?: string };
      setItems((current) => {
        const merged = new Map(current.map((item) => [item.slug, item]));
        (data.items ?? []).forEach((item) => merged.set(item.slug, item));
        return Array.from(merged.values());
      });
      setCursor(data.cursor ?? null);
    } catch {
      toast.error("Couldn’t load more apps.");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filter, loadingMore, query]);

  React.useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (filter === "connected") params.set("connected", "1");
      fetch(`/api/connectors/composio/catalog?${params}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error("catalog failed");
          return response.json() as Promise<{ items?: CatalogItem[]; cursor?: string }>;
        })
        .then((data) => {
          setItems(data.items ?? []);
          setCursor(data.cursor ?? null);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(true);
          setItems([]);
          setCursor(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, query ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [configured, filter, query]);

  const disconnect = async () => {
    const item = disconnectTarget;
    if (!item) return;
    const label = appLabel(item);
    setAction(item.slug);
    try {
      const response = await fetch(`/api/connectors/composio/${encodeURIComponent(item.slug)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("disconnect failed");
      setItems((current) => current.map((entry) => entry.slug === item.slug ? { ...entry, connected: false, connecting: false } : entry));
      setDisconnectTarget(null);
      toast.success(`${label} is disconnected.`);
      window.dispatchEvent(new CustomEvent("juno:connections-changed"));
    } catch {
      toast.error(`Couldn’t disconnect ${label}. Nothing was changed.`);
    } finally {
      setAction(null);
    }
  };

  const connect = (item: CatalogItem) => {
    setAction(item.slug);
    window.location.href = `/api/connectors/composio/${encodeURIComponent(item.slug)}/connect`;
  };

  // The Composio API's remote "connected" filter can include an account that
  // Juno has not activated locally. The Connected view must reflect what the
  // user can actually enable in chat, so apply the local status as the final
  // source of truth in the UI.
  const visibleItems = filter === "connected" ? items.filter((item) => item.connected) : items;

  return (
    <section className="mt-8 overflow-hidden rounded-[24px] border border-border/60 bg-card/55 shadow-soft">
      <div className="border-b border-border/60 bg-card/75 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">App directory</p>
            <h2 className="mt-1 font-serif text-title">Connect the apps you use</h2>
            <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              Every app connects separately. Juno only receives access to the apps you choose.
            </p>
          </div>
          <label className="relative block w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Gmail, Slack, Linear…"
              aria-label="Search apps"
              disabled={!configured}
              className="h-10 rounded-[13px] bg-background/75 pl-9"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-1 rounded-[11px] bg-muted/55 p-1 w-fit">
          {(["all", "connected"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              disabled={!configured}
              className={cn(
                "rounded-[8px] px-3 py-1.5 text-xs font-medium capitalize text-muted-foreground transition-colors",
                filter === value && "bg-background text-foreground shadow-soft"
              )}
            >
              {value === "all" ? "All apps" : "Connected"}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 sm:p-4">
        {!configured ? (
          <div className="rounded-[16px] border border-dashed border-border/70 p-8 text-center">
            <Plug className="mx-auto size-5 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">The app directory is not active yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              App connections have not been enabled on this Juno workspace yet.
            </p>
          </div>
        ) : error ? (
          <div className="rounded-[16px] border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
            The app directory could not be loaded. Check the server key and try again.
          </div>
        ) : loading ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 12 }, (_, index) => (
              <div key={index} className="skeleton h-[88px] rounded-[16px]" style={{ animationDelay: `${index * 30}ms` }} />
            ))}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
            {filter === "connected"
              ? query.trim()
                ? `No connected apps match “${query.trim()}”.`
                : "No connected apps yet."
              : query.trim()
                ? `No apps match “${query.trim()}”.`
                : "No apps are available right now."}
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item) => {
              const busy = action === item.slug || item.connecting;
              const label = appLabel(item);
              return (
                <article
                  key={item.slug}
                  className={cn(
                    "flex min-h-[88px] items-center gap-3 rounded-[16px] border bg-background/55 p-3 transition-colors",
                    item.connected ? "border-success/25 bg-success/[0.035]" : "border-border/55 hover:border-primary/30 hover:bg-background/85"
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-border/60 bg-card shadow-soft">
                    {item.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.logo} alt="" className="size-7 object-contain" loading="lazy" />
                    ) : (
                      <Plug className="size-4 text-primary" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-sm font-semibold">{label}</h3>
                      {item.connected && <Check className="size-3.5 shrink-0 text-success" aria-label="Connected" />}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.connected
                        ? "Connected and ready"
                        : item.connecting
                          ? "Finishing connection…"
                          : item.noAuth
                            ? "Ready without sign-in"
                            : "Available to connect"}
                    </p>
                  </div>
                  {item.connected ? (
                    <button
                      type="button"
                      onClick={() => setDisconnectTarget(item)}
                      disabled={busy}
                      aria-label={`Disconnect ${label}`}
                      aria-haspopup="dialog"
                      className="group/disconnect pressable danger-hover inline-flex size-10 shrink-0 items-center justify-center rounded-[11px] text-muted-foreground disabled:opacity-50 coarse:size-11"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Link2Off className="size-4 transition-transform duration-fast ease-out-soft group-hover/disconnect:rotate-6 group-hover/disconnect:scale-105 motion-reduce:transform-none motion-reduce:transition-none" />
                      )}
                    </button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => connect(item)}
                      className="group/connect h-8 shrink-0 gap-1.5 rounded-[10px] px-2.5 text-xs"
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Link2 className="size-3.5 transition-transform duration-fast ease-out-soft group-hover/connect:-rotate-6 group-hover/connect:scale-105 motion-reduce:transform-none motion-reduce:transition-none" />
                      )}
                      Connect
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {cursor && !loading && !error && (
          <div className="flex justify-center pt-4">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-[11px]">
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              Load more apps
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={!!disconnectTarget}
        onOpenChange={(open) => {
          if (!open && !action) setDisconnectTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {disconnectTarget ? appLabel(disconnectTarget) : "this app"}?</DialogTitle>
            <DialogDescription>
              Juno will no longer be able to use this app in chats. You can reconnect it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisconnectTarget(null)} disabled={!!action}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void disconnect()}
              disabled={!!action}
              className="group/disconnect gap-1.5"
            >
              {action ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2Off className="size-4 transition-transform duration-fast ease-out-soft group-hover/disconnect:rotate-6 group-hover/disconnect:scale-105 motion-reduce:transform-none motion-reduce:transition-none" />
              )}
              {action ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
