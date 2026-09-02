"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Plus, Sun } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/components/app/app-provider";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { FONT_SIZES, readFontSize, writeFontSize, type FontSizeId } from "@/components/settings/font-size";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { AUTO_LOCALE, UI_LOCALES, localeNativeName } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

/** The custom-colour swatch is the last option of the accent radiogroup, not a control beside it. */
const CUSTOM_ACCENT = "__custom__";
const ACCENT_OPTIONS: string[] = [...ACCENTS.map((a) => a.id), CUSTOM_ACCENT];

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
      size="lg"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "overflow-hidden ring-offset-2 ring-offset-background hover:bg-transparent motion-safe:hover:scale-110",
        selected && "ring-2 ring-foreground"
      )}
      style={{ background, color: swatchInk(inkAgainst ?? background) }}
      {...rest}
    >
      {children}
    </Pressable>
  );
});

const CustomPickerButton = React.forwardRef<
  HTMLButtonElement,
  {
    selected: boolean;
    customColor: string;
    onChange: (color: string) => void;
  } & Pick<React.ComponentPropsWithoutRef<"button">, "tabIndex" | "onKeyDown">
>(function CustomPickerButton({ selected, customColor, onChange, ...rest }, ref) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <input
        ref={pickerRef}
        type="color"
        value={customColor}
        onChange={(e) => onChange(e.target.value)}
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
        {selected ? <StatusIcons.success className="size-4" /> : <Plus className="size-4 text-background" />}
      </AccentSwatch>
    </div>
  );
});

const THEME_OPTIONS: { value: ClientSettings["theme"]; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function GeneralSection() {
  const { settings } = useApp();
  const { setTheme } = useTheme();
  const save = useSettingsSave();

  const [fontSize, setFontSize] = React.useState<FontSizeId>("default");
  React.useEffect(() => setFontSize(readFontSize()), []);

  const setThemePref = async (theme: ClientSettings["theme"]) => {
    const previous = settings.theme;
    setTheme(theme);
    if (!(await save({ theme }))) setTheme(previous);
  };

  const setAccent = async (accent: string) => {
    const previous = settings.accent;
    document.documentElement.dataset.accent = accent;
    if (!(await save({ accent }))) document.documentElement.dataset.accent = previous;
  };

  // A full reload, not router.refresh(): the locale decides `<html lang>`/`dir`
  // server-side, and the already-translated DOM has to come back from the
  // source catalog rather than be translated a second time in place.
  const setUiLocale = async (uiLocale: string) => {
    if (await save({ uiLocale })) window.location.reload();
  };

  const accentIsPreset = ACCENTS.some((a) => a.id === settings.accent);
  const customAccent = !accentIsPreset && settings.accent.startsWith("#");

  const themeOption = useRadioGroup(
    THEME_OPTIONS,
    THEME_OPTIONS.findIndex((t) => t.value === settings.theme),
    (t) => void setThemePref(t.value)
  );
  const accentOption = useRadioGroup(
    ACCENT_OPTIONS,
    customAccent ? ACCENTS.length : ACCENTS.findIndex((a) => a.id === settings.accent),
    (id) => {
      if (id !== CUSTOM_ACCENT) void setAccent(id);
    }
  );

  return (
    <>
      <SettingsGroup title="Appearance" description="How Juno looks on this device.">
        <SettingBlock label="Theme">
          <div className="grid max-w-md grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((t, i) => {
              const selected = settings.theme === t.value;
              return (
                <Pressable
                  key={t.value}
                  kind="tile"
                  role="radio"
                  selected={selected}
                  aria-checked={selected}
                  onClick={() => void setThemePref(t.value)}
                  className="items-center gap-1.5"
                  {...themeOption(i)}
                >
                  <t.icon className="size-4" />
                  {t.label}
                </Pressable>
              );
            })}
          </div>
        </SettingBlock>

        <SettingBlock label="Accent color" description="The one saturated colour in the interface.">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a, i) => {
              const selected = settings.accent === a.id;
              return (
                <AccentSwatch
                  key={a.id}
                  selected={selected}
                  background={a.color}
                  label={a.id}
                  onClick={() => void setAccent(a.id)}
                  {...accentOption(i)}
                >
                  {selected && <StatusIcons.success className="size-4" />}
                </AccentSwatch>
              );
            })}
            <CustomPickerButton
              selected={customAccent}
              customColor={customAccent ? settings.accent : "#ea580c"}
              onChange={(color) => void setAccent(color)}
              {...accentOption(ACCENTS.length)}
            />
          </div>
        </SettingBlock>

        <SettingRow
          label="Text size"
          description="Scales the whole interface. Stored on this device."
          control={
            <SegmentedControl
              ariaLabel="Text size"
              value={fontSize}
              onChange={(next) => {
                setFontSize(next);
                writeFontSize(next);
              }}
              options={FONT_SIZES.map((s) => ({ value: s.id, label: s.label }))}
              optionClassName="px-3 text-xs"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Language" description="The language Juno's own buttons and menus are in.">
        <SettingRow
          label="Interface language"
          description="Replies follow their own setting under Personalization."
          control={
            <Select value={settings.uiLocale} onValueChange={(v) => void setUiLocale(v)}>
              <SelectTrigger aria-label="Interface language" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_LOCALE}>Auto-detect</SelectItem>
                {UI_LOCALES.map((l) => (
                  <SelectItem key={l} value={l}>
                    <span data-no-auto-translate lang={l}>
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
