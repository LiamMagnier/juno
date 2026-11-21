"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { ACCENTS } from "@/lib/accents";
import { BUILT_IN_DESIGNS, parseDesignPreset, validateDesignPreset, type DesignPreset } from "@/lib/design-presets";
import { readUiPrefs, useUiPref, writeUiPrefs, type ComposerShape } from "@/lib/ui-prefs";
import { useApp } from "@/components/app/app-provider";
import { Trash2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useSettingsSave } from "./use-settings-save";

const SHAPES: { value: ComposerShape; label: string }[] = [
  { value: "compact", label: "Tight" },
  { value: "standard", label: "Standard" },
  { value: "soft", label: "Rounder" },
];
const MAX_DESIGNS = 24;

function readSavedDesigns(key: string): DesignPreset[] {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return Array.isArray(data) ? data.slice(0, MAX_DESIGNS).map(validateDesignPreset).filter((item) => item !== null) : [];
  } catch {
    return [];
  }
}

function designColor(preset: DesignPreset) {
  return ACCENTS.find(({ id }) => id === preset.accent)?.color ?? preset.accent;
}

export function DesignsView() {
  const { settings, user } = useApp();
  const { setTheme } = useTheme();
  const save = useSettingsSave();
  const [composerShape, setComposerShape] = useUiPref("composerShape");
  const [chatFont] = useUiPref("chatFont");
  const [transcriptWidth] = useUiPref("transcriptWidth");
  const [saved, setSaved] = React.useState<DesignPreset[]>([]);
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const key = `alevr:designs:v1:${user.id}`;
  const id = React.useId();

  React.useEffect(() => setSaved(readSavedDesigns(key)), [key]);

  const matches = (preset: DesignPreset) => settings.accent === preset.accent && settings.theme === preset.theme &&
    composerShape === preset.composerShape && chatFont === preset.chatFont && transcriptWidth === preset.transcriptWidth;

  function add(preset: DesignPreset | null) {
    if (!preset) {
      setNotice({ text: "Enter a valid design name or paste a complete design code.", error: true });
      return false;
    }
    if (saved.length >= MAX_DESIGNS || saved.some((design) => design.name.toLowerCase() === preset.name.toLowerCase())) {
      setNotice({ text: saved.length >= MAX_DESIGNS ? "This device already has 24 saved designs." : "A design with that name is already saved.", error: true });
      return false;
    }
    try {
      const next = [...saved, preset];
      window.localStorage.setItem(key, JSON.stringify(next));
      setSaved(next);
      setNotice({ text: `Saved ${preset.name} on this device.` });
      return true;
    } catch {
      setNotice({ text: "This browser couldn’t save the design.", error: true });
      return false;
    }
  }

  async function apply(preset: DesignPreset) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setTheme(preset.theme);
    document.documentElement.dataset.accent = preset.accent;
    const ok = await save({ theme: preset.theme, accent: preset.accent }, {
      onRollback: (restored) => {
        if (restored.theme) setTheme(restored.theme);
        if (restored.accent) document.documentElement.dataset.accent = restored.accent;
      },
    });
    setBusy(false);
    if (!ok) {
      setNotice({ text: "The design couldn’t be applied. Try again.", error: true });
      return;
    }
    writeUiPrefs({ chatFont: preset.chatFont, transcriptWidth: preset.transcriptWidth, composerShape: preset.composerShape });
    setNotice({ text: `Applied ${preset.name}.` });
  }

  async function share(preset: DesignPreset) {
    const text = JSON.stringify(preset);
    setCode(text);
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ text: "Design code copied." });
    } catch {
      setNotice({ text: "Copy the design code below to share it." });
    }
  }

  function remove(preset: DesignPreset) {
    try {
      const next = saved.filter((design) => design.name !== preset.name);
      window.localStorage.setItem(key, JSON.stringify(next));
      setSaved(next);
      setNotice({ text: `Removed ${preset.name} from this device.` });
    } catch {
      setNotice({ text: "This browser couldn’t remove the design.", error: true });
    }
  }

  return (
    <section aria-label="Design options" className="space-y-6 motion-safe:animate-fade-in">
      <section aria-label="Preset designs">
        <ul className="grid grid-cols-3 gap-2 sm:gap-3">
          {BUILT_IN_DESIGNS.map((preset) => (
            <li key={preset.name} className="min-w-0">
              <button
                type="button"
                disabled={busy}
                aria-label={`Apply ${preset.name}`}
                aria-pressed={matches(preset)}
                onClick={() => void apply(preset)}
                className="nest-card nest-p-2 w-full border border-border text-start transition-colors duration-fast hover:bg-accent aria-pressed:border-primary focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className={cn("flex h-12 items-center justify-center gap-1 rounded-inner border border-black/10 sm:h-16", preset.theme === "dark" ? "bg-neutral-900" : "bg-neutral-100")}
                >
                  <span className={cn("flex h-6 w-3/5 items-center justify-end border px-1", preset.theme === "dark" ? "border-white/15 bg-white/10" : "border-black/10 bg-white", { compact: "rounded-sm", standard: "rounded-control", soft: "rounded-full" }[preset.composerShape])}>
                    <span className="size-3 rounded-full" style={{ backgroundColor: designColor(preset) }} />
                  </span>
                </span>
                <span className="block truncate px-0.5 pb-0.5 pt-2 text-ui font-medium">{preset.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-5">
        <p className="text-ui font-medium">Composer corners</p>
        <SegmentedControl ariaLabel="Composer corners" value={composerShape} options={busy ? SHAPES.map((shape) => ({ ...shape, disabled: true })) : SHAPES} onChange={setComposerShape} appearance="plain" />
      </div>
      <p role={notice?.error ? "alert" : "status"} className={cn("text-ui empty:hidden", notice?.error ? "text-destructive-ink" : "text-muted-foreground")}>{notice?.text}</p>
      <section aria-label="Saved designs" className="space-y-3">
        <h3 className="text-body font-medium">Saved on this device</h3>
        {saved.length > 0 && (
          <ul className="divide-y divide-border rounded-card border border-border px-2.5">
            {saved.map((preset) => (
              <li key={preset.name} className="flex items-center gap-1.5 py-1.5">
                <span className="size-4 shrink-0 rounded-full border border-border" style={{ backgroundColor: designColor(preset) }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ui font-medium">{preset.name}</span>
                <Button type="button" variant="ghost" size="sm" aria-label={`Share ${preset.name}`} onClick={() => void share(preset)}>Share</Button>
                <Button type="button" variant="secondary" size="sm" aria-label={`Apply ${preset.name}`} aria-pressed={matches(preset)} disabled={busy} onClick={() => void apply(preset)}>Apply</Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={`Remove ${preset.name} design`} onClick={() => remove(preset)}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const { chatFont, transcriptWidth, composerShape } = readUiPrefs();
            if (add(validateDesignPreset({ version: 1, name, theme: settings.theme, accent: settings.accent, chatFont, transcriptWidth, composerShape }))) {
              setName("");
            }
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`${id}-name`}>Save your current look</Label>
            <Input id={`${id}-name`} maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="Design name" />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>Save design</Button>
        </form>
      </section>
      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor={`${id}-code`}>Design code</Label>
        <Textarea id={`${id}-code`} rows={2} maxLength={2048} value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste a shared design code" />
        <Button type="button" variant="secondary" size="sm" disabled={busy || !code.trim()} onClick={() => { if (add(parseDesignPreset(code))) setCode(""); }}>Import design</Button>
      </div>
    </section>
  );
}
