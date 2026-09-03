"use client";

import * as React from "react";
import { Link2, Link2Off, Loader2, Plug, Search } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectorMark } from "@/components/connections/connector-logos";
import type { ConnectorStatus } from "@/components/connections/types";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

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
 *
 * The grid is split by the one thing that matters to the reader: what is
 * already linked ("Connected") sits above what could be ("Available").
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

/** The house icon tile: an inset well the mark sits in. */
function AppLogo({ item }: { item: DirectoryItem }) {
  return (
    <span className="surface-inset flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-field text-muted-foreground">
      {item.source === "native" ? (
        <ConnectorMark id={item.id} className="size-5" />
      ) : item.logo ? (
        // A bitmap logo carries its own padding, so it sits one rung larger than
        // a stroked mark to end up optically the same size.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.logo} alt="" className="size-6 object-contain" loading="lazy" />
      ) : (
        <Plug className="size-5 text-primary" />
      )}
    </span>
  );
}

type TileState = "connected" | "connecting" | "available" | "setup" | "unavailable";

/**
 * A status pip with its mono label — the same vocabulary the rest of the
 * product uses for "is this thing on": one dot, one word.
 */
function TileStatus({ state }: { state: TileState }) {
  const meta: Record<TileState, { label: string; pip: string; ink?: string }> = {
    connected: { label: "Connected", pip: "bg-success", ink: "text-success-ink" },
    connecting: { label: "Connecting", pip: "bg-warning", ink: "text-warning-foreground" },
    available: { label: "Available", pip: "border border-muted-foreground/60" },
    setup: { label: "Setup needed", pip: "bg-warning" },
    unavailable: { label: "Unavailable", pip: "bg-muted-foreground/40" },
  };
  const m = meta[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-caption text-muted-foreground", m.ink)}>
      <span className={cn("inline-flex size-2 shrink-0 rounded-full", m.pip)} />
      {m.label}
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
  index,
}: {
  item: DirectoryItem;
  busy: boolean;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  index: number;
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
    <Card
      variant="default"
      className={cn(
        "group flex flex-col gap-3 p-3.5 hover:border-foreground/20 hover:shadow-raised-lg motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        unavailable && "text-muted-foreground"
      )}
      style={staggerDelay(index, "tight")}
    >
      <div className="flex items-start gap-3">
        <AppLogo item={item} />
        {/* Name over account (or the one-line description), both at the
            body rung: the tile is a row in a grid, not a page header. */}
        <div className="min-w-0 flex-1 self-center">
          <h3 className="truncate text-ui font-medium leading-5 text-foreground">{item.label}</h3>
          <p className="line-clamp-2 text-caption leading-4 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="mt-auto flex min-h-8 items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <TileStatus state={state} />

        {item.connected ? (
          <div className="flex items-center gap-1.5">
            {/* Only a linked app can be exposed to chats. A normal Switch with
                a plain label — the toggle is a setting, not a hero. */}
            <label className="flex cursor-pointer items-center gap-2 pr-1">
              <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={`Use ${item.label} in chats`} />
              <span className="text-caption text-muted-foreground">Use in chats</span>
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              disabled={busy}
              aria-haspopup="dialog"
              className="danger-hover h-7 gap-1.5 px-2 text-caption text-muted-foreground"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
              Disconnect
            </Button>
          </div>
        ) : needsSetup ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="secondary" size="sm" className="h-7 gap-1.5 px-2.5 text-caption">
                <a
                  href={`https://platform.composio.dev/marketplace/${encodeURIComponent(item.slug ?? "")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Set up
                  <ActionIcons.external className="size-3.5" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              Composio has no shared OAuth app for {item.label}. Add your own {item.label} app credentials in the
              Composio dashboard, then connect it here.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy || unavailable} onClick={onConnect} className="h-7 gap-1.5 px-2.5 text-caption">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
            Connect
          </Button>
        )}
      </div>
    </Card>
  );
}

function TileGrid({
  items,
  busySlug,
  enabled,
  onEnabledChange,
  onConnect,
  onDisconnect,
  trailing,
}: {
  items: DirectoryItem[];
  busySlug: string | null;
  enabled: Record<string, boolean>;
  onEnabledChange: (id: string, v: boolean) => void;
  onConnect: (item: DirectoryItem) => void;
  onDisconnect: (item: DirectoryItem) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => (
        <ConnectorTile
          key={item.key}
          index={i}
          item={item}
          busy={busySlug === item.slug || item.connecting}
          enabled={enabled[item.id] ?? true}
          onEnabledChange={(v) => onEnabledChange(item.id, v)}
          onConnect={() => onConnect(item)}
          onDisconnect={() => onDisconnect(item)}
        />
      ))}
      {trailing}
    </div>
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

  const connectedItems = React.useMemo(() => items.filter((i) => i.connected), [items]);
  const availableItems = React.useMemo(() => items.filter((i) => !i.connected), [items]);

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

  const gridProps = {
    busySlug,
    enabled,
    onEnabledChange,
    onConnect: connect,
    onDisconnect,
  };

  const skeletons = loading
    ? Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={`sk-${i}`} className="h-36 rounded-card" style={staggerDelay(i, "tight")} />
      ))
    : null;

  return (
    <section>
      {/* Toolbar — the house row: filter, search, count. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<Filter>
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter apps"
          className="w-fit"
          options={[
            { value: "all", label: "All apps" },
            { value: "connected", label: "Connected", count: connectedCount || undefined },
          ]}
        />
        <label className="relative block w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Gmail, Slack, GitHub…"
            aria-label="Search apps"
            className="pl-9"
          />
        </label>
        {!loading && (
          <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground">
            {items.length} {items.length === 1 ? "app" : "apps"}
          </span>
        )}
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
          // load-bearing: it is the room a focused chip's outline needs instead
          // of having it shorn off flat against the scroll edge.
          className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Pressable kind="chip" size="lg" selected={!category} aria-pressed={!category} onClick={() => setCategory(null)}>
            All categories
          </Pressable>
          {categories.map((c) => (
            <Pressable
              key={c.id}
              kind="chip"
              size="lg"
              selected={category === c.id}
              aria-pressed={category === c.id}
              onClick={() => setCategory(category === c.id ? null : c.id)}
              className="shrink-0 whitespace-nowrap"
            >
              {c.label}
              {c.count !== undefined && (
                <span className="font-mono text-micro tabular-nums opacity-70">{c.count}</span>
              )}
            </Pressable>
          ))}
        </div>
      )}

      <div className="mt-6">
        {/* Composio powers the long tail. Without it the native connectors still
            work, so explain what's missing instead of showing an empty page. */}
        {!composioConfigured && <ComposioSetupCallout />}

        {error && (
          <EmptyState
            tone="error"
            size="panel"
            icon={StatusIcons.error}
            className="mb-6"
            title="The app directory couldn’t be loaded"
            description={
              <>
                Check <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-caption">COMPOSIO_API_KEY</code> on
                the server.
              </>
            }
          />
        )}

        {connectedItems.length > 0 && (
          <div>
            <h2 className="text-heading">Connected</h2>
            <p className="mb-4 text-sm text-muted-foreground">Linked and available to your chats.</p>
            <TileGrid items={connectedItems} {...gridProps} />
          </div>
        )}

        {(availableItems.length > 0 || loading) && filter !== "connected" && (
          <div className={cn(connectedItems.length > 0 && "mt-8")}>
            <h2 className="text-heading">Available</h2>
            <p className="mb-4 text-sm text-muted-foreground">Connect an app to let Juno work inside it.</p>
            <TileGrid items={availableItems} {...gridProps} trailing={skeletons} />
          </div>
        )}

        {!loading && items.length === 0 && (
          <EmptyState
            tone="empty"
            size="page"
            icon={Plug}
            title={
              filter === "connected"
                ? "No connected apps yet"
                : q || categoryLabel
                  ? "Nothing here"
                  : "No apps available"
            }
            description={
              filter === "connected"
                ? "Connect one from All apps and it will show up here."
                : q
                  ? `No apps match “${query.trim()}”${categoryLabel ? ` in ${categoryLabel}` : ""}.`
                  : categoryLabel
                    ? `No apps in ${categoryLabel}.`
                    : "The catalog came back empty."
            }
            action={
              filter === "connected" ? (
                <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                  Browse all apps
                </Button>
              ) : q || category ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setCategory(null);
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {cursor && !loading && !error && (
          <div className="flex justify-center pt-6">
            <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
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
    <div className="surface-inset mb-6 rounded-card p-4">
      <div className="flex items-start gap-3">
        <span className="surface-raised flex size-9 shrink-0 items-center justify-center rounded-field text-primary">
          <Plug className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">Turn on the full app directory</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The connectors below are built into Juno and work right now. To add Gmail, Slack, Linear and hundreds more,
            set a Composio API key on the server:
          </p>
          <ol className="mt-2.5 space-y-1 text-xs leading-5 text-muted-foreground">
            <li>
              1. Create a free project at{" "}
              <a
                href="https://dashboard.composio.dev"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-primary-ink underline-offset-2 hover:underline"
              >
                dashboard.composio.dev
                <ActionIcons.external className="size-3" />
              </a>{" "}
              and copy its API key (free, no card).
            </li>
            <li>
              2. Add <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-caption">COMPOSIO_API_KEY=…</code> to
              the server’s <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-caption">.env</code>.
            </li>
            <li>3. Restart Juno, then reload this page.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
