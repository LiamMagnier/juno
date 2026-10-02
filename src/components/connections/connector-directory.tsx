"use client";

import * as React from "react";
import { ChevronRight, KeyRound, Loader2, Plug, Plus, Search } from "@/components/ui/icons";
import { AppDetailSheet } from "@/components/connections/app-detail-sheet";
import { motion, useReducedMotion } from "framer-motion";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { ConnectorTileSkeleton } from "@/components/connections/connector-tile-skeleton";
import type { ConnectorStatus } from "@/components/connections/types";
import { cn } from "@/lib/utils";
import { staggerDelay, transition } from "@/lib/motion";
import { monogram } from "@/components/connections/custom-connector-api";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
 *
 * A third source, CUSTOM: MCP servers the reader added by URL. They sit in the
 * same two sections (a server is linked or it isn't), wear a monogram instead
 * of a brand mark, and open a manage dialog for their tools. The Available
 * grid always ends in an "Add an MCP server" tile, so the way to bring your
 * own is where you are already looking for an app.
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
  source: "native" | "composio" | "user_mcp" | "custom";
  /** Connector id ("github") or composio app id ("composio:gmail") or `user_mcp:<id>`. */
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
  /** user_mcp: the server's own enable switch (server-side, one concept). */
  enabled?: boolean;
  /** user_mcp: untested | ok | error. */
  status?: string | null;
  lastError?: string | null;
  toolCount?: number | null;
  tools?: string[];
  providerScopes?: string[];
  capability?: string;
  /** user_mcp: raw endpoint, shown as the one-line description. */
  url?: string;
  /** Custom only: the server's host, and how many of its tools Juno may use. */
  host?: string;
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

/** The app's mark on a tone step: brand marks keep their own colours. */
function AppLogo({ item, size = "row" }: { item: DirectoryItem; size?: "row" | "sheet" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground",
        size === "row" ? "size-9 rounded-control bg-muted dark:bg-card" : "size-10 rounded-control bg-muted dark:bg-card",
      )}
    >
      {item.source === "custom" ? (
        <span className="text-ui font-semibold text-foreground" aria-hidden="true">
          {monogram(item.label)}
        </span>
      ) : item.source === "native" ? (
        <ConnectorMark id={item.id} className="size-5" />
      ) : item.logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- a provider logo from the catalog; no optimiser route for third-party hosts
        <img src={item.logo} alt="" className="size-5 object-contain" loading="lazy" />
      ) : (
        <Plug className="size-[18px]" />
      )}
    </span>
  );
}

/**
 * One app, one row (design V3 Customize scene): its mark, its name over one
 * line, and on the right what it is (Connected, with the way into its
 * details) or what you can do (Connect). A connected row is one button that
 * opens the app's details; an available row is not a target itself, its
 * Connect button is. States are words, never pips.
 */
