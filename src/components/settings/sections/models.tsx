"use client";

import * as React from "react";
import { Star } from "lucide-react";
import { Pressable } from "@/components/ui/pressable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApp, type ReasoningEffort } from "@/components/app/app-provider";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { resolveModel } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { canUseModel } from "@/lib/plans";

const EFFORTS: { value: Exclude<ReasoningEffort, null>; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];
const AUTO_EFFORT = "__auto__";

export function ModelsSection() {
  const { settings, quota, models, composerPrefs, setComposerPrefs } = useApp();
  const save = useSettingsSave();

  const chatModels = React.useMemo(() => models.filter((m) => (m.modality ?? "chat") === "chat"), [models]);
  const favorites = new Set(settings.favoriteModels);

  const toggleFavorite = (id: string) => {
    const next = favorites.has(id)
      ? settings.favoriteModels.filter((m) => m !== id)
      : [...settings.favoriteModels, id];
    void save({ favoriteModels: next });
  };

  return (
    <>
      <SettingsGroup title="Defaults" description="The starting point for every new conversation. Anything here can be changed per message.">
        <SettingRow
          label="Default model"
          description="Auto routes each prompt to the cheapest model that can handle it."
          control={
            <Select
              value={resolveModel(settings.defaultModel)?.id ?? settings.defaultModel}
              onValueChange={(v) => void save({ defaultModel: v })}
            >
              <SelectTrigger aria-label="Default model" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="juno:auto">Auto</SelectItem>
                {chatModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!canUseModel(quota.plan, m.id)}>
                    {m.name}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      · {(PROVIDERS[m.provider]?.label ?? m.provider).split(" · ")[0]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          label="Reasoning effort"
          description="How long a model thinks before answering. Higher is slower and costs more."
          control={
            <Select
              value={composerPrefs.reasoningEffort ?? AUTO_EFFORT}
              onValueChange={(v) =>
                setComposerPrefs({ reasoningEffort: v === AUTO_EFFORT ? null : (v as ReasoningEffort) })
              }
            >
              <SelectTrigger aria-label="Reasoning effort" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_EFFORT}>Auto</SelectItem>
                {EFFORTS.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          label="Fast mode"
          htmlFor="fast-mode"
          description="Prefer the quickest capable model and skip extended thinking."
          control={
            <Switch
              id="fast-mode"
              checked={composerPrefs.fastMode}
              onCheckedChange={(v) => setComposerPrefs({ fastMode: v })}
            />
          }
        />
        <SettingRow
          label="Web search"
          htmlFor="web-search"
          description="Let models look things up when a prompt needs current information."
          control={
            <Switch
              id="web-search"
              checked={composerPrefs.webSearch}
              onCheckedChange={(v) => setComposerPrefs({ webSearch: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Favorites"
        description="Pinned to the top of the model picker."
        aside={
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {favorites.size} pinned
          </span>
        }
      >
        <SettingBlock label="Models">
          <div className="flex flex-wrap gap-2">
            {chatModels.map((m) => {
              const selected = favorites.has(m.id);
              const locked = !canUseModel(quota.plan, m.id);
              return (
                <Pressable
                  key={m.id}
                  kind="chip"
                  size="lg"
                  selected={selected}
                  aria-pressed={selected}
                  disabled={locked}
                  onClick={() => toggleFavorite(m.id)}
                  title={locked ? "Not on your plan" : undefined}
                >
                  <ProviderLogo provider={m.provider} className="size-3.5" />
                  {m.name}
                  {selected && <Star className="size-3 fill-current" aria-hidden="true" />}
                </Pressable>
              );
            })}
          </div>
        </SettingBlock>
      </SettingsGroup>
    </>
  );
}
