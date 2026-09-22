"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Plus, Sun } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/components/app/app-provider";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { useSaveStates } from "@/components/settings/save-status";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { FONT_SIZES, readFontSize, writeFontSize, type FontSizeId } from "@/components/settings/font-size";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { AUTO_LOCALE, UI_LOCALES, localeNativeName } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

/** The accents' names, for their swatches' accessible names (they used to announce the raw id). */
const ACCENT_NAMES: { id: (typeof ACCENTS)[number]["id"]; label: string }[] = [
  { id: "coral", label: "Coral" },
  { id: "juniper", label: "Juniper" },
  { id: "teal", label: "Teal" },
  { id: "violet", label: "Violet" },
  { id: "amber", label: "Amber" },
  { id: "sage", label: "Sage" },
];

/** The custom-colour swatch is the last option of the accent radiogroup, not a control beside it. */
const CUSTOM_ACCENT = "__custom__";
const ACCENT_OPTIONS: string[] = [...ACCENTS.map((a) => a.id), CUSTOM_ACCENT];
const DEFAULT_CUSTOM_ACCENT = "#ea580c";

const AccentSwatch = React.forwardRef<
  HTMLButtonElement,
  {
    selected: boolean;
    background: string;
    inkAgainst?: string;
    label: string;
    onClick: () => void;
    children?: React.ReactNode;
  } & Pick<React.ComponentPropsWithoutRef<"button">, "tabIndex" | "onKeyDown">
>(function AccentSwatch({ selected, background, inkAgainst, label, onClick, children, ...rest }, ref) {
  return (
    <Pressable
      ref={ref}
      kind="icon"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      // The ring is an OUTLINE with an offset, not a ring-offset box-shadow:
      // an outline's offset is transparent and shows whatever is underneath,
      // where a ring's offset band is painted in a named colour and wore a
      // page-coloured halo inside the dialog. No hover scale: the ring is the
      // state.
      className={cn(
        "size-7 overflow-hidden hover:bg-transparent coarse:size-9",
        selected && "outline outline-2 outline-offset-2 outline-foreground focus-visible:outline-ring"
      )}
      style={{ background, color: swatchInk(inkAgainst ?? background) }}
      {...rest}
    >
      {children}
    </Pressable>
  );
});

/**
 * The custom colour. The native picker PREVIEWS on every `input` event (the
 * accent follows the pointer while the picker is dragged) and SAVES once, on
 * `change`, when the reader lets go. It used to PATCH the account on every
 * input event, dozens of writes a second.
 */
const CustomPickerButton = React.forwardRef<
  HTMLButtonElement,
  {
    selected: boolean;
    customColor: string;
    onPreview: (color: string) => void;
    onCommit: (color: string) => void;
  } & Pick<React.ComponentPropsWithoutRef<"button">, "tabIndex" | "onKeyDown">
>(function CustomPickerButton({ selected, customColor, onPreview, onCommit, ...rest }, ref) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  const commitRef = React.useRef(onCommit);
  React.useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);
  // React's `onChange` on an input is the native `input` event; the commit
  // needs the native `change`, which React does not expose separately.
  React.useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const commit = () => commitRef.current(el.value);
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  return (
    <div className="relative">
      <input
        ref={pickerRef}
        type="color"
        defaultValue={customColor}
        onInput={(e) => onPreview(e.currentTarget.value)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <AccentSwatch
        ref={ref}
        selected={selected}
        background={
          selected
            ? customColor
            : "conic-gradient(from 90deg, hsl(var(--primary)), hsl(var(--source)), hsl(var(--success)), hsl(var(--warning)), hsl(var(--primary)))"
        }
        inkAgainst={selected ? customColor : undefined}
        label="Custom accent color"
        onClick={() => pickerRef.current?.click()}
        {...rest}
      >
        {selected ? (
          <StatusIcons.success className="check-morph size-4" />
        ) : (
          <Plus className="size-4 text-background" />
        )}
      </AccentSwatch>
    </div>
  );
});

const THEME_OPTIONS: { value: ClientSettings["theme"]; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun className="size-4" /> },
  { value: "dark", label: "Dark", icon: <Moon className="size-4" /> },
  { value: "system", label: "System", icon: <Monitor className="size-4" /> },
];

