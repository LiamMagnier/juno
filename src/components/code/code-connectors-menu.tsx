"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, Plug, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Switch } from "@/components/ui/switch";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { cn } from "@/lib/utils";

export interface CodeConnectorItem {
  id: string;
  label: string;
  description: string;
  category?: "dev" | "data" | "productivity" | "search";
  connected: boolean;
  configured?: boolean;
}

const DEFAULT_DEV_CONNECTORS: CodeConnectorItem[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Read & write code, commits, issues, and open pull requests.",
    category: "dev",
    connected: true,
    configured: true,
  },
  {
    id: "terminal",
    label: "Terminal & Shell",
    description: "Execute CLI commands, test suites, linter, and package managers.",
    category: "dev",
    connected: true,
    configured: true,
  },
  {
    id: "web-search",
    label: "Web Search",
    description: "Search live documentation, libraries, StackOverflow, and APIs.",
    category: "search",
    connected: true,
    configured: true,
  },
  {
    id: "postgres",
    label: "PostgreSQL & Database",
    description: "Inspect schema tables, analyze relations, verify SQL migrations.",
    category: "data",
    connected: true,
    configured: true,
  },
  {
    id: "linear",
    label: "Linear",
    description: "Link GitHub tasks to Linear issues and synchronize status.",
    category: "productivity",
    connected: true,
    configured: true,
  },
  {
    id: "notion",
    label: "Notion",
    description: "Search product specs, engineering RFCs, and documentation.",
    category: "productivity",
    connected: true,
    configured: true,
  },
  {
    id: "slack",
    label: "Slack",
    description: "Fetch bug reports, discussions, and post execution updates.",
    category: "productivity",
    connected: true,
    configured: true,
  },
];

interface CodeConnectorsMenuProps {
  enabledConnectors: string[];
  onToggleConnector: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

export function CodeConnectorsMenu({
  enabledConnectors,
  onToggleConnector,
  disabled,
  className,
}: CodeConnectorsMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [apiConnectors, setApiConnectors] = React.useState<CodeConnectorItem[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/connectors");
        if (!res.ok) return;
        const data = (await res.json()) as {
          connectors?: { id: string; label: string; description?: string; connected: boolean; configured?: boolean }[];
        };
        if (!cancelled && data.connectors) {
          const mapped: CodeConnectorItem[] = data.connectors.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description || "Integrate with Juno Code tasks.",
            connected: c.connected,
            configured: c.configured,
          }));
          setApiConnectors(mapped);
        }
      } catch {
        // Fallback to default dev connectors
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Merge API connectors with default dev connectors (ensuring defaults exist if API hasn't registered them)
  const allConnectors = React.useMemo(() => {
    const map = new Map<string, CodeConnectorItem>();
    DEFAULT_DEV_CONNECTORS.forEach((c) => map.set(c.id, c));
    apiConnectors.forEach((c) => {
      const existing = map.get(c.id);
      map.set(c.id, {
        ...existing,
        ...c,
        connected: c.connected || existing?.connected || false,
      });
    });
    return Array.from(map.values());
  }, [apiConnectors]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return allConnectors;
    const q = query.toLowerCase();
    return allConnectors.filter(
      (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    );
  }, [allConnectors, query]);

  const activeCount = enabledConnectors.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`Connectors: ${activeCount} active`}
              className={cn(
                composerChipClass,
                "px-2",
                activeCount > 0 ? "text-primary-ink hover:text-primary-ink" : "text-muted-foreground",
                className
              )}
            >
              <Plug className={cn("size-3.5 shrink-0", activeCount > 0 && "text-primary")} aria-hidden="true" />
              <span className="min-w-0 truncate">
                {activeCount === 0 ? "Connectors" : `Connectors (${activeCount})`}
              </span>
              <ChevronDown className={composerChevronClass} />
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent>Connected tools & integrations</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[320px] origin-popper p-3 sm:w-[350px]"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5">
              <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-semibold">Connectors and tools</span>
            </div>
            <Badge variant={activeCount > 0 ? "soft" : "muted"} className="tabular-nums">
              {activeCount} active
            </Badge>
          </div>

          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools and connectors…"
              aria-label="Search tools and connectors"
              className="h-8 pl-8.5 pr-3 text-ui coarse:h-11"
            />
          </div>

          <ScrollFade className="max-h-[260px] overflow-y-auto">
            <div className="space-y-0.5 pr-1">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  No connectors found for &ldquo;{query}&rdquo;
                </div>
              ) : (
                filtered.map((item) => {
                  const isEnabled = enabledConnectors.includes(item.id);
                  return (
                    // A row, not a button: the switch inside it is the control,
                    // and a button wrapping a switch is one control inside
                    // another. The row's own press toggles too, via the label.
                    <div
                      key={item.id}
                      className={cn(
                        "group flex items-start justify-between gap-3 rounded-control border border-transparent px-2 py-2 transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
                        isEnabled && "surface-raised border-border/60 hover:bg-card",
                      )}
                    >
                      <label htmlFor={`code-connector-${item.id}`} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                        <span
                          className={cn(
                            "surface-inset flex size-7 shrink-0 items-center justify-center rounded-md",
                            isEnabled ? "text-primary" : "text-muted-foreground",
                          )}
                        >
                          <ConnectorMark id={item.id} className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">{item.label}</span>
                          <span className="mt-0.5 line-clamp-2 block text-caption leading-tight text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </label>

                      <Switch
                        id={`code-connector-${item.id}`}
                        checked={isEnabled}
                        onCheckedChange={() => onToggleConnector(item.id)}
                        className="mt-0.5 shrink-0 scale-75"
                      />
                    </div>
                  );
                })
              )}
            </div>
          </ScrollFade>

          <div className="flex items-center justify-between border-t border-border/60 px-1 pt-2 text-caption">
            <Link
              href="/connections"
              className="inline-flex items-center gap-1 rounded-xs text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
            >
              <span>Manage all connections</span>
              <ExternalLink className="size-3" aria-hidden="true" />
            </Link>
            {activeCount > 0 && (
              <Pressable
                kind="chip"
                size="sm"
                onClick={() => enabledConnectors.forEach((id) => onToggleConnector(id))}
                className="font-mono"
              >
                Clear all
              </Pressable>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function CodeActiveConnectorsBar({
  enabledConnectors,
  onToggleConnector,
  className,
}: {
  enabledConnectors: string[];
  onToggleConnector: (id: string) => void;
  className?: string;
}) {
  if (enabledConnectors.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {enabledConnectors.map((id) => {
        const item = DEFAULT_DEV_CONNECTORS.find((c) => c.id === id) || {
          id,
          label: id.charAt(0).toUpperCase() + id.slice(1),
        };
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 pl-2 pr-1.5 py-0.5 text-caption font-medium text-foreground transition-[color,background-color,border-color,box-shadow,transform,opacity,width] duration-fast hover:bg-primary/15"
          >
            <ConnectorMark id={id} className="size-3 text-primary shrink-0" />
            <span className="truncate max-w-[120px]">{item.label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleConnector(id);
              }}
              aria-label={`Remove ${item.label} connector`}
              className="flex size-3.5 items-center justify-center rounded-full hover:bg-primary/20 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-2.5" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
