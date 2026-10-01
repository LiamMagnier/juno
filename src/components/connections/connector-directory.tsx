"use client";

import * as React from "react";
import { KeyRound, Link2, Link2Off, Loader2, Plug, Plus, Search, SlidersHorizontal } from "@/components/ui/icons";
import { motion, useReducedMotion } from "framer-motion";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { ConnectorTileSkeleton } from "@/components/connections/connector-tile-skeleton";
import type { ConnectorStatus } from "@/components/connections/types";
import { cn } from "@/lib/utils";
import { staggerDelay, transition } from "@/lib/motion";
import { monogram } from "@/components/connections/custom-connector-api";

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

/** The house icon tile: an inset well the mark sits in. */
function AppLogo({ item }: { item: DirectoryItem }) {
  return (
    <span className="surface-inset flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-field text-muted-foreground">
      {item.source === "custom" ? (
        <span className="text-ui font-semibold text-foreground" aria-hidden="true">
          {monogram(item.label)}
        </span>
      ) : item.source === "native" ? (
        <ConnectorMark id={item.id} className="size-5" />
      ) : item.logo ? (
        // A bitmap logo carries its own padding, so it sits one rung larger than
        // a stroked mark to end up optically the same size.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.logo} alt="" className="size-6 object-contain" loading="lazy" />
      ) : (
        // Muted like every other mark in the well: the accent is state and the
        // primary action, and a Composio app that shipped no logo is neither.
        <Plug className="size-5" />
      )}
    </span>
  );
}

type TileState = "connected" | "connecting" | "available" | "setup" | "unavailable";

/**
 * A connector's state AS WORDS (owner directive, 2026-09-26: this was a pip
 * and a word, the connected one green). Connecting and unavailable are muted
 * words; setup needed is the one state that asks for the reader, so it alone
 * keeps the warning ink and a small mark.
 *
 * Connected and available print nothing (premium pass): the tile already sits
 * under a "Connected" or "Available" heading, and its footer holds the switch
 * or the Connect button that says the same thing by what it offers. A word
 * that repeats the section heading on every tile is a label, not information.
 */
