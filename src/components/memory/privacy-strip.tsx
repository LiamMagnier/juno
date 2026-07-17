"use client";

import * as React from "react";
import { Download, Loader2, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface PrivacyStripProps {
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onExport: () => void;
  onReset: () => void;
  resetting: boolean;
  /** No facts and no summary — export/reset have nothing to act on. */
  empty: boolean;
}

export function PrivacyStrip({ paused, onPausedChange, onExport, onReset, resetting, empty }: PrivacyStripProps) {
  const [confirming, setConfirming] = React.useState(false);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const resetRef = React.useRef<HTMLButtonElement>(null);

  // The Reset ⇄ Confirm swap replaces the focused element — hand focus to the
  // button that took its place so keyboard users aren't dropped.
  React.useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
      const t = setTimeout(() => setConfirming(false), 4000);
      return () => clearTimeout(t);
    }
    if (document.activeElement === document.body) resetRef.current?.focus();
  }, [confirming]);

  return (
    <div className="rounded-2xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <label htmlFor="pause-memory" className="flex cursor-pointer items-center gap-2.5 text-sm">
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
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          {confirming ? (
            <Button
              ref={confirmRef}
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setConfirming(false);
                onReset();
              }}
              disabled={resetting}
            >
              {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Confirm reset
            </Button>
          ) : (
            <Button
              ref={resetRef}
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive danger-hover"
              onClick={() => setConfirming(true)}
              disabled={empty || resetting}
            >
              {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {resetting ? "Resetting…" : "Reset"}
            </Button>
          )}
        </div>
      </div>
      <p id="memory-privacy-note" className="mt-2.5 flex items-start gap-1.5 text-caption text-muted-foreground/80">
        <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Pausing stops Juno from saving or using memories. Private chats are never remembered. Resetting permanently
          erases every saved fact and the summary.
        </span>
      </p>
    </div>
  );
}
