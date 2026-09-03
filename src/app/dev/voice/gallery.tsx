"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { VoiceAura, type VoiceAuraStatus } from "@/components/voice/voice-aura";
import { Button } from "@/components/ui/button";

const STATUSES: VoiceAuraStatus[] = ["idle", "listening", "speaking", "thinking", "error"];

/**
 * A stand-in for the chat column: same stacking contract as
 * `.composer-aura-host` in ChatView, so the aura is positioned and layered here
 * exactly as it is in the product. If it looks right in this box it looks right
 * in a conversation.
 */
function Column({
  status,
  levelRef,
  label,
}: {
  status: VoiceAuraStatus;
  levelRef: React.MutableRefObject<number>;
  label: string;
}) {
  return (
    <div className="flex h-[26rem] flex-col justify-end overflow-hidden rounded-panel border border-border/60 bg-background">
      <p className="px-4 pt-3 font-mono text-label text-muted-foreground/70">{label}</p>
      <div className="flex-1" />
      <div className="composer-aura-host relative isolate w-full px-4 pb-4">
        <VoiceAura status={status} levelRef={levelRef} />
        {/* Stands in for the composer: the aura must read as being behind this. */}
        <div className="composer-surface flex h-[68px] w-full items-center rounded-composer border border-border/65 bg-card/95 px-4 text-sm text-muted-foreground/70 backdrop-blur">
          Ask anything
        </div>
      </div>
    </div>
  );
}

export function VoiceGallery() {
  const { resolvedTheme, setTheme } = useTheme();
  const [level, setLevel] = React.useState(0.55);
  const [live, setLive] = React.useState(true);
  const levelRef = React.useRef(level);

  // Live mode fakes speech: a jittery envelope rather than a clean sine, so the
  // asymmetric attack/release in the aura is actually exercised.
  React.useEffect(() => {
    if (!live) {
      levelRef.current = level;
      return;
    }
    let frame = 0;
    const tick = (t: number) => {
      const syllable = Math.max(0, Math.sin(t / 190)) ** 2;
      const jitter = 0.5 + 0.5 * Math.sin(t / 47);
      levelRef.current = Math.min(1, syllable * (0.55 + 0.45 * jitter));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, level]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="font-sans text-[2.4rem] leading-tight">Voice aura</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Waves along the bottom and up both sides of the chat column, behind the composer. Your turn
        is the accent; Juno&rsquo;s turn is a companion hue derived from it, so both follow the
        accent picker.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? "Light" : "Dark"}
        </Button>
        <Button variant={live ? "default" : "outline"} size="sm" onClick={() => setLive((v) => !v)}>
          {live ? "Speaking" : "Held"}
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Level
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={level}
            disabled={live}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="w-40 accent-primary disabled:opacity-40"
          />
        </label>
        <span className="flex flex-wrap gap-2">
          {(["coral", "teal", "violet", "amber"] as const).map((accent) => (
            <Button
              key={accent}
              variant="outline"
              size="sm"
              onClick={() => document.documentElement.setAttribute("data-accent", accent)}
            >
              {accent}
            </Button>
          ))}
        </span>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {STATUSES.map((status) => (
          <Column key={status} status={status} levelRef={levelRef} label={status} />
        ))}
      </div>
    </div>
  );
}
