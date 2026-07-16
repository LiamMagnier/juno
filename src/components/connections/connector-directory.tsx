"use client";

import * as React from "react";
import { ArrowUpRight, Loader2, Plug, Search, Sparkles, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectorMark } from "@/components/connections/connector-logos";
import type { ConnectorStatus } from "@/components/connections/server-card";
import { cn } from "@/lib/utils";

/**
 * ONE directory for every tool Juno can connect to.
 *
 * Juno has two connector backends — a handful of native integrations (their own
 * OAuth/credential flow and MCP route) and Composio's managed catalog of
 * hundreds of apps. They used to be rendered as two disconnected sections
 * ("Built into Juno" plus a separate, usually-empty "App directory"), which made
 * the page look broken whenever Composio wasn't configured and forced the user
 * to understand an implementation detail to find an app.
 *
 * Here they are one searchable list. Where both backends offer the same app
 * (GitHub, Figma, Notion), the native connector wins and the Composio duplicate
 * is dropped — see NATIVE_EQUIVALENT.
 */

interface CatalogItem {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  noAuth: boolean;
  /** False = Composio hosts no OAuth app for it; Connect cannot work yet. */
  managedAuth: boolean;
  status: string | null;
  connectedAt: string | null;
}

interface Category {
  id: string;
  label: string;
  count?: number;
}

interface CatalogResponse {
  items?: CatalogItem[];
  cursor?: string;
  categories?: Category[];
}

export interface DirectoryItem {
  key: string;
  source: "native" | "composio";
  /** Connector id ("github") or composio app id ("composio:gmail"). */
  id: string;
  slug?: string;
  label: string;
  description: string;
  logo?: string | null;
  connected: boolean;
  connecting: boolean;
  /** Native only: false when the server is missing this connector's OAuth app. */
  configured: boolean;
  noAuth?: boolean;
  /** Composio only: false = no managed OAuth app, so Connect 400s until an auth
   *  config is created in the Composio dashboard. Native connectors are always
   *  true — their auth is Juno's own. */
  managedAuth?: boolean;
  accountLabel?: string | null;
}

type Filter = "all" | "connected";

/**
 * Composio toolkit slugs that duplicate a native Juno connector. The native one
 * is preferred: it has a dedicated MCP endpoint and a richer permission flow.
 */
const NATIVE_EQUIVALENT: Record<string, string> = {
  github: "github",
  figma: "figma",
  notion: "notion",
};

/**
 * Native connectors carry no Composio categories, so without this they would
 * vanish the moment any category is picked — including Notion under
 * "Productivity", the one place a user would most expect to find it. Ids match
 * the curated set in src/lib/composio.ts.
 */
const NATIVE_CATEGORIES: Record<string, string[]> = {
  github: ["developer-tools"],
  figma: ["images-&-design"],
  notion: ["productivity", "documents"],
  "apple-calendar": ["calendar"],
  "apple-mail": ["email"],
  "apple-music": ["video-&-audio"],
};

function titleize(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function appLabel(item: Pick<CatalogItem, "name" | "slug">): string {
  return item.name.trim() || titleize(item.slug);
}

function AppLogo({ item }: { item: DirectoryItem }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-card shadow-soft">
      {item.source === "native" ? (
        <ConnectorMark id={item.id} className="size-5" />
      ) : item.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.logo} alt="" className="size-6 object-contain" loading="lazy" />
      ) : (
        <Plug className="size-4 text-primary" />
      )}
    </span>
  );
}

function CategoryChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pressable shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out-soft",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border/55 bg-background/55 text-muted-foreground hover:border-border hover:text-foreground hover:shadow-soft motion-safe:hover:-translate-y-px"
      )}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">{count}</span>
      )}
    </button>
  );
}

type TileState = "connected" | "connecting" | "available" | "setup" | "unavailable";

