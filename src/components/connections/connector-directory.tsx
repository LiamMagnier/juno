"use client";

import * as React from "react";
import { AlertCircle, ArrowUpRight, Link2, Link2Off, Loader2, Plug, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
    // One optical padding for every tile in the grid. The three branches used to
    // draw at three different glyph sizes (5 / 6 / 4), so logos sitting side by
    // side in the same row read at three different weights.
    //
    // `bg-secondary`, not `bg-card`: the well sits INSIDE a bg-card article, so
    // the fill matched its own container and the only separation left was a
    // `shadow-soft` that is black ink on a black ground. One rung up instead.
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-field border border-border/60 bg-secondary">
      {item.source === "native" ? (
        <ConnectorMark id={item.id} className="size-5" />
      ) : item.logo ? (
        // A bitmap logo carries its own padding, so it sits one rung larger than
        // a stroked mark to end up optically the same size.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.logo} alt="" className="size-6 object-contain" loading="lazy" />
      ) : (
        <Plug className="size-5 text-primary" strokeWidth={1.7} />
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
        // Solid, uniform fills — no borders, no per-chip shadows. Outlined pills
        // read as ten boxes competing with the app cards below; borderless text
        // read as nothing at all. A filled set reads as one control.
        // `text-label`, not an arbitrary 13px that sat between the label rung
        // (12) and the body rung (15) and appeared nowhere else in the product.
        // The rung already carries weight 500, so `font-medium` came off with it.
        "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-label",
        "transition-colors duration-fast ease-out-soft coarse:h-11",
        active
          ? "bg-foreground text-background"
          : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {label}
      {count !== undefined && (
        // No alpha knock-down on the inactive count: --muted-foreground at 55%
        // over pure black is far under AA at this size, and the ramp is already
        // the recessive voice.
        <span className={cn("ml-1.5 font-mono text-caption tabular-nums", active ? "text-background/70" : "text-muted-foreground")}>
          {count}
        </span>
      )}
    </button>
  );
}

type TileState = "connected" | "connecting" | "available" | "setup" | "unavailable";

/**
 * Status pill echoing the connector's state, keyed off the shared theme tokens.
 *
 * ONE geometry for all five, declared once. They had drifted into five different
 * border alphas (success/30, warning/40, full-strength border, dashed /70, /60)
 * and three text alphas, so on a pure-black ground they read as five unrelated
 * components rather than as one state vocabulary. The rule now: `/40` on the
 * tinted pills, `/60` on the neutral ones, and the DASH is the only structural
 * difference — reserved for `unavailable`, because a dashed edge means "not a
 * finished thing" everywhere else in the product (see EmptyState).
 */
const PILL =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-medium";

function TileStatus({ state }: { state: TileState }) {
  if (state === "connected") {
    return (
      <span className={cn(PILL, "border-success/40 bg-success/10 text-success")}>
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
      <span className={cn(PILL, "border-warning/40 bg-warning/10 text-warning")}>
        <span className="h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse" />
        Connecting
      </span>
    );
  }
  if (state === "setup") {
    return <span className={cn(PILL, "border-border/60 text-muted-foreground")}>Setup needed</span>;
  }
  if (state === "unavailable") {
    return (
      <span className={cn(PILL, "border-dashed border-border/60 text-muted-foreground")}>Unavailable</span>
    );
  }
  return (
    <span className={cn(PILL, "border-border/60 text-muted-foreground")}>
      <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/60" />
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
        // Quiet utility tile: status and actions carry the hierarchy, not elevation.
        "group flex flex-col justify-between gap-3 rounded-card border bg-card p-4 transition-[border-color,background-color] duration-fast ease-out-soft",
        // Alphas match TileStatus's, so the tile edge and the pill inside it are
        // the same statement at the same strength.
        item.connected
          ? "border-success/40"
          : unavailable
            ? // Opaque, not `bg-card/60`: 60% of --card over pure black composites
              // to ~3.9% — BELOW the card rung it is meant to recede from, so the
              // tile fell out of the grid rather than sitting quietly in it. The
              // dashed pill and the muted ink carry the recession instead.
              "border-border/60"
            : // `bg-accent` whole, not `/25`: a quarter of the 13% accent over
              // the 6.5% card composites to ~8.1%, a 1.6-point step — under
              // what an edge-free fill can show on black, so the only hover
              // this tile had was its border. Card's `interactive` variant made
              // the same correction for the same reason; the step is 6.5 → 13,
              // the same one the ground→card move already uses.
              "border-border/70 hover:border-foreground/25 hover:bg-accent"
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
            className="group/disconnect gap-1.5 px-2.5 text-muted-foreground danger-hover"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Link2Off className="size-3.5 transition-transform duration-fast ease-out-soft group-hover/disconnect:rotate-6 group-hover/disconnect:scale-105 motion-reduce:transform-none motion-reduce:transition-none" />
            )}
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
          className="group/connect w-full gap-1.5"
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
        {/* The shared control, not a local restatement of it. This was a
            hand-rolled copy — `bg-muted/70` track, 9px pills, no sheen on the
            thumb and no gliding or arrow-key nav — sitting one import away
            from the real thing. */}
        <SegmentedControl<Filter>
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter apps"
          className="w-fit"
          options={[
            { value: "all", label: "All apps" },
            { value: "connected", label: `Connected${connectedCount ? ` · ${connectedCount}` : ""}` },
          ]}
        />
        <label className="relative block w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Gmail, Slack, GitHub…"
            aria-label="Search apps"
            // pl-9 only. `bg-card` was a utility sitting on top of Input's
            // `.field-well`, and utilities are emitted after the components
            // layer — so the per-theme fill the well exists to supply never
            // painted here, and this was the one input in the product with a
            // hand-picked ground. `h-10` and `rounded-field` were restating or
            // fighting the primitive too: rounded-field is already its radius,
            // and h-10 made it 4px taller than the SegmentedControl beside it
            // and dropped the coarse:h-11 touch growth the base declares.
            className="pl-9"
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
          // load-bearing: it is the room a focused chip's outline needs instead
          // of having it shorn off flat against the scroll edge.
          className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
          // The shared error tone. This was a DASHED destructive box, and the
          // dash is EmptyState's signal for "nothing here yet" — a failed catalog
          // fetch wearing the placeholder edge is exactly the collapse the two
          // tones exist to prevent.
          <EmptyState
            tone="error"
            size="panel"
            icon={AlertCircle}
            className="mb-4"
            title="The app directory couldn’t be loaded"
            description={
              <>
                Check <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-caption">COMPOSIO_API_KEY</code> on
                the server.
              </>
            }
          />
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
              <div key={`sk-${i}`} className="skeleton h-[132px] rounded-card" style={staggerDelay(i)} />
            ))}
        </div>

        {!loading && items.length === 0 && (
          // The shared primitive, with a way out. The hand-rolled block had no
          // action at all — a search that matches nothing was a dead end — and
          // its `bg-card/40` fill composites to ~2.6% on pure black, so the
          // ground it drew disappeared entirely.
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
    <div className="mb-4 border-b border-border/60 pb-5">
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
              2. Add <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-caption">COMPOSIO_API_KEY=…</code> to the
              server’s <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-caption">.env</code>.
            </li>
            <li>3. Restart Juno, then reload this page.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
