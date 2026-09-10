"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { DotField } from "@/components/signature/dot-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Pressable } from "@/components/ui/pressable";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { useApp } from "@/components/app/app-provider";
import { ACCENTS, swatchInk } from "@/lib/accents";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

const KEY = "juno:onboarded:v1";

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

/**
 * First-run welcome: one optional card, three choices.
 *
 * This was four modal steps before the first message — a capability tour, a
 * theme/accent/default-model picker, a plan chooser priced in dollars and a
 * memory-import form — where Claude asks for a name and ChatGPT asks for
 * nothing. What survived is what a new account genuinely cannot get right on
 * its own: how Juno addresses you, and which theme and accent it wears. All
 * of it can be skipped, and all of it is in Settings → General afterwards.
 *
 * Where the other steps went, so nobody reinstates them here:
 *   - The default model: the picker's default is fine, and a new user cannot
 *     choose between a hundred models they have not tried. Settings → Models.
 *   - The plan chooser: it now appears at the first quota hit, which is the
 *     moment a plan means something — the composer's quota banner links to
 *     /upgrade (composer.tsx, `quotaReached`).
 *   - Memory import: Settings → Data & privacy, next to conversation import,
 *     where it already lived for people who found it.
 *
 * Gating stays in localStorage: the user object the shell exposes (AppUser)
 * carries no `onboardedAt`, and adding one is a schema change this component
 * is not the place for. If it ever appears on the user, read it here first
 * and fall back to the key.
 */
