"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Lock, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useApp } from "@/components/app/app-provider";
import { resolveModel, type ModelId, type ModelInfo } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { PLANS, planRank, effectiveMinPlan } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * Compact per-pane model picker — a light popover (logo + name + search),
 * deliberately smaller than the composer's full ModelSelector. Plan gating is
 * identical: locked models show their plan and route to /upgrade on click.
 */
export function CompareModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: ModelId;
  onChange: (id: ModelId) => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const { models, quota, features } = useApp();
  const plan = quota.plan;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const current = models.find((m) => m.id === value) ?? resolveModel(value);
  const q = query.trim().toLowerCase();

  // Chat models from configured providers only — same availability rules as the
  // main selector, minus image/video (they don't stream over /api/chat).
  const visible: ModelInfo[] = React.useMemo(
    () =>
      models.filter(
        (m) =>
          (m.modality ?? "chat") === "chat" &&
          !m.comingSoon &&
          features.providers.includes(m.provider) &&
          (!q ||
            m.name.toLowerCase().includes(q) ||
            m.providerModel.toLowerCase().includes(q) ||
            (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q))
      ),
    [features.providers, models, q]
  );

  const select = (m: ModelInfo) => {
    if (planRank(plan) < planRank(effectiveMinPlan(m.minPlan))) {
      setOpen(false);
      router.push("/upgrade");
      return;
    }
    onChange(m.id);
    setOpen(false);
  };

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="group inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[10px] px-2 text-[13px] font-medium text-foreground/80 transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60 data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:h-10"
        >
          {current && (
            <ProviderLogo
              provider={current.provider}
              className="h-4 w-4 shrink-0 rounded transition-transform duration-base ease-out-soft group-hover:scale-110"
            />
          )}
          <span className="truncate font-mono">{current?.name ?? "Select model"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="flex w-80 flex-col overflow-hidden p-0">
        <div className="relative border-b border-border/60 p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="h-8 pl-10"
            autoFocus
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">No models found.</p>
          ) : (
            visible.map((m) => {
              const locked = planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
              const active = m.id === value;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => select(m)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast hover:bg-accent coarse:py-2.5",
                    active && "bg-accent/60"
                  )}
                >
                  <ProviderLogo provider={m.provider} className="h-5 w-5 shrink-0 rounded-[28%]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {PROVIDERS[m.provider].label.split(" · ")[0]}
                  </span>
                  {locked ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-primary">
                      <Lock className="h-3 w-3" /> {PLANS[effectiveMinPlan(m.minPlan)].name}
                    </span>
                  ) : active ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