export function GeneralSection() {
  const { settings, setSettings } = useApp();
  const { setTheme } = useTheme();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const [fontSize, setFontSize] = React.useState<FontSizeId>("default");
  React.useEffect(() => setFontSize(readFontSize()), []);
  const fontStep = Math.max(0, FONT_SIZES.findIndex((s) => s.id === fontSize));
  const fontPx = FONT_SIZES[fontStep]?.px ?? 16;

  const setThemePref = (theme: ClientSettings["theme"]) => {
    if (theme === settings.theme) return;
    const previous = settings.theme;
    setTheme(theme);
    void saves.track("theme", async () => {
      const ok = await save({ theme });
      if (!ok) setTheme(previous);
      return ok;
    });
  };

  // The accent the account held before a custom-colour preview started, so a
  // refused save goes back to it rather than to the last previewed colour.
  const accentBeforePreview = React.useRef<string | null>(null);
  const setAccent = (accent: string) => {
    const previous = accentBeforePreview.current ?? settings.accent;
    accentBeforePreview.current = null;
    if (accent === previous) return;
    document.documentElement.dataset.accent = accent;
    void saves.track("accent", async () => {
      const ok = await save({ accent }, { previous: { accent: previous } });
      if (!ok) document.documentElement.dataset.accent = previous;
      return ok;
    });
  };
  const previewAccent = (accent: string) => {
    if (accentBeforePreview.current === null) accentBeforePreview.current = settings.accent;
    document.documentElement.dataset.accent = accent;
    setSettings({ accent });
  };

  // A full reload, not router.refresh(): the locale decides `<html lang>`/`dir`
  // server-side, and the already-translated DOM has to come back from the
  // source catalog rather than be translated a second time in place.
  const setUiLocale = async (uiLocale: string) => {
    if (await save({ uiLocale })) window.location.reload();
  };

  const accentIsPreset = ACCENTS.some((a) => a.id === settings.accent);
  const customAccent = !accentIsPreset && settings.accent.startsWith("#");

  const accentOption = useRadioGroup(
    ACCENT_OPTIONS,
    customAccent ? ACCENTS.length : ACCENTS.findIndex((a) => a.id === settings.accent),
    (id) => {
      if (id !== CUSTOM_ACCENT) setAccent(id);
    }
  );

  return (
    <>
      <SettingsGroup title="Appearance" description="Theme and accent follow your account. Text size is set for this device.">
        <SettingRow
          label="Theme"
          wide
          status={saves.status("theme")}
          control={
            <SegmentedControl
              ariaLabel="Theme"
              value={settings.theme}
              onChange={setThemePref}
              options={THEME_OPTIONS}
              className="w-full @[34rem]/pane:w-auto"
            />
          }
        />

        <SettingRow
          label="Accent color"
          description="Buttons, selection and focus."
          wide
          status={saves.status("accent")}
          control={
            <div className="flex flex-wrap items-center gap-2.5 p-0.5" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((a, i) => {
                const selected = settings.accent === a.id;
                return (
                  <AccentSwatch
                    key={a.id}
                    selected={selected}
                    background={a.color}
                    label={ACCENT_NAMES.find((n) => n.id === a.id)?.label ?? a.id}
                    onClick={() => setAccent(a.id)}
                    {...accentOption(i)}
                  >
                    {selected && <StatusIcons.success className="check-morph size-4" />}
                  </AccentSwatch>
                );
              })}
              <CustomPickerButton
                selected={customAccent}
                customColor={customAccent ? settings.accent : DEFAULT_CUSTOM_ACCENT}
                onPreview={previewAccent}
                onCommit={setAccent}
                {...accentOption(ACCENTS.length)}
              />
            </div>
          }
        />

        {/* Six steps from 14 to 20px on a slider: a size is a quantity, and a
            segmented control at six options is wider than the row. The value
            beside it is the number a reader can quote. */}
        <SettingRow
          label="Text size"
          description="Scales the whole interface on this device."
          wide
          status={saves.status("fontSize")}
          control={
            <div className="flex w-full items-center gap-3 @[34rem]/pane:w-60">
              <span className="text-caption text-muted-foreground" aria-hidden="true">
                A
              </span>
              <Slider
                aria-label="Text size"
                min={0}
                max={FONT_SIZES.length - 1}
                step={1}
                value={[fontStep]}
                onValueChange={([step]) => {
                  const next = FONT_SIZES[step ?? 2]?.id ?? "default";
                  setFontSize(next);
                  writeFontSize(next);
                }}
                // Confirmed once the thumb is let go, not on every step it
                // passes while dragged.
                onValueCommit={() => void saves.track("fontSize", async () => true)}
              />
              <span className="text-body-lg text-muted-foreground" aria-hidden="true">
                A
              </span>
              <span className="w-10 shrink-0 text-right text-ui tabular-nums text-muted-foreground" aria-hidden="true">
                {fontPx}
                <span className="ml-0.5">px</span>
              </span>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Language">
        <SettingRow
          label="Interface language"
          description="Replies follow Response language in Personalization."
          wide
          control={
            <Select value={settings.uiLocale} onValueChange={(v) => void setUiLocale(v)}>
              <SelectTrigger aria-label="Interface language" className="w-full @[34rem]/pane:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_LOCALE}>Auto-detect</SelectItem>
                {UI_LOCALES.map((l) => (
                  <SelectItem key={l} value={l}>
                    <span data-no-auto-translate translate="no" lang={l}>
                      {localeNativeName(l)}
                    </span>
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
