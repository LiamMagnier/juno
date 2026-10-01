"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { ChoiceMenu, type ChoiceOption } from "@/components/settings/choice-menu";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { SENSITIVE_TOPICS, SENSITIVE_TOPIC_META } from "@/lib/memory-sensitive";
import type { ClientSettings } from "@/types/app";
import { PRODUCT_NAME } from "@/lib/brand/names";

type BackgroundMode = ClientSettings["backgroundProviderMode"];

/**
 * Where background work may run, in the words of what each mode does (read
 * off `resolveBackgroundCandidates` in @/lib/background-provider-policy).
 *
 * "Only my selected provider" is not offered: nothing in the product ever
 * lets a reader select that provider, so choosing it quietly stopped all
 * background work (`selected_provider_unavailable`). An account already on it
 * still sees it, named for what it now does, so the menu never shows a value
 * it has no row for.
 */
const BACKGROUND_OPTIONS: ChoiceOption<BackgroundMode>[] = [
  {
    value: "same_provider",
    label: "The lab I chat with",
    description: "A chat’s background work goes to the lab that answered it.",
  },
  {
    value: "any_allowed_provider",
    label: "Any configured lab",
    description: "Whichever lab on this server can do the job at the lowest cost.",
  },
  {
    value: "local_only",
    label: `${PRODUCT_NAME}’s own models only`,
    description: "Nothing goes to an outside lab. Some background work may not run.",
  },
];
const LEGACY_SELECTED_OPTION: ChoiceOption<BackgroundMode> = {
  value: "selected_provider",
  label: "A provider I chose",
  description: "No longer offered, and background work is paused on it. Pick another option.",
};

/**
 * What Juno may remember, and where the work of remembering runs. The
 * memories themselves are on /memory: this section used to embed the whole
 * memory manager (with a second Pause switch), and the two pages linked to
 * each other in a loop.
 */
export function MemorySection() {
  const { settings } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const allowed = React.useMemo(() => new Set(settings.memorySensitiveTopics), [settings.memorySensitiveTopics]);

  const toggleTopic = (topic: (typeof SENSITIVE_TOPICS)[number], on: boolean) => {
    const next = SENSITIVE_TOPICS.filter((id) => (id === topic ? on : allowed.has(id)));
    void saves.track(`topic:${topic}`, () => save({ memorySensitiveTopics: next }));
  };

  const backgroundOptions =
    settings.backgroundProviderMode === "selected_provider"
      ? [...BACKGROUND_OPTIONS, LEGACY_SELECTED_OPTION]
      : BACKGROUND_OPTIONS;

  return (
    <>
      <SettingsGroup>
        <SettingRow
          label="Reference saved memories"
          htmlFor="memory-enabled"
          description={`${PRODUCT_NAME} remembers lasting facts and preferences from your chats and uses them in later ones.`}
          status={saves.status("memoryEnabled")}
          control={
            <Switch
              id="memory-enabled"
              checked={settings.memoryEnabled}
              onCheckedChange={(memoryEnabled) => void saves.track("memoryEnabled", () => save({ memoryEnabled }))}
            />
          }
        />
        <SettingRow
          label="Learn from past chats in the background"
          htmlFor="memory-background-learning"
          description={`Between sessions, ${PRODUCT_NAME} reads older chats it hasn’t learned from yet, within your usage limits.`}
          status={saves.status("memoryBackgroundLearning")}
          control={
            <Switch
              id="memory-background-learning"
              checked={settings.memoryBackgroundLearning}
              disabled={!settings.memoryEnabled}
              onCheckedChange={(memoryBackgroundLearning) =>
                void saves.track("memoryBackgroundLearning", () => save({ memoryBackgroundLearning }))
              }
            />
          }
        />
        <SettingRow
          label="Memories"
          description={`See what ${PRODUCT_NAME} remembers, change it or forget it.`}
          control={
            <Button asChild variant="outline" size="sm">
              <Link href="/memory">Manage</Link>
            </Button>
          }
        />
      </SettingsGroup>

      {/*
       * OFF IS THE DEFAULT AND OFF IS THE POINT. The extractor is good at
       * noticing durable facts, which makes it equally good at noticing a
       * diagnosis mentioned once while drafting an email about it. Turning a
       * subject off does not delete what was learned while it was on: /memory
       * lists those facts with a Sensitive chip so they can be forgotten
       * deliberately. A switch that destroys data is a switch people are
       * afraid to touch.
       */}
      <SettingsGroup
        title="Sensitive subjects"
        description={`${PRODUCT_NAME} doesn’t learn these on its own. Anything you ask it to remember is always kept.`}
      >
        {SENSITIVE_TOPICS.map((topic) => (
          <SettingRow
            key={topic}
            label={SENSITIVE_TOPIC_META[topic].label}
            htmlFor={`memory-sensitive-${topic}`}
            description={SENSITIVE_TOPIC_META[topic].description}
            status={saves.status(`topic:${topic}`)}
            control={
              <Switch
                id={`memory-sensitive-${topic}`}
                checked={allowed.has(topic)}
                onCheckedChange={(on) => toggleTopic(topic, on)}
              />
            }
          />
        ))}
      </SettingsGroup>

      {/* Titled for what it governs. It sits here because memory is the
          biggest reader of your chats in the background, but the same rule
          covers chat titles, summaries and moderation, and the row says so. */}
      <SettingsGroup
        title="Background work"
        description="Memory, chat titles, summaries and moderation run without you asking."
      >
        <SettingRow
          label="Who may read your chats for it"
          description={backgroundOptions.find((o) => o.value === settings.backgroundProviderMode)?.description}
          wide
          status={saves.status("backgroundProviderMode")}
          control={
            <ChoiceMenu
              label="Who may read your chats for background work"
              value={settings.backgroundProviderMode}
              options={backgroundOptions}
              onChange={(backgroundProviderMode) => {
                if (backgroundProviderMode === settings.backgroundProviderMode) return;
                void saves.track("backgroundProviderMode", () => save({ backgroundProviderMode }));
              }}
              className="@[34rem]/pane:w-56"
            />
          }
        />
      </SettingsGroup>
    </>
  );
}