export function Onboarding() {
  const router = useRouter();
  const { user, settings, setSettings, conversations } = useApp();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [show, setShow] = React.useState(false);
  const [name, setName] = React.useState(user.name ?? "");
  const [saving, setSaving] = React.useState(false);
  const primaryRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    try {
      // Already finished first-run — never reappear, even if the last chat is deleted.
      if (localStorage.getItem(KEY)) return;

      // Any existing history means they're past first-run. Persist so wiping the
      // conversation list later doesn't resurrect the welcome card.
      if (conversations.length > 0) {
        localStorage.setItem(KEY, "1");
        return;
      }

      setShow(true);
    } catch {
      /* private mode / no storage — just skip onboarding */
    }
  }, [conversations.length]);

  // Let other first-run overlays (the announcement popup) stand down while
  // this card owns the screen, so nothing steals the primary button's clicks.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (show) {
      window.__junoOnboardingActive = true;
      window.dispatchEvent(new CustomEvent("juno:onboarding-start"));
    }
  }, [show]);

  const close = React.useCallback(() => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
    if (typeof window !== "undefined") {
      window.__junoOnboardingActive = false;
      window.dispatchEvent(new CustomEvent("juno:onboarding-end"));
    }
  }, []);

  const save = (patch: Partial<ClientSettings>) => {
    setSettings(patch);
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  };
  const pickAccent = (id: string) => {
    document.documentElement.dataset.accent = id;
    save({ accent: id });
  };

  // The name is the one field with a submit: theme and accent apply as they
  // are pressed, but a half-typed name should not be PATCHed on every key.
  const finish = async () => {
    const value = name.trim();
    if (value && value !== (user.name ?? "")) {
      setSaving(true);
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      }).catch(() => {});
      setSaving(false);
      router.refresh();
    }
    close();
  };

  /**
   * The swatches, in the colours the app will actually use.
   *
   * ACCENTS stores only the LIGHT `:root[data-accent]` value, and the dark ramp
   * is materially different — juniper 31%→54%, teal 31.5%→49%, sage 42.5%→61%.
   * On the dark theme the row was therefore advertising six muddy 31–46% discs
   * that no surface in the product ever renders, on the very card where the
   * user is also choosing Dark one row up.
   *
   * Rather than duplicating the ramp into a second constant that can drift from
   * globals.css the way the first one already did, the real `--primary` is read
   * off the document: the attribute is swapped and restored inside ONE
   * synchronous layout effect, so no frame is ever painted with the wrong accent
   * applied. Re-runs on theme change because that is what the values depend on.
   */
  const [swatches, setSwatches] = React.useState<Record<string, string>>({});
  React.useLayoutEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    const previous = root.dataset.accent;
    const next: Record<string, string> = {};
    for (const a of ACCENTS) {
      root.dataset.accent = a.id;
      const value = getComputedStyle(root).getPropertyValue("--primary").trim();
      if (value) next[a.id] = `hsl(${value})`;
    }
    if (previous === undefined) delete root.dataset.accent;
    else root.dataset.accent = previous;
    setSwatches(next);
  }, [show, resolvedTheme]);

  const activeTheme = theme ?? "system";
  // The keyboard half of each radiogroup: one tab stop, arrows and Home/End
  // between the options — the same hook the Settings page's pickers use.
  const themeOption = useRadioGroup(
    THEMES,
    THEMES.findIndex((t) => t.id === activeTheme),
    (t) => setTheme(t.id)
  );
  const accentOption = useRadioGroup(
    ACCENTS,
    ACCENTS.findIndex((a) => a.id === settings.accent),
    (a) => pickAccent(a.id)
  );

  // No early `return null` on !show: the Dialog has to stay mounted through the
  // close so the exit animation can run. Radix renders nothing while it is shut.
  return (
    // On the shared primitive the card dims, traps focus, locks scroll,
    // restores focus and animates out like every other modal — and `close()`
    // still runs on Escape and on a backdrop click, both via onOpenChange.
    <Dialog open={show} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent
        hideClose
        className="w-full max-w-[420px] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          primaryRef.current?.focus();
        }}
      >
        {/* The dot motif stays — it is the product signature; it sits inside
            the panel now that there is no bespoke full-screen layer to paint on. */}
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <DotField spacing={26} />
        </div>

        <div className="relative px-7 pb-7 pt-7">
          <DialogTitle className="font-sans text-title font-medium leading-tight">Welcome to Juno</DialogTitle>
          {/* Full --muted-foreground, no /80: at this size the composite fell
              under 4.5:1 on the popover ground. */}
          <DialogDescription className="mt-1.5 text-body text-muted-foreground">
            Three quick choices, all optional. Everything here is in Settings later.
          </DialogDescription>

          {/* Rows deal out on the shared `loose` rung — the tempo the motion
              scale reserves for a few large, consequential items — rather than
              the private `80 + i×60` the old tour used. */}
          <div className="mt-6 space-y-6">
            <div style={staggerDelay(0, "loose")} className="motion-safe:animate-fade-in-up [animation-fill-mode:backwards]">
              <Field
                id="onboarding-name"
                label="What should Juno call you?"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your first name"
                autoComplete="given-name"
                maxLength={80}
              />
            </div>

            <div style={staggerDelay(1, "loose")} className="motion-safe:animate-fade-in-up [animation-fill-mode:backwards]">
              <p className="mb-2 font-mono text-label text-muted-foreground">Theme</p>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                {THEMES.map((t, i) => {
                  const selected = activeTheme === t.id;
                  return (
                    <Pressable
                      key={t.id}
                      kind="tile"
                      role="radio"
                      selected={selected}
                      aria-checked={selected}
                      onClick={() => setTheme(t.id)}
                      className="items-center gap-1.5"
                      {...themeOption(i)}
                    >
                      <t.icon className="size-4" />
                      {t.label}
                    </Pressable>
                  );
                })}
              </div>
            </div>

            <div style={staggerDelay(2, "loose")} className="motion-safe:animate-fade-in-up [animation-fill-mode:backwards]">
              <p className="mb-2 font-mono text-label text-muted-foreground">Accent</p>
              {/* role="radio" in a radiogroup, as the Settings page draws the
                  same control — not six independent aria-pressed toggles. No
                  hover scale: the selection ring is the state, and a swatch
                  that grows under the pointer is the one gesture in the product
                  nothing else makes. */}
              <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Accent color">
                {ACCENTS.map((a, i) => {
                  const color = swatches[a.id] ?? a.color;
                  const selected = settings.accent === a.id;
                  return (
                    <Pressable
                      key={a.id}
                      kind="icon"
                      size="lg"
                      role="radio"
                      aria-checked={selected}
                      aria-label={a.id}
                      onClick={() => pickAccent(a.id)}
                      // ring-offset-popover: the gap a ring-offset leaves is
                      // filled with a SOLID named colour, and these swatches sit
                      // on a DialogContent (--popover), not on a card.
                      className={cn(
                        "overflow-hidden ring-offset-2 ring-offset-popover hover:bg-transparent",
                        selected && "ring-2 ring-foreground"
                      )}
                      style={{ background: color, color: swatchInk(color) }}
                      {...accentOption(i)}
                    >
                      {/* Computed ink, not `text-white`: on the amber preset a
                          white tick measures 2.3:1 against its own swatch. */}
                      {selected && <StatusIcons.success className="size-4" />}
                    </Pressable>
                  );
                })}
              </div>
            </div>
          </div>

          <div
            style={staggerDelay(3, "loose")}
            className="mt-7 flex flex-col gap-2 motion-safe:animate-fade-in-up [animation-fill-mode:backwards]"
          >
            <Button ref={primaryRef} onClick={() => void finish()} size="lg" className="w-full" disabled={saving} aria-busy={saving}>
              Start chatting
            </Button>
            {/* A real button at the sm height (32px), not an 11px text link:
                the skip target was under SC 2.5.8's 24px. */}
            <Button variant="ghost" size="sm" onClick={close} className="w-full text-muted-foreground">
              Skip for now
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