/** Status pill echoing the connector's state, keyed off the shared theme tokens. */
function TileStatus({ state }: { state: TileState }) {
  if (state === "connected") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-caption font-medium text-success">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-success/70 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
        </span>
        Connected
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-caption font-medium text-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse" />
        Connecting
      </span>
    );
  }
  if (state === "setup") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-caption font-medium text-muted-foreground">
        Setup needed
      </span>
    );
  }
  if (state === "unavailable") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2 py-0.5 text-caption font-medium text-muted-foreground/70">
        Unavailable
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-caption font-medium text-muted-foreground/80">
      <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/40" />
      Available
    </span>
  );
}

function ConnectorTile({
  item,
  busy,
  enabled,
  onEnabledChange,
  onConnect,
  onDisconnect,
}: {
  item: DirectoryItem;
  busy: boolean;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const unavailable = !item.configured;
  // Composio hosts no OAuth app for this toolkit (verified live: e.g. twitter),
  // so authorize() 400s with "Composio does not manage auth for toolkit …".
  // Rendering a Connect button here bounced the user straight back to this page
  // with a generic error — indistinguishable from a reload, and "try again"
  // could never work. Say what is actually required instead.
  const needsSetup = item.source === "composio" && item.managedAuth === false && !item.connected;
  const state: TileState = item.connected
    ? "connected"
    : item.connecting
      ? "connecting"
      : unavailable
        ? "unavailable"
        : needsSetup
          ? "setup"
          : "available";

  const description = item.connected
    ? item.accountLabel && item.accountLabel !== item.label
      ? item.accountLabel
      : "Connected and ready"
    : item.connecting
      ? "Finishing connection…"
      : unavailable
        ? "Not set up on this server"
        : needsSetup
          ? "Needs its own OAuth app in Composio"
          : item.noAuth
            ? "Ready without sign-in"
            : item.description;

  return (
    <article
      className={cn(
        // Canonical card: 16px radius, hairline border, card fill, soft shadow,
        // with the shared lift-on-hover treatment used across the app.
        "group flex flex-col justify-between gap-3 rounded-[16px] border bg-card p-4 shadow-soft transition-all duration-base ease-out-soft",
        item.connected
          ? "border-success/30"
          : unavailable
            ? "border-border/60 bg-card/60"
            : "border-border/70 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-float"
      )}
    >
      <div className="flex items-start gap-3">
        <AppLogo item={item} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight">{item.label}</h3>
          <p className="mt-1 line-clamp-2 text-caption leading-4 text-muted-foreground">{description}</p>
        </div>
        <TileStatus state={state} />
      </div>

      {item.connected ? (
        <div className="flex items-center justify-between gap-2">
          {/* Only a linked app can be exposed to chats. */}
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={`Expose ${item.label} to chats`} />
            <span className="text-caption text-muted-foreground">In chats</span>
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            disabled={busy}
            aria-haspopup="dialog"
            className="gap-1.5 px-2.5 text-muted-foreground hover:text-destructive"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
            Disconnect
          </Button>
        </div>
      ) : needsSetup ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" size="sm" className="w-full gap-1.5">
              <a
                href={`https://platform.composio.dev/marketplace/${encodeURIComponent(item.slug ?? "")}`}
                target="_blank"
                rel="noreferrer"
              >
                Set up in Composio
                <ArrowUpRight className="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[240px]">
            Composio has no shared OAuth app for {item.label}. Add your own {item.label} app credentials in the Composio
            dashboard, then connect it here.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || unavailable}
          onClick={onConnect}
          className="w-full"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Connect"}
        </Button>
      )}
    </article>
  );
}

