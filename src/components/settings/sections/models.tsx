"use client";

import * as React from "react";
import { Plus, Star } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp, type ReasoningEffort } from "@/components/app/app-provider";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ModelCombobox, ModelTrigger } from "@/components/settings/model-picker";
import { AUTO_MODEL_ID_SETTING, chatModels, providerName } from "@/components/settings/model-list";
import { SaveStatus, useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { DEFAULT_AUTO_PREFERENCE, type AutoPreference } from "@/lib/router/decide";
import { DEFAULT_AUTO_DATA_BOUNDARY, type AutoDataBoundary } from "@/lib/router/data-policy";

const EFFORTS: { value: Exclude<ReasoningEffort, null>; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];
const AUTO_EFFORT = "__auto__";

/** What Auto weighs (src/lib/router/decide.ts PREFERENCE_WEIGHTS), in the words of what each does. */
const AUTO_PREFERENCE_OPTIONS: { value: AutoPreference; label: string; description: string }[] = [
  {
    value: "balanced",
    label: "Balanced",
    description: "Auto weighs the price of each answer against the chance it has to be asked again.",
  },
  {
    value: "quality",
    label: "Best answer",
    description: "Auto pays more for a better chance of getting it right the first time.",
  },
  {
    value: "economy",
    label: "Lowest cost",
    description: "Auto prefers cheaper models and accepts that some answers may need a retry.",
  },
];

/** Which providers Auto may choose (src/lib/router/data-policy.ts). Every option already excludes training. */
const AUTO_BOUNDARY_OPTIONS: { value: AutoDataBoundary; label: string; description: string }[] = [
  {
    value: "verified_no_training",
    label: "Any lab that doesn’t train on it",
    description:
      "Auto only uses labs whose published terms say they don’t train on what you send. Labs whose terms haven’t been checked are left out.",
  },
  {
    value: "exclude_prc",
    label: "Leave out China-based labs",
    description: "The same, and Auto never chooses a lab headquartered in China. You can still pick one yourself.",
  },
  {
    value: "eu_us_only",
    label: "EU and US labs only",
    description: "The same, and Auto only chooses labs based in the EU or the US.",
  },
];

/**
 * One pinned model: its lab's mark, its name, and the filled star that unpins
 * it. The star button is named "Unpin" followed by the model's name, built
 * from the two visible words rather than a sentence with the name spliced in,
 * so the translated interface can still name it.
 */
function PinnedModelRow({ model, onUnpin }: { model: ModelInfo; onUnpin: () => void }) {
  const id = React.useId();
  return (
    <div className="flex min-h-12 items-center gap-3 py-1.5">
      <ProviderLogo provider={model.provider} className="size-4 text-foreground" />
      <span id={`${id}-name`} className="min-w-0 flex-1 truncate text-body" translate="no">
        {model.name}
      </span>
      <span className="hidden shrink-0 text-ui text-muted-foreground @[28rem]/pane:inline" translate="no">
        {providerName(model.provider)}
      </span>
      <span id={`${id}-verb`} hidden>
        Unpin
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-labelledby={`${id}-verb ${id}-name`}
            onClick={onUnpin}
            className="-mr-2 text-primary hover:text-primary"
          >
            <Star className="size-4 fill-current" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Unpin</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Which model answers by default, how it starts each message, and which
 * models lead the picker.
 *
 * Two different kinds of setting live here and the groups say which is which:
 * the default model and the favorites belong to the account and follow you to
 * every device; the composer's starting effort, fast mode and web search are
 * kept in this browser (`composerPrefs`, localStorage). The old Defaults
 * group mixed the two without a word, so a change made on a laptop quietly
 * failed to appear on a phone.
 */
export function ModelsSection() {
  const { settings, quota, models, composerPrefs, setComposerPrefs } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const chat = React.useMemo(() => chatModels(models), [models]);
  const defaultId = settings.defaultModel === "auto" ? AUTO_MODEL_ID_SETTING : settings.defaultModel;
  const resolvedDefault = defaultId === AUTO_MODEL_ID_SETTING ? null : resolveModel(defaultId);
  const defaultModel = resolvedDefault
    ? (chat.find((m) => m.id === resolvedDefault.id) ?? resolvedDefault)
    : null;
  const defaultSet = React.useMemo(
    () => new Set([resolvedDefault?.id ?? AUTO_MODEL_ID_SETTING]),
    [resolvedDefault?.id]
  );

  const favorites = React.useMemo(() => new Set(settings.favoriteModels), [settings.favoriteModels]);
  const pinned = React.useMemo(
    () =>
      settings.favoriteModels
        .map((id) => chat.find((m) => m.id === id) ?? resolveModel(id))
        .filter((m): m is NonNullable<typeof m> => m !== null),
    [chat, settings.favoriteModels]
  );

  // The device-local defaults write to this browser at once and cannot fail,
  // but they confirm the same way the account's settings do, so a reader
  // does not have to know which kind of setting they just changed.
  const keep = (key: string, patch: Parameters<typeof setComposerPrefs>[0]) =>
    void saves.track(key, async () => {
      setComposerPrefs(patch);
      return true;
    });

  const toggleFavorite = (id: string) => {
    const next = favorites.has(id)
      ? settings.favoriteModels.filter((m) => m !== id)
      : [...settings.favoriteModels, id];
    void saves.track("favoriteModels", () => save({ favoriteModels: next }));
  };

  return (
    <>
      <SettingsGroup>
        <SettingRow
          label="Default model"
          description={
            defaultModel
              ? "New chats start on this model. You can switch in any message."
              : `${PRODUCT_NAME} picks the model and thinking depth each message needs.`
          }
          wide
          status={saves.status("defaultModel")}
          control={
            <ModelCombobox
              models={chat}
              plan={quota.plan}
              mode="single"
              includeAuto
              selected={defaultSet}
              label="Default model"
              onSelect={(defaultModelId) => {
                if (defaultModelId === (resolvedDefault?.id ?? AUTO_MODEL_ID_SETTING)) return;
                void saves.track("defaultModel", () => save({ defaultModel: defaultModelId }));
              }}
            >
              <ModelTrigger model={defaultModel} label="Default model" className="w-full @[34rem]/pane:w-64" />
            </ModelCombobox>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Auto"
        description="How Auto chooses when it picks the model for you. Choosing a model yourself always overrides it."
      >
        <SettingRow
          label="Optimise for"
          description={AUTO_PREFERENCE_OPTIONS.find((o) => o.value === (settings.autoPreference ?? DEFAULT_AUTO_PREFERENCE))?.description}
          wide
          status={saves.status("autoPreference")}
          control={
            <Select
              value={settings.autoPreference ?? DEFAULT_AUTO_PREFERENCE}
              onValueChange={(v) => void saves.track("autoPreference", () => save({ autoPreference: v as AutoPreference }))}
            >
              <SelectTrigger aria-label="What Auto optimises for" className="w-full @[34rem]/pane:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_PREFERENCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          label="Labs Auto may use"
          description={AUTO_BOUNDARY_OPTIONS.find((o) => o.value === (settings.autoDataBoundary ?? DEFAULT_AUTO_DATA_BOUNDARY))?.description}
          wide
          status={saves.status("autoDataBoundary")}
          control={
            <Select
              value={settings.autoDataBoundary ?? DEFAULT_AUTO_DATA_BOUNDARY}
              onValueChange={(v) => void saves.track("autoDataBoundary", () => save({ autoDataBoundary: v as AutoDataBoundary }))}
            >
              <SelectTrigger aria-label="Labs Auto may use" className="w-full @[34rem]/pane:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_BOUNDARY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="On this device" description="Where each new message starts in this browser. The composer can change any of them.">
        <SettingRow
          label="Thinking effort"
          description="How long a model thinks before it answers. Higher is slower and costs more."
          wide
          status={saves.status("reasoningEffort")}
          control={
            <Select
              value={composerPrefs.reasoningEffort ?? AUTO_EFFORT}
              onValueChange={(v) =>
                keep("reasoningEffort", { reasoningEffort: v === AUTO_EFFORT ? null : (v as ReasoningEffort) })
              }
            >
              <SelectTrigger aria-label="Thinking effort" className="w-full @[34rem]/pane:w-40">
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
          status={saves.status("fastMode")}
          control={
            <Switch
              id="fast-mode"
              checked={composerPrefs.fastMode}
              onCheckedChange={(fastMode) => keep("fastMode", { fastMode })}
            />
          }
        />
        <SettingRow
          label="Web search"
          htmlFor="web-search"
          description="Let models look things up when a message needs current information."
          status={saves.status("webSearch")}
          control={
            <Switch
              id="web-search"
              checked={composerPrefs.webSearch}
              onCheckedChange={(webSearch) => keep("webSearch", { webSearch })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Favorites"
        description="Pinned models lead the model picker, in this order."
        aside={
          <div className="flex items-center gap-3">
            <SaveStatus state={saves.status("favoriteModels")} />
            <ModelCombobox
              models={chat}
              plan={quota.plan}
              mode="multi"
              selected={favorites}
              label="Pin models"
              onSelect={toggleFavorite}
            >
              <Button variant="outline" size="sm">
                <Plus className="size-4" aria-hidden="true" />
                Add
              </Button>
            </ModelCombobox>
          </div>
        }
      >
        {pinned.length === 0 ? (
          <p className="py-4 text-ui text-muted-foreground">Nothing pinned yet.</p>
        ) : (
          pinned.map((m) => <PinnedModelRow key={m.id} model={m} onUnpin={() => toggleFavorite(m.id)} />)
        )}
      </SettingsGroup>
    </>
  );
}