function TileStatus({ state }: { state: TileState }) {
  if (state === "connected" || state === "available") return null;
  const label: Record<TileState, string> = {
    connected: "Connected",
    connecting: "Connecting",
    available: "Available",
    setup: "Setup needed",
    unavailable: "Unavailable",
  };
  const attention = state === "setup";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-caption",
        attention ? "font-medium text-warning-foreground" : "text-muted-foreground"
      )}
    >
      {attention && <StatusIcons.warning className="size-3.5 shrink-0" aria-hidden="true" />}
      {label[state]}
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
  onTest,
  permissionsReady = true,
  onManage,
  landed,
}: {
  item: DirectoryItem;
  busy: boolean;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest?: () => void;
  permissionsReady?: boolean;
  onManage?: () => void;
  /** Just came back from signing in: flashed once. */
  landed?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const reduce = useReducedMotion() ?? false;
  const custom = item.source === "custom";
  const unavailable = !item.configured;
  // Composio hosts no OAuth app for this toolkit (verified live: e.g. twitter),
  // so authorize() 400s with "Composio does not manage auth for toolkit …".
  // Rendering a Connect button here bounced the user straight back to this page
  // with a generic error — indistinguishable from a reload, and "try again"
  // could never work. Say what is actually required instead.
  const needsSetup = item.source === "composio" && item.managedAuth === false && !item.connected;
  const isUserMcp = item.source === "user_mcp";
  // user_mcp's switch IS the server-side `enabled` column. The `enabled` prop
  // is the localStorage "Use in chats" map for registry connectors only; using
  // it here would reintroduce the two-switch split this feature removes.
  const switchOn = isUserMcp ? (item.enabled ?? item.connected) : enabled;
  const state: TileState = item.connected
    ? "connected"
    : item.connecting
      ? "connecting"
      : unavailable
        ? "unavailable"
        : needsSetup
          ? "setup"
          : "available";

  const description = custom
    ? item.connected
      ? item.toolCount != null
        ? `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"} · ${item.host}`
        : item.host ?? ""
      : item.connecting
        ? "Finishing sign-in…"
        : `Sign in to finish adding · ${item.host}`
    : item.connected
    ? item.accountLabel && item.accountLabel !== item.label
      ? item.accountLabel
      : isUserMcp
        ? item.url || item.description
        : "Connected and ready"
    : item.connecting
      ? "Finishing connection…"
      : unavailable
        ? "Not set up on this server"
        : needsSetup
          ? "Needs its own OAuth app in Composio"
          : isUserMcp
            ? item.lastError || item.url || item.description
            : item.noAuth
              ? "Ready without sign-in"
              : item.description;

  return (
    <article
      className={cn(
        // No hover state: the tile is not itself a target (its switch and its
        // button are), and a card that shades or lifts under the pointer
        // promises a click that goes nowhere.
        "group relative isolate flex flex-wrap items-center gap-4 border-b border-border py-5",
        unavailable && "text-muted-foreground"
      )}
      id={tileAnchor(item.id)}
    >
      {landed ? (
        // Where the connection the reader just made went: the selected tone,
        // held for a beat and let go once on the emphasis rung (the skills
        // library's landing flash). Opacity only, under the tile's content.
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 rounded-inherit bg-selected"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ ...transition.emphasis, delay: reduce ? 0.6 : 1.1 }}
        />
      ) : null}
      <div className="flex min-w-52 flex-1 items-start gap-3">
        <AppLogo item={item} />
        {/* Name over account (or the one-line description), both at the
            body rung: the tile is a row in a grid, not a page header. */}
        <div className="min-w-0 flex-1 self-center">
          <h3 className="truncate text-ui font-medium leading-5 text-foreground"><button type="button" onClick={() => setDetailsOpen(true)} className="text-left hover:underline underline-offset-4" aria-haspopup="dialog">{item.label}</button></h3>
          <p className="line-clamp-2 text-caption leading-4 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="flex min-h-8 w-full items-center justify-between gap-4 sm:w-auto sm:min-w-64">
        <TileStatus state={state} />

        {isUserMcp ? (
          // One switch: the server's own `enabled`. Not a second "Use in chats"
          // localStorage toggle (that was the split-brain this replaces). Test
          // and Remove sit beside it.
          <div className="flex w-full items-center justify-between gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 pr-1">
              <Switch checked={switchOn} onCheckedChange={onEnabledChange} aria-label={`Enable ${item.label}`} />
              <span className="whitespace-nowrap text-caption text-muted-foreground">{switchOn ? "On" : "Off"}</span>
            </label>
            <div className="flex items-center gap-0.5">
              {onTest && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onTest}
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-caption text-muted-foreground"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                  Test
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onDisconnect}
                disabled={busy}
                aria-haspopup="dialog"
                className="danger-hover h-7 gap-1.5 px-2 text-caption text-muted-foreground"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2Off className="size-3.5" />}
                Remove
              </Button>
            </div>
          </div>
        ) : item.connected ? (
          <div className="flex w-full items-center justify-between gap-1.5">
            {/* Only a linked app can be exposed to chats. A normal Switch with
                a plain label — the toggle is a setting, not a hero. It leads
                the footer now that the status word it followed is gone. */}
            <label className="flex cursor-pointer items-center gap-2 pr-1">
              <Switch checked={enabled} disabled={!permissionsReady || busy} onCheckedChange={onEnabledChange} aria-label={`Allow Juno to use ${item.label}`} />
              <span className="whitespace-nowrap text-caption text-muted-foreground">Allow Juno to use</span>
            </label>
            {custom && onManage ? (
              // A server's tools are chosen one by one, and signing out lives
              // with them: one Manage door instead of a Disconnect that would
              // leave the tool choices unreachable from here.
              <Button
                variant="ghost"
                size="sm"
                onClick={onManage}
                aria-haspopup="dialog"
                className="h-7 gap-1.5 px-2 text-caption text-muted-foreground"
              >
                <SlidersHorizontal className="size-3.5" />
                Manage
              </Button>
            ) : (
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
            )}
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
        ) : custom ? (
          <div className="flex w-full items-center justify-between gap-1.5">
            {onManage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onManage}
                aria-haspopup="dialog"
                className="h-7 gap-1.5 px-2 text-caption text-muted-foreground"
              >
                <SlidersHorizontal className="size-3.5" />
                Manage
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" variant="secondary" disabled={busy} onClick={onConnect} className="h-7 gap-1.5 px-2.5 text-caption">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              Sign in
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy || unavailable} onClick={onConnect} className="ml-auto h-7 gap-1.5 px-2.5 text-caption">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
            Connect
          </Button>
        )}
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{item.label}</DialogTitle><DialogDescription>{item.capability || item.description}</DialogDescription></DialogHeader>
          <div className="space-y-5 text-ui">
            <section><h4 className="font-medium">Connection</h4><p className="mt-1 text-muted-foreground">{item.connected ? (item.accountLabel || "Connected") : "Not connected"}</p></section>
            <section><h4 className="font-medium">Provider permissions</h4>
              {item.providerScopes?.length ? <ul className="mt-2 space-y-1">{item.providerScopes.map((scope) => <li key={scope} className="break-all font-mono text-caption">{scope}</li>)}</ul> : <p className="mt-1 text-muted-foreground">This provider has not reported its exact permissions to Juno. Review access in the provider’s account settings.</p>}
            </section>
            {item.tools?.length ? <section><h4 className="font-medium">Tools from the last successful test</h4><ul className="mt-2 max-h-48 overflow-y-auto space-y-1">{item.tools.map((tool) => <li key={tool} className="break-all text-caption">{tool}</li>)}</ul></section> : null}
            <p className="text-caption text-muted-foreground">Juno checks your app switch and action approval policy before running a tool. Disconnecting removes Juno’s stored connection; revoke provider access in the provider’s account settings too.</p>
            <Button variant="secondary" asChild><a href="/settings?section=connectors">Action approval policy</a></Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}