export function ConnectorDirectory({
  connectors,
  composioConfigured,
  enabled,
  onEnabledChange,
  onConnectNative,
  onDisconnect,
  connectingId,
}: {
  connectors: ConnectorStatus[];
  composioConfigured: boolean;
  enabled: Record<string, boolean>;
  onEnabledChange: (id: string, v: boolean) => void;
  onConnectNative: (c: ConnectorStatus) => void;
  onDisconnect: (item: DirectoryItem) => void;
  connectingId: string | null;
}) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [category, setCategory] = React.useState<string | null>(null);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [apps, setApps] = React.useState<CatalogItem[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(composioConfigured);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [busySlug, setBusySlug] = React.useState<string | null>(null);

  // Native connectors are a fixed, tiny set — filter them in the client so the
  // search box covers both backends with one keystroke.
  const nativeItems = React.useMemo<DirectoryItem[]>(
    () =>
      connectors
        .filter((c) => c.kind !== "composio_app")
        .map((c) => ({
          key: `native:${c.id}`,
          source: "native" as const,
          id: c.id,
          label: c.label,
          description: c.description,
          connected: c.connected,
          connecting: connectingId === c.id,
          configured: c.configured,
          accountLabel: c.accountLabel,
        })),
    [connectors, connectingId]
  );

  /** Category only narrows the catalog; the Connected tab is served from local state. */
  const activeCategory = filter === "connected" ? null : category;

  const catalogParams = React.useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (filter === "connected") params.set("connected", "1");
    if (activeCategory) params.set("category", activeCategory);
    return params;
  }, [activeCategory, filter, query]);

  React.useEffect(() => {
    if (!composioConfigured) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(false);
      fetch(`/api/connectors/composio/catalog?${catalogParams()}`, { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error("catalog failed");
          return r.json() as Promise<CatalogResponse>;
        })
        .then((data) => {
          setApps(data.items ?? []);
          setCursor(data.cursor ?? null);
          // Categories are static per deploy; keep the last good set rather than
          // letting a partial response empty the filter row mid-browse.
          if (data.categories?.length) setCategories(data.categories);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(true);
          setApps([]);
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
  }, [catalogParams, composioConfigured, query]);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = catalogParams();
      params.set("cursor", cursor);
      const r = await fetch(`/api/connectors/composio/catalog?${params}`);
      if (!r.ok) throw new Error("catalog failed");
      const data = (await r.json()) as CatalogResponse;
      setApps((current) => {
        const merged = new Map(current.map((i) => [i.slug, i]));
        (data.items ?? []).forEach((i) => merged.set(i.slug, i));
        return [...merged.values()];
      });
      setCursor(data.cursor ?? null);
    } catch {
      toast.error("Couldn’t load more apps.");
    } finally {
      setLoadingMore(false);
    }
  }, [catalogParams, cursor, loadingMore]);

  const composioItems = React.useMemo<DirectoryItem[]>(
    () =>
      apps
        // Drop Composio's copy of an app Juno integrates natively.
        .filter((a) => !NATIVE_EQUIVALENT[a.slug])
        .map((a) => ({
          key: `composio:${a.slug}`,
          source: "composio" as const,
          id: a.id,
          slug: a.slug,
          label: appLabel(a),
          description: a.noAuth ? "Ready without sign-in" : "Available to connect",
          logo: a.logo,
          connected: a.connected,
          connecting: a.connecting,
          configured: true,
          noAuth: a.noAuth,
          managedAuth: a.managedAuth,
        })),
    [apps]
  );

  const q = query.trim().toLowerCase();
  const items = React.useMemo(() => {
    // Composio items arrive already searched and category-filtered by the API;
    // the native handful is matched here so one keystroke covers both backends.
    const matches = (i: DirectoryItem) =>
      (!q || i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)) &&
      (!activeCategory || (NATIVE_CATEGORIES[i.id] ?? []).includes(activeCategory));
    const visible = [...nativeItems.filter(matches), ...composioItems];
    return filter === "connected" ? visible.filter((i) => i.connected) : visible;
  }, [activeCategory, nativeItems, composioItems, filter, q]);

  const connect = (item: DirectoryItem) => {
    if (item.source === "native") {
      const c = connectors.find((x) => x.id === item.id);
      if (c) onConnectNative(c);
      return;
    }
    setBusySlug(item.slug!);
    window.location.href = `/api/connectors/composio/${encodeURIComponent(item.slug!)}/connect`;
  };

  const connectedCount = [...nativeItems, ...composioItems].filter((i) => i.connected).length;
  const categoryLabel = categories.find((c) => c.id === activeCategory)?.label.toLowerCase();

  return (
    <section className="mt-6">
      {/* Toolbar — a calm search + filter row rather than a second page header. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Two rounded-full elements are concentric at any padding — the safe
            segmented control. This was a rounded-xl (12px) track wrapping
            rounded-lg (24px!) thumbs, so the thumbs bulged past their own rail. */}
        <div className="flex w-fit items-center gap-1 rounded-full border bg-card p-1 shadow-soft">
          {(["all", "connected"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] duration-fast ease-out-soft",
                filter === value
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              )}
            >
              {value === "all" ? "All apps" : `Connected${connectedCount ? ` · ${connectedCount}` : ""}`}
            </button>
          ))}
        </div>
        <label className="relative block w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Gmail, Slack, GitHub…"
            aria-label="Search apps"
            className="h-10 rounded-xl bg-card pl-9"
          />
        </label>
      </div>

      {/* Composio has ~1048 toolkits. Categories are the only thing standing
          between the user and an endlessly-paged flat list, so they sit here
          rather than behind a menu. Hidden on Connected — that tab is small
          enough to read whole, and the API cannot filter it by category. */}
      {filter === "all" && categories.length > 0 && (
        <div
          role="group"
          aria-label="Filter by category"
          // overflow-x forces the block axis to clip too, so the padding here is
          // load-bearing: it is the room the chips' hover lift needs to cast
          // shadow-soft (~10px of reach) instead of having it shorn off flat.
          className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <CategoryChip label="All categories" active={!category} onClick={() => setCategory(null)} />
          {categories.map((c) => (
            <CategoryChip
              key={c.id}
              label={c.label}
              count={c.count}
              active={category === c.id}
              onClick={() => setCategory(category === c.id ? null : c.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-5">
        {/* Composio powers the long tail. Without it the native connectors still
            work, so explain what's missing instead of showing an empty page. */}
        {!composioConfigured && <ComposioSetupCallout />}

        {error && (
          <div className="mb-4 rounded-[16px] border border-dashed border-destructive/40 bg-destructive/5 p-4 text-center text-sm text-destructive">
            The app directory couldn’t be loaded. Check <code className="font-mono text-xs">COMPOSIO_API_KEY</code> on the server.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ConnectorTile
              key={item.key}
              item={item}
              busy={busySlug === item.slug || item.connecting}
              enabled={enabled[item.id] ?? true}
              onEnabledChange={(v) => onEnabledChange(item.id, v)}
              onConnect={() => connect(item)}
              onDisconnect={() => onDisconnect(item)}
            />
          ))}
          {loading &&
            Array.from({ length: 6 }, (_, i) => (
              <div key={`sk-${i}`} className="skeleton h-[132px] rounded-[16px]" style={{ animationDelay: `${i * 30}ms` }} />
            ))}
        </div>

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center gap-4 rounded-[16px] border border-dashed border-border/70 px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="size-6" />
            </span>
            <p className="max-w-xs text-sm text-muted-foreground">
              {filter === "connected"
                ? "No connected apps yet. Connect one from All apps to get started."
                : q
                  ? `No apps match “${query.trim()}”${categoryLabel ? ` in ${categoryLabel}` : ""}.`
                  : categoryLabel
                    ? `No apps in ${categoryLabel}.`
                    : "No apps available."}
            </p>
          </div>
        )}

        {cursor && !loading && !error && (
          <div className="flex justify-center pt-6">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              Load more apps
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Actionable setup steps — the old copy just said the directory "is not active". */
function ComposioSetupCallout() {
  return (
    <div className="mb-3 rounded-2xl border border-dashed border-primary/30 bg-primary/[0.04] p-5">
      <div className="flex items-start gap-3">
        <Plug className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn on the full app directory</p>
          <p className="mt-1 text-caption leading-5 text-muted-foreground">
            The connectors below are built into Juno and work right now. To add Gmail, Slack, Linear and hundreds more,
            set a Composio API key on the server:
          </p>
          <ol className="mt-2.5 space-y-1 text-caption leading-5 text-muted-foreground">
            <li>
              1. Create a free project at{" "}
              <a
                href="https://dashboard.composio.dev"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
              >
                dashboard.composio.dev
                <ArrowUpRight className="size-3" />
              </a>{" "}
              and copy its API key (free, no card).
            </li>
            <li>
              2. Add <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">COMPOSIO_API_KEY=…</code> to the
              server’s <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">.env</code>.
            </li>
            <li>3. Restart Juno, then reload this page.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
