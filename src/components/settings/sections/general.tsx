"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Plus } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/components/app/app-provider";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { useSaveStates } from "@/components/settings/save-status";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { FONT_SIZES, readFontSize, writeFontSize, type FontSizeId } from "@/components/settings/font-size";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { AUTO_LOCALE, UI_LOCALES, localeNativeName } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";
import { useUiPref, type ChatFont, type MotionPref, type TranscriptWidth } from "@/lib/ui-prefs";
import { openSettings } from "@/components/settings/settings-sections";
import { ChevronRight } from "@/components/ui/icons";

/** The accents' names, for their swatches' accessible names (they used to announce the raw id). */
const ACCENT_NAMES: { id: (typeof ACCENTS)[number]["id"]; label: string }[] = [
  { id: "coral", label: "Graphite" },
  { id: "ultramarine", label: "Ultramarine" },
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

export function AppearanceSection() {
  const { settings, setSettings } = useApp();
  const { setTheme } = useTheme();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const [fontSize, setFontSize] = React.useState<FontSizeId>("default");
  React.useEffect(() => setFontSize(readFontSize()), []);
  const fontStep = Math.max(0, FONT_SIZES.findIndex((s) => s.id === fontSize));
  const fontPx = FONT_SIZES[fontStep]?.px ?? 16;

  // The painted theme and accent are put back through `onRollback`, not on
  // every failure: with two changes in flight, the first one's failure must
  // not repaint the page in a value the second has already replaced, and
  // when both fail the page goes back to what the server holds rather than
  // to the first change.
  const setThemePref = (theme: ClientSettings["theme"]) => {
    if (theme === settings.theme) return;
    setTheme(theme);
    void saves.track("theme", () =>
      save(
        { theme },
        {
          onRollback: (restored) => {
            if (restored.theme) setTheme(restored.theme);
          },
        }
      )
    );
  };

  // The accent the account held before a custom-colour preview started, so a
  // refused save goes back to it rather than to the last previewed colour.
  const accentBeforePreview = React.useRef<string | null>(null);
  const setAccent = (accent: string) => {
    const previous = accentBeforePreview.current ?? settings.accent;
    accentBeforePreview.current = null;
    if (accent === previous) return;
    document.documentElement.dataset.accent = accent;
    void saves.track("accent", () =>
      save(
        { accent },
        {
          previous: { accent: previous },
          onRollback: (restored) => {
            if (restored.accent) document.documentElement.dataset.accent = restored.accent;
          },
        }
      )
    );
  };
  const previewAccent = (accent: string) => {
    if (accentBeforePreview.current === null) accentBeforePreview.current = settings.accent;
    document.documentElement.dataset.accent = accent;
    setSettings({ accent });
  };

  // A full reload, not router.refresh(): the locale decides `<html lang>`/`dir`
  // server-side, and the already-translated DOM has to come back from the
  // source catalog rather than be translated a second time in place.

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
      <SettingsGroup title="Visual style" description="Mode and accent follow your account everywhere you sign in.">
        <SettingBlock label="Mode" status={saves.status("theme")}>
          <ThemeCards value={settings.theme} onChange={setThemePref} />
        </SettingBlock>
        <SettingRow
          label="Accent color"
          description="Buttons, switches and selection. Graphite is the Alevr default."
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

      <ReadingGroup />
    </>
  );
}


/* ——— Mode cards ——————————————————————————————————————————————————————— */

