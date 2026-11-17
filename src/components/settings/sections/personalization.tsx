"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useApp } from "@/components/app/app-provider";
import { ChoiceMenu } from "@/components/settings/choice-menu";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";
import {
  CHARACTERISTICS,
  normalizeCharacteristics,
  type CharacteristicKey,
  type CharacteristicLevel,
} from "@/lib/characteristics";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { ClientSettings } from "@/types/app";

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

/** Every characteristic offers the same three steps; Default injects nothing. */
const LEVEL_OPTIONS: readonly SegmentedOption<CharacteristicLevel>[] = [
  { value: "less", label: "Less" },
  { value: "default", label: "Default" },
  { value: "more", label: "More" },
];

/**
 * How Juno talks to you: what it calls you, what it keeps in mind, its tone
 * and its language.
 *
 * The name lives here and only here. Account had a second Name field with its
 * own save path, and the two could each show a different "Saved".
 */
/**
 * `page` is the Instructions page in Customize: the same fields and saves,
 * set as a writing page (a large field for the instructions, the
 * personalities as cards) rather than as settings rows.
 */
export function PersonalizationSection({ variant = "settings" }: { variant?: "settings" | "page" } = {}) {
  const router = useRouter();
  const { user, settings, features } = useApp();
  // The tone characteristics are drawn only while the server has them on
  // (TONE_CHARACTERISTICS_ENABLED, src/lib/env.ts).
  const toneOn = features.toneCharacteristics === true;
  const save = useSettingsSave();
  const saves = useSaveStates();

  const activePersonality = isPersonalityId(settings.personality) ? settings.personality : DEFAULT_PERSONALITY;
  const personalityOptions = React.useMemo(
    () => PERSONALITIES.map((p) => ({ value: p.id, label: p.label, description: p.description })),
    []
  );

  // Each characteristic is its own settings field, so two quick changes to
  // different rows are two independent writes (and two rollbacks).
  const characteristics = normalizeCharacteristics(settings);
  const saveCharacteristic = (key: CharacteristicKey, level: CharacteristicLevel) => {
    if (characteristics[key] === level) return;
    const patch: Partial<Pick<ClientSettings, CharacteristicKey>> = {};
    patch[key] = level;
    void saves.track(key, () => save(patch));
  };

  const [name, setName] = React.useState(user.name ?? "");
  // The name last sent, so the unmount flush below does not send it again
  // while the refresh that brings `user.name` up to date is still on its way.
  const nameSent = React.useRef<string | null>(null);
  React.useEffect(() => {
    nameSent.current = null;
  }, [user.name]);
  const saveName = () => {
    const value = name.trim();
    if (value === (user.name ?? "") || value === nameSent.current) return;
    nameSent.current = value;
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
        if (nameSent.current === value) nameSent.current = null;
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

  // A draft still being typed is saved when the section goes away, not only
  // on blur. Escape, ⌘, or a navigation unmounts the section with the field
  // still focused, and React never hears that field's blur (the browser fires
  // it on a node already detached from the root), so the text was dropped.
  // Each saver returns early when there is nothing new, so a field that did
  // blur first is not saved twice.
  const flushDrafts = React.useRef<() => void>(() => {});
  React.useLayoutEffect(() => {
    flushDrafts.current = () => {
      saveName();
      saveInstructions();
    };
  });
  React.useEffect(() => {
    const flush = flushDrafts;
    return () => flush.current();
  }, []);

  /*
   * ONE DRAWING FOR BOTH PLACES (owner, 17 Nov 2026: "rework memory,
   * instructions and all those pages"). The Customize page drew these same
   * settings a second way: sections with a mono side-note, a word counter, and
   * six bordered radio cards with a lift under the pointer. It now draws the
   * Settings pane's groups (rows on hairlines, a title and one sentence per
   * group, the personality as one menu with its description under the label),
   * inside the page's container, so a setting looks the same wherever it is
   * changed. The page keeps a taller field for the instructions.
   */
  const body = (
    <>
      <SettingsGroup>
        <SettingRow
          label={`What ${PRODUCT_NAME} calls you`}
          htmlFor="personal-name"
          description="Used in greetings, and shown in the sidebar."
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
          description={`${PRODUCT_NAME} keeps these in mind in every conversation.`}
          status={saves.status("customInstructions")}
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={saveInstructions}
            placeholder="For example: I’m a product manager. Keep answers short and use bullet points."
            className={variant === "page" ? "min-h-48" : "min-h-32"}
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
          description={`The language ${PRODUCT_NAME} replies in.`}
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

      {toneOn && (
      <SettingsGroup title="Characteristics" description="Tune the personality’s tone. Your custom instructions still take priority.">
        {CHARACTERISTICS.map((c) => (
          <SettingRow
            key={c.key}
            label={c.label}
            description={c.description}
            wide
            status={saves.status(c.key)}
            control={
              <SegmentedControl
                ariaLabel={c.label}
                value={characteristics[c.key]}
                onChange={(level) => saveCharacteristic(c.key, level)}
                options={LEVEL_OPTIONS}
                className="w-full @[34rem]/pane:w-auto"
              />
            }
          />
        ))}
      </SettingsGroup>
      )}
    </>
  );
  return variant === "page" ? <div className="@container/pane">{body}</div> : body;
}
