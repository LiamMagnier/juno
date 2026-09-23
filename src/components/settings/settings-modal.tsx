"use client";

import * as React from "react";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsRail, settingsTabId } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import type { SettingsSectionId } from "@/components/settings/settings-sections";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { cn } from "@/lib/utils";

/** How the modal was opened, which decides whether it animates in. */
export type SettingsOpenedVia = "pointer" | "keyboard";

/**
 * The close glyph with its name in a tooltip, per the icon-button rule. Two
 * of these render (one in the phone bar, one in the pane's corner) and only
 * one is ever displayed, so only one is ever in the tab order.
 */
function CloseButton({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DialogCloseButton className={className} />
      </TooltipTrigger>
      <TooltipContent>Close</TooltipContent>
    </Tooltip>
  );
}

/**
 * Settings, the modal. State lives in `SettingsModalLazy`, which the app
 * layout mounts and which owns the `juno:settings` event and ⌘, so neither is
 * lost while this chunk loads. This file owns the frame: the rail, the pane
 * and how the two sit on each size of window.
 *
 * WIDE (md and up): a centred panel, rail column on the left behind a hairline,
 * the section on the right in a scroller of its own. It enters at 0.97 scale
 * and full transparency, reaching rest on the base rung with the plain
 * decelerate: no overshoot and no rise, because a panel this size springing
 * reads as a toy. It leaves on the fast rung, faster than it came, because
 * the reader has already decided.
 *
 * NARROW (below md): a full-height sheet. A centred card with a 1rem margin
 * left a 88dvh box on a phone whose close button sat on top of the section
 * strip. Here the top bar holds the title and the close button, the strip
 * sits under it, and the pane has the rest. It rises 24px as it fades in.
 *
 * KEYBOARD. Opened with ⌘, it appears without an entrance: an action taken
 * from the keyboard is expected to land at once, and animating it reads as
 * lag. Focus lands on the open section's tab, so arrows move between
 * sections straight away, rather than on the close button.
 *
 * The frame keys on the window (`md:`), the one case PREMIUM_AUDIT rule 11
 * allows, because a dialog is a full-bleed surface whose size is the
 * window's. `@container/rail` and `@container/pane` are for what renders
 * inside it: the rail and the sections read their own boxes, because they
 * also render on /settings under a different parent.
 */
export function SettingsModal({
  open,
  onOpenChange,
  section,
  onSectionChange,
  via,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  via: SettingsOpenedVia;
}) {
  // "⌘," on Apple keyboards, "Ctrl+," elsewhere.
  const modifier = useModifierKeyLabel();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const tab = document.getElementById(settingsTabId(section));
          if (!tab) return;
          event.preventDefault();
          tab.focus();
        }}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:p-0",
          "md:h-[min(86dvh,46rem)] md:w-[calc(100%-3rem)] md:max-w-[58rem] md:flex-row",
          "max-md:left-0 max-md:top-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:rounded-none max-md:border-0 max-md:[translate:none]",
          // The entrance and exit, on the dialog's own pop keyframes with the
          // travel and the start scale set for this surface. The scale is
          // restated at 1 under reduced motion because a variable set on the
          // element outranks the root's reduced-motion value.
          "[--pop-shift:0px] [--motion-scale-from:0.97] max-md:[--motion-scale-from:1] max-md:[--pop-shift:24px] motion-reduce:[--motion-scale-from:1]",
          "data-[state=open]:animate-[pop-in_var(--dur-base)_var(--ease-out-soft)_both] data-[state=closed]:animate-[pop-out_var(--dur-fast)_var(--ease-in)_both]",
          via === "keyboard" && "data-[state=open]:animate-none"
        )}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div className="flex shrink-0 items-center justify-between px-5 pb-1 pt-3 md:hidden" aria-hidden="true">
          <span className="text-heading">Settings</span>
        </div>
        <CloseButton className="right-3 top-2 md:hidden" />

        <aside className="@container/rail shrink-0 border-b border-border/60 px-3 pb-2.5 md:flex md:w-60 md:flex-col md:border-b-0 md:border-r md:px-3 md:pb-3 md:pt-5">
          <div className="mb-3 hidden items-center justify-between px-2.5 md:flex" aria-hidden="true">
            <span className="text-heading">Settings</span>
            <Kbd>{modifier === "⌘" ? "⌘," : `${modifier}+,`}</Kbd>
          </div>
          <SettingsRail active={section} onSelect={onSectionChange} />
        </aside>

        {/* The close button sits beside the scroller, not in it, so it stays
            in the corner while a long section scrolls under it. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <CloseButton className="right-3 top-3 z-10 hidden md:flex" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="@container/pane mx-auto w-full max-w-2xl px-5 pb-14 pt-6 sm:px-8 md:pt-9">
              <SettingsPane section={section} tabpanel />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
