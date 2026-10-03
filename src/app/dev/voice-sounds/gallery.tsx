"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { playVoiceCue } from "@/components/voice/voice-cue-player";
import { analyseCue, cueDuration, VOICE_CUES, type CueAnalysis, type VoiceCueKind } from "@/lib/voice-cues";

type Report = Record<VoiceCueKind, CueAnalysis & { sampleRate: number }>;

/** Render a cue the way a call plays it (the same player), offline. */
async function renderOffline(kind: VoiceCueKind, sampleRate: number) {
  const ctx = new OfflineAudioContext(1, Math.ceil((cueDuration(VOICE_CUES[kind]) + 0.05) * sampleRate), sampleRate);
  playVoiceCue(kind, ctx);
  const rendered = await ctx.startRendering();
  return { ...analyseCue(rendered.getChannelData(0), sampleRate), sampleRate };
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "-inf");

export function VoiceSoundsGallery() {
  const [report, setReport] = React.useState<Report | null>(null);

  const measure = React.useCallback(async () => {
    const next = { start: await renderOffline("start", 48_000), end: await renderOffline("end", 48_000) };
    (window as unknown as { __voiceCueReport?: Report }).__voiceCueReport = next;
    setReport(next);
  }, []);

  React.useEffect(() => {
    void measure();
  }, [measure]);

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold">Voice sounds</h1>
        <p className="text-ui text-muted-foreground">
          Ready when a call can hear you, ended when it stops. Synthesised in src/lib/voice-cues.ts.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => playVoiceCue("start")}>Play ready</Button>
        <Button variant="outline" onClick={() => playVoiceCue("end")}>
          Play ended
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            playVoiceCue("start");
            window.setTimeout(() => playVoiceCue("end"), 700);
          }}
        >
          Play both
        </Button>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-ui font-medium">Offline render, 48 kHz</h2>
        <table className="w-full text-left text-ui tabular-nums" data-testid="voice-cue-report">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Cue</th>
              <th className="py-1 font-normal">Length</th>
              <th className="py-1 font-normal">Peak</th>
              <th className="py-1 font-normal">RMS</th>
              <th className="py-1 font-normal">Pitch</th>
            </tr>
          </thead>
          <tbody>
            {(["start", "end"] as const).map((kind) => {
              const r = report?.[kind];
              return (
                <tr key={kind} className="border-t border-border">
                  <td className="py-1.5">{kind === "start" ? "Ready" : "Ended"}</td>
                  <td className="py-1.5">{r ? `${fmt(r.duration * 1000, 0)} ms` : "…"}</td>
                  <td className="py-1.5">{r ? `${fmt(r.peakDbfs)} dBFS` : "…"}</td>
                  <td className="py-1.5">{r ? `${fmt(r.rmsDbfs)} dBFS` : "…"}</td>
                  <td className="py-1.5">{r ? `${fmt(r.firstPitchHz, 0)} → ${fmt(r.lastPitchHz, 0)} Hz` : "…"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}
