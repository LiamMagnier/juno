"use client";

/* TEMPORARY visual harness for the composer aura — delete after review. */

import * as React from "react";
import { providerGlow } from "@/lib/provider-colors";
import type { Provider } from "@/lib/providers";
import { cn } from "@/lib/utils";

const ACCENTS = ["coral", "teal", "violet", "amber", "sage"] as const;
const LABS: Provider[] = ["anthropic", "openai", "google", "moonshot", "xai", "mistral"];

export default function AuraPreview() {
  const [accent, setAccent] = React.useState<(typeof ACCENTS)[number]>("coral");
  const [lab, setLab] = React.useState<Provider>("anthropic");
  const [sending, setSending] = React.useState(false);
  const [docked, setDocked] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  React.useEffect(() => {
    if (!sending) return;
    const t = window.setTimeout(() => setSending(false), 1150);
    return () => window.clearTimeout(t);
  }, [sending]);

  return (
    <div className="relative flex h-dvh min-h-0 flex-col overflow-y-auto overflow-x-clip bg-background">
      <div className="fixed left-4 top-4 z-50 flex flex-wrap gap-2 font-mono text-xs">
        {ACCENTS.map((a) => (
          <button key={a} onClick={() => setAccent(a)} className="rounded border bg-card px-2 py-1">
            {a}
          </button>
        ))}
        {LABS.map((p) => (
          <button key={p} onClick={() => setLab(p)} className="rounded border bg-card px-2 py-1">
            {p}
          </button>
        ))}
        <button onClick={() => setSending(true)} className="rounded border bg-primary px-2 py-1 text-primary-foreground">
          send
        </button>
        <button onClick={() => setDocked((d) => !d)} className="rounded border bg-card px-2 py-1">
          {docked ? "docked" : "empty"}
        </button>
        <span className="px-2 py-1">{lab}</span>
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-10">
        <div className="relative flex w-full flex-col items-center justify-center">
          <div className="mb-5 grid w-full grid-cols-1 grid-rows-1 justify-items-center sm:mb-6">
            <p className="font-serif text-3xl text-foreground sm:text-4xl">Can&apos;t sleep?, Liam</p>
          </div>

          <div
            className={cn(
              "composer-aura-host relative z-10 w-full max-w-[44rem]",
              sending && "is-sending"
            )}
            style={{ "--aura-provider": providerGlow(lab) } as React.CSSProperties}
          >
            <div aria-hidden className={cn("composer-aura", docked && "composer-aura--docked")} />
            <div className="mx-auto w-full px-0 pb-4 sm:max-w-[48rem] sm:px-4">
              <div className="composer-surface relative flex w-full flex-col rounded-composer border border-border/65 bg-card/95 p-3 backdrop-blur sm:rounded-lg">
                <textarea
                  placeholder="Message Juno…"
                  className="min-h-[56px] w-full resize-none bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground/70"
                />
                <div className="flex items-center justify-between pt-1">
                  <div className="h-9 w-9 rounded-composer-control border border-border/60" />
                  <button
                    onClick={() => setSending(true)}
                    className="h-9 w-9 rounded-composer-action bg-primary"
                    aria-label="send"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
