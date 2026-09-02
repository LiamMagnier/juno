"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusIcons } from "@/lib/app-icons";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/components/app/app-provider";
import { TileSaveStatus, type TileSaveState } from "@/components/settings/tile";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";

const LANGUAGES = [
  "auto",
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Japanese",
  "Korean",
  "Chinese",
  "Hindi",
  "Arabic",
];

/**
 * A field that saves on blur and says so. The success signal used to be
 * silence, which a user cannot tell from a save that never happened.
 */
function useBlurSave<T>(current: T, write: (value: T) => Promise<boolean>) {
  const [state, setState] = React.useState<TileSaveState>("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const commit = async (value: T) => {
    if (value === current) return;
    clearTimeout(timer.current);
    setState("saving");
    const ok = await write(value);
    setState(ok ? "saved" : "failed");
    if (ok) timer.current = setTimeout(() => setState("idle"), 4000);
  };
  return { state, commit };
}

export function PersonalizationSection() {
  const router = useRouter();
  const { user, settings } = useApp();
  const save = useSettingsSave();

  const activePersonality = isPersonalityId(settings.personality) ? settings.personality : DEFAULT_PERSONALITY;
  const styleOption = useRadioGroup(
    PERSONALITIES,
    PERSONALITIES.findIndex((p) => p.id === activePersonality),
    (p) => void save({ personality: p.id })
  );

  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  const instructionsSave = useBlurSave(settings.customInstructions, (value) => save({ customInstructions: value }));

  const [name, setName] = React.useState(user.name ?? "");
  const nameSave = useBlurSave(user.name ?? "", async (value) => {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
    if (!res.ok) {
      toast.error("Could not save your name.");
      return false;
    }
    // The name is server-rendered into the bootstrap (sidebar, greeting), so
    // a refresh is what makes every surface agree.
    router.refresh();
    return true;
  });

  return (
    <>
      <SettingsGroup
        title="Response style"
        description="How Juno writes. Your custom instructions still take priority."
      >
        <SettingBlock label="Personality">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Response style">
            {PERSONALITIES.map((p, i) => {
              const selected = activePersonality === p.id;
              return (
                <Pressable
                  key={p.id}
                  kind="tile"
                  role="radio"
                  selected={selected}
                  aria-checked={selected}
                  onClick={() => void save({ personality: p.id })}
                  {...styleOption(i)}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                    {p.label}
                    {selected && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{p.description}</span>
                </Pressable>
              );
            })}
          </div>
        </SettingBlock>

        <SettingBlock
          label="Custom instructions"
          description="Juno keeps these in mind in every conversation. No character cap — the model's context window is the only limit."
          aside={<TileSaveStatus state={instructionsSave.state} failedMessage="Couldn't save. Your draft is still here." />}
        >
          <div className="relative">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => void instructionsSave.commit(instructions)}
              placeholder="E.g. I'm a product manager. Keep answers concise and use bullet points."
              className="min-h-28 pb-8"
              aria-label="Custom instructions"
            />
            <span className="absolute bottom-2.5 right-3 select-none font-mono text-caption text-muted-foreground">
              {instructions.length.toLocaleString()} chars
            </span>
          </div>
        </SettingBlock>

        <SettingRow
          label="Response language"
          description="The language Juno replies in."
          control={
            <Select value={settings.responseLanguage} onValueChange={(v) => void save({ responseLanguage: v })}>
              <SelectTrigger aria-label="Response language" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l === "auto" ? "Auto-detect" : l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Greeting" description="How Juno addresses you on a new chat.">
        <SettingRow
          label="What Juno calls you"
          htmlFor="greeting-name"
          description="Your first name opens every new conversation."
          control={
            <div className="flex items-center gap-2">
              <TileSaveStatus state={nameSave.state} failedMessage="Couldn't save." />
              <Input
                id="greeting-name"
                value={name}
                maxLength={80}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void nameSave.commit(name.trim())}
                className="w-52"
              />
            </div>
          }
        />
      </SettingsGroup>
    </>
  );
}