function ConnectorTile({
  item,
  busy,
  onConnect,
  onOpen,
  landed,
}: {
  item: DirectoryItem;
  busy: boolean;
  onConnect: () => void;
  /** Open the details (connected apps, your servers) or a custom server's manager. */
  onOpen?: () => void;
  landed?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const custom = item.source === "custom";
  const isUserMcp = item.source === "user_mcp";
  const unavailable = !item.configured;
  const needsSetup = item.source === "composio" && item.managedAuth === false && !item.connected;
  const openable = Boolean(onOpen) && (item.connected || isUserMcp || custom);

  const line = custom
    ? item.connected
      ? item.toolCount != null
        ? `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}, ${item.host}`
        : (item.host ?? "")
      : item.connecting
        ? "Finishing sign-in…"
        : `Sign in to finish adding, ${item.host}`
    : item.connecting
      ? "Finishing connection…"
      : isUserMcp
        ? item.lastError || item.url || item.description
        : item.connected
          ? item.accountLabel && item.accountLabel !== item.label
            ? item.accountLabel
            : item.capability || item.description
          : unavailable
            ? "Not set up on this server"
            : needsSetup
              ? "Needs its own sign-in app in Composio first"
              : item.noAuth
                ? "Ready without sign-in"
                : item.capability || item.description;

  const status = isUserMcp
    ? item.enabled === false
      ? "Off"
      : item.status === "error"
        ? "Couldn’t reach it"
        : "On"
    : item.connected
      ? "Connected"
      : null;

  const body = (
    <>
      <AppLogo item={item} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium leading-5 text-foreground">{item.label}</span>
        <span className="truncate text-ui leading-[18px] text-muted-foreground">{line}</span>
      </span>
    </>
  );

  return (
    <article id={tileAnchor(item.id)} className={cn("relative isolate", unavailable && "opacity-70")}>
      {landed ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-2.5 inset-y-0 -z-10 rounded-control bg-selected"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ ...transition.emphasis, delay: reduce ? 0.6 : 1.1 }}
        />
      ) : null}
      {openable ? (
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          className="-mx-2.5 flex min-h-[60px] w-[calc(100%+1.25rem)] items-center gap-3.5 rounded-control px-2.5 py-2 text-left transition-colors duration-fast ease-out-soft hover:bg-accent active:bg-selected focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {body}
          <span className={cn("shrink-0 text-ui", status === "Couldn’t reach it" ? "text-foreground" : "text-muted-foreground")}>{status}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      ) : (
        <div className="-mx-2.5 flex min-h-[60px] items-center gap-3.5 px-2.5 py-2">
          {body}
          {needsSetup ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="secondary" size="sm" className="h-7 shrink-0 rounded-full px-3">
                  <a href={`https://platform.composio.dev/marketplace/${encodeURIComponent(item.slug ?? "")}`} target="_blank" rel="noreferrer">
                    Set up
                    <ActionIcons.external className="size-3.5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-60">
                {`Composio has no shared sign-in app for ${item.label}. Add your own ${item.label} app credentials in the Composio dashboard, then connect it here.`}
              </TooltipContent>
            </Tooltip>
          ) : unavailable ? null : item.connecting ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-ui text-muted-foreground">
              <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              Connecting
            </span>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} loading={busy} onClick={onConnect} className="h-7 shrink-0 rounded-full px-3 coarse:h-10">
              {custom ? (
                <>
                  <KeyRound className="size-3.5" aria-hidden="true" />
                  Sign in
                </>
              ) : (
                "Connect"
              )}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function TileGrid({
  items,
  busySlug,
  onConnect,
  onOpen,
  landedId,
  trailing,
}: {
  items: DirectoryItem[];
  busySlug: string | null;
  onConnect: (item: DirectoryItem) => void;
  onOpen: (item: DirectoryItem) => void;
  landedId: string | null;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {items.map((item) => (
        <ConnectorTile
          key={item.key}
          item={item}
          busy={busySlug === item.slug || item.connecting}
          onConnect={() => onConnect(item)}
          onOpen={() => onOpen(item)}
          landed={landedId === item.id}
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
  permissionsReady,
  onEnabledChange,
  onConnectNative,
  onDisconnect,
  onTestUserMcp,
  connectingId,
  canConfigureServer = true,
  onManageCustom,
  onAddCustom,
  onConnectCustom,
  landedId = null,
}: {
  connectors: ConnectorStatus[];
  composioConfigured: boolean;
  /**
   * Whether this reader runs the server. The setup callout is instructions
   * for an operator (an env var, a restart); shown to anyone else it is a
   * page of steps they cannot take, above the apps they can.
   */
  canConfigureServer?: boolean;
  enabled: Record<string, boolean>;
  permissionsReady?: boolean;
  onEnabledChange: (id: string, v: boolean) => void;
  onConnectNative: (c: ConnectorStatus) => void;
  onDisconnect: (item: DirectoryItem) => void;
  onTestUserMcp?: (item: DirectoryItem) => void;
  connectingId: string | null;
  /** Custom MCP servers: open one's tools, add a new one. */
  onManageCustom?: (id: string) => void;
  onAddCustom?: () => void;
  onConnectCustom?: (id: string) => void;
  /** A connector that just finished signing in, flashed once. */
  landedId?: string | null;
}) {
  const [query, setQuery] = React.useState("");
  // One list: Connected first, then the rest. (The All / Connected switch
  // repeated the sections it sat above.)
  const filter = "all" as Filter;
  const [category, setCategory] = React.useState<string | null>(null);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [apps, setApps] = React.useState<CatalogItem[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(composioConfigured);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [busySlug, setBusySlug] = React.useState<string | null>(null);

  // User-registered MCP servers (kind "user_mcp") sit beside the registry set
  // so one keystroke covers every shape the account can reach.
  const userMcpItems = React.useMemo<DirectoryItem[]>(
    () =>
      connectors
        .filter((c) => c.kind === "user_mcp")
        .map((c) => ({
          key: `user_mcp:${c.id}`,
          source: "user_mcp" as const,
          id: c.id,
          label: c.label,
          description: c.description,
          // Disabled rows are still listed here (the page owns the switch), but
          // `connected` is false so the Connected/Available split and pickers
          // treat them as off. The tile footer draws the enable Switch either way.
          connected: c.connected,
          connecting: connectingId === c.id,
          configured: true,
          accountLabel: c.accountLabel,
          providerScopes: c.providerScopes,
          capability: c.capability,
          enabled: c.enabled ?? c.connected,
          status: c.status,
          lastError: c.lastError,
          toolCount: c.toolCount,
          tools: c.tools,
          url: c.description,
        })),
    [connectors, connectingId]
  );

  const registryItems = React.useMemo<DirectoryItem[]>(
    () =>
      connectors
        .filter((c) => c.kind !== "composio_app" && c.kind !== "user_mcp")
        .map((c) => ({
          key: `${c.kind === "custom_mcp" ? "custom" : "native"}:${c.id}`,
          source: c.kind === "custom_mcp" ? ("custom" as const) : ("native" as const),
          id: c.id,
          label: c.label,
          description: c.description,
          connected: c.connected,
          connecting: connectingId === c.id,
          configured: c.configured,
          accountLabel: c.accountLabel,
          providerScopes: c.providerScopes,
          capability: c.capability,
          ...(c.kind === "custom_mcp" ? { host: c.accountLabel ?? undefined, toolCount: c.toolCount ?? null } : {}),
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
    // the native handful and user MCP rows are matched here so one keystroke
    // covers every backend. Category chips only narrow the REGISTRY set (they
    // carry Composio taxonomy); user MCP tiles always show in All.
    const textMatch = (i: DirectoryItem) =>
      !q ||
      i.label.toLowerCase().includes(q) ||
      i.id.toLowerCase().includes(q) ||
      (i.url ?? "").toLowerCase().includes(q);
    const registryMatch = (i: DirectoryItem) =>
      textMatch(i) && (!activeCategory || (NATIVE_CATEGORIES[i.id] ?? []).includes(activeCategory));
    const visible = [
      ...userMcpItems.filter(textMatch),
      ...registryItems.filter(registryMatch),
      ...composioItems.filter(textMatch),
    ];
    return filter === "connected" ? visible.filter((i) => i.connected) : visible;
  }, [activeCategory, userMcpItems, registryItems, composioItems, filter, q]);

  const connectedItems = React.useMemo(() => items.filter((i) => i.connected), [items]);
  const availableItems = React.useMemo(() => items.filter((i) => !i.connected), [items]);

  const connect = (item: DirectoryItem) => {
    if (item.source === "custom") {
      onConnectCustom?.(item.id);
      return;
    }
    if (item.source === "native") {
      const c = connectors.find((x) => x.id === item.id);
      if (c) onConnectNative(c);
      return;
    }
    if (item.source === "user_mcp") return;
    setBusySlug(item.slug!);
    window.location.href = `/api/connectors/composio/${encodeURIComponent(item.slug!)}/connect`;
  };

  // Disabled user MCP rows are listed but not "connected"; the Connected tab
  // therefore shows only enabled ones, matching what pickers will offer.
  const connectedCount = [...userMcpItems, ...registryItems, ...composioItems].filter((i) => i.connected).length;
  const categoryLabel = categories.find((c) => c.id === activeCategory)?.label.toLowerCase();

  // The app whose details are open, by id, so the sheet follows the list
  // (a test result, a disconnect) instead of holding a stale copy.
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const allItems = [...userMcpItems, ...registryItems, ...composioItems];
  const detail = detailId ? (allItems.find((item) => item.id === detailId) ?? null) : null;
  const openItem = (item: DirectoryItem) => {
    if (item.source === "custom") {
      onManageCustom?.(item.id);
      return;
    }
    setDetailId(item.id);
    setSheetOpen(true);
  };

  const gridProps = { busySlug, onConnect: connect, onOpen: openItem, landedId };

  // Bring your own: always the last row of More apps, except while searching (it would read as a result).
  const addTile = onAddCustom && !q ? <AddServerTile index={availableItems.length} onClick={onAddCustom} /> : null;

  const skeletons = loading
    ? Array.from({ length: 6 }, (_, i) => <ConnectorTileSkeleton key={`sk-${i}`} index={i} />)
    : null;

  const sectionLabel = "mb-1 flex gap-1.5 text-ui font-medium text-muted-foreground";

  return (
    <section>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search apps"
          aria-label="Search apps"
          className="h-9 pl-9"
        />
      </label>

      {/* Composio has about a thousand toolkits; categories are what stands between a
          person and an endless list, so they stay, as a quiet row that scrolls. */}
      {categories.length > 0 && (
        <div
          role="group"
          aria-label="Filter by category"
          className="-mx-1 mt-2 flex gap-1 overflow-x-auto px-1 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Pressable kind="chip" size="lg" selected={!category} aria-pressed={!category} onClick={() => setCategory(null)}>
            All
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
            </Pressable>
          ))}
        </div>
      )}

      <div className="mt-6">
        {!composioConfigured && canConfigureServer && <ComposioSetupCallout />}

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
            <h2 className={sectionLabel}>
              Connected <span className="tabular-nums">{connectedCount}</span>
            </h2>
            <TileGrid items={connectedItems} {...gridProps} />
          </div>
        )}

        {(availableItems.length > 0 || loading || addTile) && (
          <div className={cn(connectedItems.length > 0 && "mt-8")}>
            <h2 className={sectionLabel}>{connectedItems.length > 0 ? "More apps" : "Apps you can connect"}</h2>
            <TileGrid items={availableItems} {...gridProps} trailing={<>{skeletons}{addTile}</>} />
          </div>
        )}

        {!loading && items.length === 0 && (
          <EmptyState
            tone="empty"
            size="page"
            icon={Plug}
            title={q || categoryLabel ? "Nothing here" : "No apps available"}
            description={
              q
                ? `No apps match “${query.trim()}”${categoryLabel ? ` in ${categoryLabel}` : ""}.`
                : categoryLabel
                  ? `No apps in ${categoryLabel}.`
                  : "The catalog came back empty."
            }
            action={
              q || category ? (
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
            <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore} loading={loadingMore}>
              Load more apps
            </Button>
          </div>
        )}
      </div>

      <AppDetailSheet
        open={sheetOpen && detail !== null}
        onOpenChange={setSheetOpen}
        target={
          detail
            ? {
                id: detail.id,
                slug: detail.slug,
                label: detail.label,
                source: detail.source,
                mark: <AppLogo item={detail} size="sheet" />,
                accountLabel: detail.accountLabel,
                connectedAt: connectors.find((c) => c.id === detail.id)?.connectedAt ?? null,
                capability: detail.capability,
                description: detail.description,
                providerScopes: detail.providerScopes,
                tools: detail.tools,
                lastError: detail.lastError,
              }
            : null
        }
        allowed={detail?.source === "user_mcp" ? (detail.enabled ?? detail.connected) : detail ? (enabled[detail.id] ?? true) : true}
        permissionsReady={detail?.source === "user_mcp" ? true : (permissionsReady ?? true)}
        onAllowedChange={(value) => detail && onEnabledChange(detail.id, value)}
        onDisconnect={() => {
          if (!detail) return;
          setSheetOpen(false);
          onDisconnect(detail);
        }}
        onTest={detail?.source === "user_mcp" && onTestUserMcp ? () => onTestUserMcp(detail) : undefined}
        testing={detail ? connectingId === detail.id : false}
      />
    </section>
  );
}

export function tileAnchor(id: string): string {
  return `connector-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * "Add an MCP server": a tile-sized door at the end of Available. Dashed at
 * rest (a place for something, not a thing), and the one tile here that IS a
 * target, so it alone answers the pointer: the hairline firms up, the well
 * lifts a step, the plus turns a quarter. Pressing sinks it a touch.
 */
function AddServerTile({ index, onClick }: { index: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      style={staggerDelay(index, "tight")}
      className={cn(
        "group flex min-h-[7.5rem] flex-col items-start justify-between gap-3 rounded-card border border-dashed border-border p-3.5 text-left",
        "transition-[border-color,background-color,transform] duration-fast ease-out-soft",
        "hover:border-solid hover:border-foreground/25 hover:bg-accent/50 active:scale-[0.99]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
    >
      <span className="surface-inset flex size-10 items-center justify-center rounded-field text-muted-foreground transition-[transform,color] duration-base ease-out-soft group-hover:-translate-y-0.5 group-hover:text-foreground motion-reduce:group-hover:translate-y-0">
        <Plus className="size-5 transition-transform duration-base ease-out-soft group-hover:rotate-90 motion-reduce:group-hover:rotate-0" />
      </span>
      <span className="min-w-0">
        <span className="block text-ui font-medium leading-5 text-foreground">Add an MCP server</span>
        <span className="block text-caption leading-4 text-muted-foreground">
          Bring your own tools: any MCP server that signs in with OAuth.
        </span>
      </span>
    </button>
  );
}

/** Actionable setup steps — the old copy just said the directory "is not active". */
function ComposioSetupCallout() {
  return (
    <div className="surface-inset mb-6 rounded-card p-4">
      <div className="flex items-start gap-3">
        <span className="surface-raised flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
          <Plug className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-ui font-medium">Turn on the full app directory</p>
          <p className="mt-1 text-caption leading-5 text-muted-foreground">
            {`The connectors below are built into ${PRODUCT_NAME} and work right now. To add Gmail, Slack, Linear and hundreds more, set a Composio API key on the server:`}
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
                <ActionIcons.external className="size-3" />
              </a>{" "}
              and copy its API key (free, no card).
            </li>
            <li>
              2. Add <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-caption">COMPOSIO_API_KEY=…</code> to
              the server’s <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-caption">.env</code>.
            </li>
            <li>{`3. Restart ${PRODUCT_NAME}, then reload this page.`}</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