function TileGrid({
  items,
  busySlug,
  enabled,
  onEnabledChange,
  onConnect,
  onDisconnect,
  onTest,
  onManage,
  landedId,
  trailing,
  permissionsReady,
}: {
  items: DirectoryItem[];
  busySlug: string | null;
  enabled: Record<string, boolean>;
  onEnabledChange: (id: string, v: boolean) => void;
  onConnect: (item: DirectoryItem) => void;
  onDisconnect: (item: DirectoryItem) => void;
  onTest?: (item: DirectoryItem) => void;
  onManage?: (item: DirectoryItem) => void;
  landedId: string | null;
  trailing?: React.ReactNode;
  permissionsReady?: boolean;
}) {
  return (
    <div className="divide-y-0">
      {items.map((item) => (
        <ConnectorTile
          key={item.key}
          permissionsReady={permissionsReady}
          item={item}
          busy={busySlug === item.slug || item.connecting}
          enabled={enabled[item.id] ?? true}
          onEnabledChange={(v) => onEnabledChange(item.id, v)}
          onConnect={() => onConnect(item)}
          onDisconnect={() => onDisconnect(item)}
          onTest={onTest ? () => onTest(item) : undefined}
          onManage={item.source === "custom" && onManage ? () => onManage(item) : undefined}
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
  const [filter, setFilter] = React.useState<Filter>("all");
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

  const gridProps = {
    permissionsReady,
    busySlug,
    enabled,
    onEnabledChange,
    onConnect: connect,
    onDisconnect,
    onTest: onTestUserMcp,
    onManage: onManageCustom ? (item: DirectoryItem) => onManageCustom(item.id) : undefined,
    landedId,
  };

  // Bring your own: always the last tile of Available, unfiltered or not,
  // except while searching (it would read as a result).
  const addTile = onAddCustom && !q ? <AddServerTile index={availableItems.length} onClick={onAddCustom} /> : null;

  const skeletons = loading
    ? Array.from({ length: 6 }, (_, i) => <ConnectorTileSkeleton key={`sk-${i}`} index={i} />)
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
          <span className="ml-auto text-caption tabular-nums text-muted-foreground">
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
                <span className="text-micro tabular-nums opacity-70">{c.count}</span>
              )}
            </Pressable>
          ))}
        </div>
      )}

      <div className="mt-6">
        {/* Composio powers the long tail. Without it the native connectors still
            work, so explain what's missing instead of showing an empty page. */}
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
            <h2 className="text-heading">Connected</h2>
            <p className="mb-4 text-ui text-muted-foreground">Linked and available to your chats.</p>
            <TileGrid items={connectedItems} {...gridProps} />
          </div>
        )}

        {(availableItems.length > 0 || loading || addTile) && filter !== "connected" && (
          <div className={cn(connectedItems.length > 0 && "mt-8")}>
            <h2 className="text-heading">Available</h2>
            <p className="mb-4 text-ui text-muted-foreground">Connect an app to let Juno work inside it.</p>
            <TileGrid
              items={availableItems}
              {...gridProps}
              trailing={
                <>
                  {skeletons}
                  {addTile}
                </>
              }
            />
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
