"use client";

import * as React from "react";
import { Loader2, ShieldCheck } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HoldButton } from "@/components/ui/hold-button";

interface PrivacyStripProps {
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onExport: () => void;
  onReset: () => void;
  resetting: boolean;
  /** No facts and no summary — export/reset have nothing to act on. */
  empty: boolean;
}

/**
 * RESET IS A HOLD, NOT A SECOND CLICK.
 *
 * It used to be Reset → "Confirm reset": one button replacing another in
 * place, with a 4-second self-cancel and an effect moving focus between the
 * two so keyboard users were not dropped when the element under them was
 * unmounted. That is three pieces of machinery — a state, a timer and a focus
 * hand-off — to buy one moment of "are you sure", and the swap has a failure
 * mode nothing can fix: the second button appears exactly where the first one
 * was, under a finger that is already moving, so a double-click destroys
 * everything. A hold cannot be double-clicked.
 *
 * It stays a hold rather than becoming a dialog because the sentence under
 * this strip already says what reset does, permanently and in those words. A
 * modal would repeat it at the cost of an interrupt.
 */
export function PrivacyStrip({ paused, onPausedChange, onExport, onReset, resetting, empty }: PrivacyStripProps) {
  return (
    // /40, not /20: --muted at a fifth over the true-black ground composites to
    // under 2% lightness, so the strip that fences the destructive controls had
    // no fill and only its hairline told you where it began.
    <div className="rounded-card border border-border/50 bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <label htmlFor="pause-memory" className="flex cursor-pointer items-center gap-2.5 text-ui">
          <Switch
            id="pause-memory"
            checked={paused}
            onCheckedChange={onPausedChange}
            aria-describedby="memory-privacy-note"
          />
          {paused ? "Memory paused" : "Pause memory"}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onExport} disabled={empty}>
            <ActionIcons.download className="size-3.5" /> Export
          </Button>
          <HoldButton
            onHold={onReset}
            disabled={empty || resetting}
            label="Reset memory — hold to confirm"
            hint="Hold to reset"
            holdingLabel="Keep holding…"
            className="h-8 w-auto gap-1.5 px-2.5"
          >
            <span className="inline-flex items-center gap-1.5">
              {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <ActionIcons.restore className="size-3.5" />}
              {resetting ? "Resetting…" : "Hold to reset"}
            </span>
          </HoldButton>
        </div>
      </div>
      <p id="memory-privacy-note" className="mt-2.5 flex items-start gap-1.5 text-caption text-muted-foreground/80">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Pausing stops Juno from saving or using memories. Private chats are never remembered. Resetting permanently
          erases every saved fact and the summary.
        </span>
      </p>
    </div>
  );
}
