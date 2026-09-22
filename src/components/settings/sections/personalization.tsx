"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/components/app/app-provider";
import { ChoiceMenu } from "@/components/settings/choice-menu";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";

/** Reply languages, stored by their English name, which is what the prompt builder reads. */
const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Match my message" },
  { value: "English", label: "English" },
  { value: "Spanish", label: "Spanish" },
  { value: "French", label: "French" },
  { value: "German", label: "German" },
  { value: "Portuguese", label: "Portuguese" },
  { value: "Italian", label: "Italian" },
  { value: "Japanese", label: "Japanese" },
  { value: "Korean", label: "Korean" },
  { value: "Chinese", label: "Chinese" },
  { value: "Hindi", label: "Hindi" },
  { value: "Arabic", label: "Arabic" },
];

/**
 * How Juno talks to you: what it calls you, what it keeps in mind, its tone
 * and its language.
 *
 * The name lives here and only here. Account had a second Name field with its
 * own save path, and the two could each show a different "Saved".
 */
export function PersonalizationSection() {
  const router = useRouter();
  const { user, settings } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const activePersonality = isPersonalityId(settings.personality) ? settings.personality : DEFAULT_PERSONALITY;
  const personalityOptions = React.useMemo(
    () => PERSONALITIES.map((p) => ({ value: p.id, label: p.label, description: p.description })),
    []
  );

  const [name, setName] = React.useState(user.name ?? "");
  const saveName = () => {
    const value = name.trim();
    if (value === (user.name ?? "")) return;
    void saves.track("name", async () => {
      // Not through useSettingsSave: the name is a User column, not a
      // Settings one, and it is server-rendered into the bootstrap (sidebar,
      // greeting), so a refresh is what makes every surface agree.
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      }).catch(() => null);
      if (!res?.ok) {
        toast.error("Couldn’t save your name.");
        return false;
      }
      router.refresh();
      return true;
    });
  };

  // A language set elsewhere (a native app, an older build) still shows as
  // itself rather than as an empty select.
  const languages = LANGUAGES.some((l) => l.value === settings.responseLanguage)
    ? LANGUAGES
    : [...LANGUAGES, { value: settings.responseLanguage, label: settings.responseLanguage }];

  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  const saveInstructions = () => {
    if (instructions === settings.customInstructions) return;
    void saves.track("customInstructions", () => save({ customInstructions: instructions }));
  };

  return (
    <>
      <SettingsGroup>
        <SettingRow
          label="What Juno calls you"
          htmlFor="personal-name"
          description="Used in greetings, and shown on anything you share."
          wide
          status={saves.status("name")}
          control={
            <Input
              id="personal-name"
              value={name}
              maxLength={80}
              placeholder="Your name"
              autoComplete="given-name"
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="w-full @[34rem]/pane:w-56"
            />
          }
        />
        <SettingBlock
          label="Custom instructions"
          description="Juno keeps these in mind in every conversation."
          status={saves.status("customInstructions")}
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={saveInstructions}
            placeholder="For example: I’m a product manager. Keep answers short and use bullet points."
            className="min-h-32"
            aria-label="Custom instructions"
          />
        </SettingBlock>
      </SettingsGroup>

      <SettingsGroup title="Responses" description="Your custom instructions take priority over both.">
        <SettingRow
          label="Personality"
          description={PERSONALITIES.find((p) => p.id === activePersonality)?.description}
          wide
          status={saves.status("personality")}
          control={
            <ChoiceMenu
              label="Personality"
              value={activePersonality}
              options={personalityOptions}
              onChange={(personality) => {
                if (personality === activePersonality) return;
                void saves.track("personality", () => save({ personality }));
              }}
              className="@[34rem]/pane:w-52"
            />
          }
        />
        <SettingRow
          label="Response language"
          description="The language Juno replies in."
          wide
          status={saves.status("responseLanguage")}
          control={
            <Select
              value={settings.responseLanguage}
              onValueChange={(responseLanguage) =>
                void saves.track("responseLanguage", () => save({ responseLanguage }))
              }
            >
              <SelectTrigger aria-label="Response language" className="w-full @[34rem]/pane:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>
    </>
  );
}