const MODE_CARDS: { value: ClientSettings["theme"]; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A thumbnail of the app in one mode: a sidebar, two lines of reply and a composer. */
function ModeThumb({ tone }: { tone: "light" | "dark" }) {
  const dark = tone === "dark";
  return (
    <span className={cn("flex h-full w-full", dark ? "bg-[#1b1b1d]" : "bg-[#fcfcfc]")}>
      <span className={cn("flex w-[30%] flex-col gap-1 p-1.5", dark ? "bg-[#232326]" : "bg-[#f1f1f2]")}>
        <span className={cn("h-1 w-3/4 rounded-full", dark ? "bg-white/25" : "bg-black/20")} />
        <span className={cn("h-1 w-1/2 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
        <span className={cn("h-1 w-2/3 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
      </span>
      <span className="flex flex-1 flex-col justify-between p-2">
        <span className="flex flex-col gap-1">
          <span className={cn("h-1 w-4/5 rounded-full", dark ? "bg-white/30" : "bg-black/25")} />
          <span className={cn("h-1 w-3/5 rounded-full", dark ? "bg-white/20" : "bg-black/15")} />
        </span>
        <span className={cn("flex h-2.5 items-center justify-end rounded-sm border px-0.5", dark ? "border-white/15 bg-white/5" : "border-black/10 bg-white")}>
          <span className="size-1.5 rounded-full bg-primary" />
        </span>
      </span>
    </span>
  );
}

/**
 * A visual choice: a thumbnail per option with its name under it, one radio
 * group with the roving tab stop. Mode, chat font and transcript width are all
 * drawn with it, so the three read as one control family. The selection is
 * graphite (the foreground ink), not the accent: picking an accent should not
 * recolour the cards that sit beside it.
 */
function ChoiceCards<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; thumb: React.ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const option = useRadioGroup(options, options.findIndex((o) => o.value === value), (o) => onChange(o.value));
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-3", className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            {...option(i)}
            className="group flex min-w-0 flex-col gap-2 text-left outline-none"
          >
            <span
              className={cn(
                "relative block aspect-[16/10] overflow-hidden rounded-field border transition-[box-shadow,border-color,transform] duration-base ease-out-soft group-active:scale-[0.98] motion-reduce:transition-none",
                selected
                  ? "border-foreground shadow-[0_0_0_1px_hsl(var(--foreground))]"
                  : "border-border group-hover:-translate-y-px group-hover:border-foreground/30 motion-reduce:group-hover:translate-y-0",
                "group-focus-visible:shadow-[0_0_0_2px_hsl(var(--ring))]"
              )}
            >
              {o.thumb}
            </span>
            <span
              className={cn(
                "truncate text-ui transition-colors duration-fast",
                selected ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground"
              )}
            >
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ThemeCards({ value, onChange }: { value: ClientSettings["theme"]; onChange: (v: ClientSettings["theme"]) => void }) {
  return (
    <ChoiceCards
      label="Mode"
      value={value}
      onChange={onChange}
      className="max-w-md grid-cols-3"
      options={MODE_CARDS.map((mode) => ({
        value: mode.value,
        label: mode.label,
        thumb:
          mode.value === "system" ? (
            <span className="absolute inset-0 flex">
              <span className="relative w-1/2 overflow-hidden"><span className="absolute inset-0 w-[200%]"><ModeThumb tone="light" /></span></span>
              <span className="relative w-1/2 overflow-hidden"><span className="absolute inset-0 -left-full w-[200%]"><ModeThumb tone="dark" /></span></span>
            </span>
          ) : (
            <ModeThumb tone={mode.value} />
          ),
      }))}
    />
  );
}

/* ——— Reading: chat font, width, motion (this device) ——————————————————— */

const FONT_OPTIONS: { value: ChatFont; label: string; className?: string; style?: React.CSSProperties }[] = [
  { value: "default", label: "Default", className: "font-sans" },
  { value: "system", label: "System", style: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' } },
  { value: "serif", label: "Serif", className: "font-serif" },
  { value: "mono", label: "Mono", className: "font-mono" },
];
const WIDTH_OPTIONS: { value: TranscriptWidth; label: string; measure: string }[] = [
  { value: "narrow", label: "Narrow", measure: "w-[42%]" },
  { value: "medium", label: "Medium", measure: "w-[60%]" },
  { value: "wide", label: "Wide", measure: "w-[82%]" },
];
const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "reduced", label: "Reduced" },
];

/** A specimen of a chat face: the letters, then two lines of a reply. */
function FontThumb({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span className="flex h-full w-full flex-col justify-center gap-1.5 bg-muted/40 px-3">
      <span className={cn("text-title leading-none text-foreground", className)} style={style}>
        Aa
      </span>
      <span className="flex flex-col gap-1">
        <span className="h-1 w-4/5 rounded-full bg-foreground/15" />
        <span className="h-1 w-3/5 rounded-full bg-foreground/10" />
      </span>
    </span>
  );
}

/** The transcript at a width: the reply's measure and the composer under it. */
function WidthThumb({ measure }: { measure: string }) {
  return (
    <span className="flex h-full w-full flex-col items-center justify-between bg-muted/40 py-2.5">
      <span className={cn("flex flex-col gap-1 transition-[width] duration-base ease-out-soft", measure)}>
        <span className="h-1 w-full rounded-full bg-foreground/20" />
        <span className="h-1 w-11/12 rounded-full bg-foreground/15" />
        <span className="h-1 w-2/3 rounded-full bg-foreground/10" />
      </span>
      <span className={cn("h-2.5 rounded-sm border border-foreground/15 bg-background", measure)} />
    </span>
  );
}

function ReadingGroup() {
  const [chatFont, setChatFont] = useUiPref("chatFont");
  const [width, setWidth] = useUiPref("transcriptWidth");
  const [motion, setMotion] = useUiPref("motion");
  return (
    <SettingsGroup title="Reading" description="Set for this device only.">
      <SettingBlock label="Chat font" description="The typeface replies and your messages are set in.">
        <ChoiceCards
          label="Chat font"
          value={chatFont}
          onChange={setChatFont}
          className="grid-cols-2 @[30rem]/pane:grid-cols-4"
          options={FONT_OPTIONS.map((f) => ({ value: f.value, label: f.label, thumb: <FontThumb className={f.className} style={f.style} /> }))}
        />
      </SettingBlock>
      <SettingBlock label="Transcript width" description="How wide the conversation and the composer can grow.">
        <ChoiceCards
          label="Transcript width"
          value={width}
          onChange={setWidth}
          className="max-w-md grid-cols-3"
          options={WIDTH_OPTIONS.map((w) => ({ value: w.value, label: w.label, thumb: <WidthThumb measure={w.measure} /> }))}
        />
      </SettingBlock>
      <SettingRow
        label="Motion"
        description="Reduce animation in streaming replies and across the interface."
        wide
        control={
          <SegmentedControl ariaLabel="Motion" value={motion} onChange={setMotion} options={MOTION_OPTIONS} className="w-full @[34rem]/pane:w-auto" />
        }
      />
    </SettingsGroup>
  );
}

/* ——— General ——————————————————————————————————————————————————————————— */


export function GeneralSection() {
  const { settings } = useApp();
  const save = useSettingsSave();
  const setUiLocale = async (uiLocale: string) => {
    if (await save({ uiLocale })) window.location.reload();
  };
  return (
    <>
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
      <SettingsGroup title="More">
        {[
          { id: "appearance", label: "Appearance", description: "Mode, accent, chat font, width and motion." },
          { id: "notifications", label: "Notifications", description: "When a reply finishes, and what reaches your inbox." },
          { id: "keyboard", label: "Keyboard", description: "Send with Enter or ⌘ Enter, and every shortcut." },
        ].map((link) => (
          <button
            key={link.id}
            type="button"
            onClick={() => openSettings(link.id)}
            className="group flex w-full items-center gap-4 py-4 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-foreground">{link.label}</span>
              <span className="mt-0.5 block text-ui text-muted-foreground">{link.description}</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground" />
          </button>
        ))}
      </SettingsGroup>
    </>
  );
}
