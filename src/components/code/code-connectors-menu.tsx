"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, Plug, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
                "composer-chip group relative h-8 shrink-0 items-center gap-1.5 rounded-composer-control px-2.5 font-mono text-ui tracking-tight coarse:h-11 transition-all duration-fast",
                activeCount > 0 ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground",
                className
              )}
            >
              <Plug className={cn("size-3.5 shrink-0 transition-transform duration-fast group-hover:scale-110", activeCount > 0 && "text-primary")} />
              <span className="min-w-0 font-medium">
                {activeCount === 0 ? "Connectors" : `Connectors (${activeCount})`}
              </span>
              <ChevronDown className="size-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent>Connected tools & integrations</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[320px] origin-popper rounded-2xl border border-border/80 bg-popover/95 p-3 text-popover-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#161618]/95 sm:w-[350px]"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5">
              <Plug className="size-4 text-primary" />
              <span className="text-sm font-semibold tracking-tight">Connectors & Tools</span>
            </div>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-caption font-medium text-primary">
              {activeCount} active
            </span>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools & connectors…"
              className="h-8 rounded-lg pl-8 pr-3 text-xs bg-muted/30 focus:bg-background"
            />
          </div>

          <ScrollFade className="max-h-[260px] overflow-y-auto">
            <div className="space-y-1 pr-1">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  No connectors found for &ldquo;{query}&rdquo;
                </div>
              ) : (
                filtered.map((item) => {
                  const isEnabled = enabledConnectors.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      onClick={() => onToggleConnector(item.id)}
                      className={cn(
                        "group flex cursor-pointer items-start justify-between gap-3 rounded-xl p-2 transition-colors",
                        isEnabled ? "bg-primary/8 hover:bg-primary/12" : "hover:bg-muted/50"
                      )}
                    >
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
                            isEnabled
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border/60 bg-muted/40 text-muted-foreground group-hover:text-foreground"
                          )}
                        >
                          <ConnectorMark id={item.id} className="size-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-foreground">{item.label}</span>
                            {isEnabled && (
                              <span className="size-1.5 rounded-full bg-primary" />
                            )}
                          </div>
                          <p className="line-clamp-2 text-caption leading-tight text-muted-foreground mt-0.5">
                            {item.description}
                          </p>
                        </div>
                      </div>

                      <Switch
                        checked={isEnabled}
                        onCheckedChange={() => onToggleConnector(item.id)}
                        className="scale-75 shrink-0 mt-0.5"
                      />
                    </div>
                  );
                })
              )}
            </div>
          </ScrollFade>

          <div className="flex items-center justify-between border-t border-border/40 pt-2 px-1 text-caption">
            <Link
              href="/connections"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>Manage all connections</span>
              <ExternalLink className="size-3" />
            </Link>
            {activeCount > 0 && (
              <button
                type="button"
                onClick={() => enabledConnectors.forEach((id) => onToggleConnector(id))}
                className="text-muted-foreground hover:text-destructive transition-colors font-mono"
              >
                Clear all
              </button>
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
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 pl-2 pr-1.5 py-0.5 text-caption font-medium text-foreground transition-all duration-fast hover:bg-primary/15"
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
