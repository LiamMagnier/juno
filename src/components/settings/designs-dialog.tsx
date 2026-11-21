"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { ACCENTS } from "@/lib/accents";
import { BUILT_IN_DESIGNS, parseDesignPreset, validateDesignPreset, type DesignPreset } from "@/lib/design-presets";
import { readUiPrefs, useUiPref, writeUiPrefs, type ComposerShape } from "@/lib/ui-prefs";
import { useApp } from "@/components/app/app-provider";
import { Trash2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
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

function Swatch({ preset }: { preset: DesignPreset }) {
  const color = ACCENTS.find(({ id }) => id === preset.accent)?.color ?? preset.accent;
  return <span className="size-5 shrink-0 rounded-full border border-border" style={{ backgroundColor: color }} aria-hidden="true" />;
}

export function DesignsDialog() {
  const { settings, user } = useApp();
  const { setTheme } = useTheme();
  const save = useSettingsSave();
  const [composerShape, setComposerShape] = useUiPref("composerShape");
  const [open, setOpen] = React.useState(false);
  const [saved, setSaved] = React.useState<DesignPreset[]>([]);
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const key = `alevr:designs:v1:${user.id}`;
  const id = React.useId();

  function changeOpen(next: boolean) {
    if (!next && busy) return;
    if (next) {
      setSaved(readSavedDesigns(key));
      setName("");
      setCode("");
      setNotice(null);
    }
    setOpen(next);
  }

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

  const rows = (designs: readonly DesignPreset[], canShare: boolean) => (
    <ul className="divide-y divide-border/70">
      {designs.map((preset) => (
        <li key={preset.name} className="flex items-center gap-2.5 py-1.5">
          <Swatch preset={preset} />
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{preset.name}</span>
          {canShare && <Button type="button" variant="ghost" size="sm" aria-label={`Share ${preset.name}`} onClick={() => void share(preset)}>Share</Button>}
          <Button type="button" variant="secondary" size="sm" aria-label={`Apply ${preset.name}`} disabled={busy} onClick={() => void apply(preset)}>Apply</Button>
          {canShare && (
            <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={`Remove ${preset.name} design`} onClick={() => remove(preset)}>
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild><Button type="button" variant="secondary" size="sm">Browse designs</Button></DialogTrigger>
      <DialogContent className="bg-background text-foreground !shadow-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Designs</DialogTitle>
          <DialogDescription>Choose a preset, save your own look, or share a design code.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section aria-label="Preset designs">{rows(BUILT_IN_DESIGNS, false)}</section>
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-ui font-medium">Composer corners</p>
            <SegmentedControl ariaLabel="Composer corners" value={composerShape} options={busy ? SHAPES.map((shape) => ({ ...shape, disabled: true })) : SHAPES} onChange={setComposerShape} appearance="plain" />
          </div>
          <section aria-label="Saved designs" className="space-y-2 border-t border-border pt-4">
            {saved.length > 0 && rows(saved, true)}
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
          {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "text-ui text-destructive-ink" : "text-ui text-muted-foreground"}>{notice.text}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
