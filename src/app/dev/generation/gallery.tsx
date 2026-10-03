"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { MessageItem } from "@/components/chat/message-item";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { GeneratedImage } from "@/components/chat/generated-media";
import { Button } from "@/components/ui/button";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ChatMessage } from "@/hooks/use-chat";
import type { AppBootstrap } from "@/types/app";
import type { ClientArtifact, ClientAttachment } from "@/types/chat";

/* Only what the rendered components read is filled in (see /dev/transcript). */
const BOOTSTRAP = {
  user: { id: "dev", name: "Dev", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
    personality: "default",
    customInstructions: "",
    responseLanguage: "auto",
    uiLocale: "en",
    memoryEnabled: true,
    memorySensitiveTopics: [],
    memoryBackgroundLearning: false,
    backgroundProviderMode: "same_provider",
    voiceId: null,
    favoriteModels: [],
    emailBudgetAlerts: false,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: true,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic", "openai", "google"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const noop = () => {};

/* ---- Sample pictures, painted locally so the gallery needs no network ---- */

type Palette = { sky: [string, string]; sun: string; hills: string[] };
const PALETTES: Palette[] = [
  { sky: ["#f6c58f", "#5b6fa8"], sun: "#fff1d6", hills: ["#43517a", "#2c3557", "#1a2038"] },
  { sky: ["#bfe0dc", "#3f7f86"], sun: "#f4fbf6", hills: ["#2f6168", "#1f4348", "#122a2e"] },
  { sky: ["#f2d7e2", "#7e5a8c"], sun: "#fff4f6", hills: ["#5d4370", "#3f2d50", "#241a30"] },
  { sky: ["#e8e3d3", "#8c8774"], sun: "#ffffff", hills: ["#6c6a58", "#4b4a3d", "#2c2b23"] },
];

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette, t = 0) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, p.sky[1]);
  sky.addColorStop(0.62, p.sky[0]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.11;
  const sunY = h * (0.46 - t * 0.08);
  const glow = ctx.createRadialGradient(w * 0.66, sunY, r * 0.2, w * 0.66, sunY, r * 4);
  glow.addColorStop(0, p.sun);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = p.sun;
  ctx.beginPath();
  ctx.arc(w * 0.66, sunY, r, 0, Math.PI * 2);
  ctx.fill();
  p.hills.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    const base = h * (0.6 + i * 0.12);
    ctx.moveTo(0, h);
    for (let i2 = 0; i2 <= 48; i2++) {
      const x = (w * i2) / 48;
      const y = base - Math.sin(x / (w * (0.12 + i * 0.05)) + i * 1.7 + t) * h * (0.05 + i * 0.015) - Math.cos(x / (w * 0.05) + i) * h * 0.008;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  });
  // Fine detail, so the resolve has something to sharpen.
  ctx.fillStyle = "rgba(255,255,255,.55)";
  for (let i = 0; i < 140; i++) {
    const x = ((i * 97) % 1000) / 1000;
    const y = ((i * 61) % 1000) / 1000;
    ctx.fillRect(x * w, y * h * 0.45, 2, 2);
  }
}

function useSamplePicture(w: number, h: number, palette: number): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, w, h, PALETTES[palette % PALETTES.length]);
    let made: string | null = null;
    let cancelled = false;
    canvas.toBlob((blob) => {
      if (!blob || cancelled) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, "image/png");
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [w, h, palette]);
  return url;
}

/** A short clip recorded from a canvas, so the video reveal has a real <video>. */
function useSampleClip(w: number, h: number): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (typeof MediaRecorder === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.captureStream !== "function") return;
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    let made: string | null = null;
    let frame = 0;
    let raf = 0;
    const draw = () => {
      paint(ctx, w, h, PALETTES[0], frame / 90);
      frame++;
      raf = requestAnimationFrame(draw);
    };
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      cancelAnimationFrame(raf);
      made = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      setUrl(made);
    };
    draw();
    recorder.start();
    const stop = window.setTimeout(() => recorder.stop(), 1600);
    return () => {
      window.clearTimeout(stop);
      cancelAnimationFrame(raf);
      if (recorder.state === "recording") recorder.stop();
      if (made) URL.revokeObjectURL(made);
    };
  }, [w, h]);
  return url;
}

function attachment(id: string, url: string, kind: "IMAGE" | "FILE", mimeType: string): ClientAttachment {
  return { id, kind, fileName: `${id}.${mimeType.split("/")[1]}`, mimeType, size: 1, url };
}

/* ---- One replayable generating turn on the real MessageItem ---- */

interface Scenario {
  id: string;
  label: string;
  modality: "image" | "video";
  aspect?: string;
  results: Array<{ url: string | null; mime: string }>;
}

declare global {
  interface Window {
    /** Playwright: settle one scenario (or all) now, so the reveal can be timed. */
    __genArrive?: (id?: string) => void;
    __genReset?: (id?: string) => void;
  }
}

const listeners = new Map<string, { arrive: () => void; reset: () => void }>();

function ReplayTurn({ scenario, hold }: { scenario: Scenario; hold: boolean }) {
  const ready = scenario.results.every((r) => r.url);
  const [settled, setSettled] = React.useState(false);
  const [run, setRun] = React.useState(0);

  React.useEffect(() => {
    listeners.set(scenario.id, { arrive: () => setSettled(true), reset: () => setSettled(false) });
    return () => void listeners.delete(scenario.id);
  }, [scenario.id]);

  // Without ?hold, each run waits 2.4s in the field and then arrives.
  React.useEffect(() => {
    if (hold || !ready || settled) return;
    const timer = window.setTimeout(() => setSettled(true), 2400);
    return () => window.clearTimeout(timer);
  }, [hold, ready, settled, run]);

  const message: ChatMessage = settled
    ? {
        id: `${scenario.id}-done`,
        renderKey: scenario.id,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date(0).toISOString(),
        conversationId: "dev-conversation",
        attachments: scenario.results.map((r, i) =>
          attachment(`${scenario.id}-${i}`, r.url ?? "", r.mime.startsWith("video/") ? "FILE" : "IMAGE", r.mime)
        ),
      }
    : {
        id: `${scenario.id}-temp`,
        renderKey: scenario.id,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date(0).toISOString(),
        conversationId: "dev-conversation",
        attachments: [],
        streaming: true,
        progress: {
          modality: scenario.modality,
          stage: scenario.modality === "video" ? "polling" : "generating",
          ...(scenario.modality === "video" ? { pct: 64 } : {}),
          ...(scenario.aspect ? { aspect: scenario.aspect } : {}),
          ...(scenario.results.length > 1 ? { count: scenario.results.length } : {}),
        },
      };

  return (
    <div data-scenario={scenario.id} data-settled={settled ? "true" : "false"}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground">{scenario.label}</p>
        <Button
          variant="outline"
          size="sm"
          data-replay={scenario.id}
          onClick={() => {
            setSettled(false);
            setRun((n) => n + 1);
          }}
        >
          Replay
        </Button>
      </div>
      {/* Keyed by renderKey, as MessageList does, so the turn survives settling. */}
      <MessageItem
        key={scenario.id}
        message={message}
        isLast
        busy={false}
        artifactsByIdentifier={NO_ARTIFACTS}
        onOpenArtifact={noop}
        onFeedback={noop}
        canFeedback={false}
      />
    </div>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-gen-section={id} className="border-t border-border py-10">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-body text-muted-foreground">{note}</p>}
      <div className="mt-8 space-y-10">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-caption text-muted-foreground">{children}</p>;
}

export function GenerationGallery({ only, dark: startDark }: { only?: string; dark?: boolean }) {
  const show = (id: string) => !only || only === id;
  const [dark, setDark] = React.useState(!!startDark);
  const [hold, setHold] = React.useState(false);
  React.useEffect(() => {
    setHold(new URLSearchParams(window.location.search).has("hold"));
  }, []);
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  React.useEffect(() => {
    window.__genArrive = (id) => (id ? [listeners.get(id)] : [...listeners.values()]).forEach((l) => l?.arrive());
    window.__genReset = (id) => (id ? [listeners.get(id)] : [...listeners.values()]).forEach((l) => l?.reset());
    return () => {
      delete window.__genArrive;
      delete window.__genReset;
    };
  }, []);

  const square = useSamplePicture(1024, 1024, 0);
  const portrait = useSamplePicture(1024, 1536, 2);
  const wide = useSamplePicture(1536, 864, 1);
  const g1 = useSamplePicture(1024, 1024, 1);
  const g2 = useSamplePicture(1024, 1024, 2);
  const g3 = useSamplePicture(1024, 1024, 3);
  const w2 = useSamplePicture(1536, 864, 3);
  const clip = useSampleClip(640, 360);

  const scenarios: Scenario[] = [
    { id: "single", label: "Requested 1:1, arrives 1:1", modality: "image", aspect: "1:1", results: [{ url: square, mime: "image/png" }] },
    { id: "morph", label: "Requested auto (drawn 1:1), arrives 2:3: the frame morphs", modality: "image", results: [{ url: portrait, mime: "image/png" }] },
    { id: "wide", label: "Requested 16:9", modality: "image", aspect: "16:9", results: [{ url: wide, mime: "image/png" }] },
    {
      id: "grid2",
      label: "Two outputs, 16:9",
      modality: "image",
      aspect: "16:9",
      results: [
        { url: wide, mime: "image/png" },
        { url: w2, mime: "image/png" },
      ],
    },
    {
      id: "grid4",
      label: "Four outputs, 1:1",
      modality: "image",
      aspect: "1:1",
      results: [
        { url: square, mime: "image/png" },
        { url: g1, mime: "image/png" },
        { url: g2, mime: "image/png" },
        { url: g3, mime: "image/png" },
      ],
    },
    { id: "video", label: "Video, 16:9", modality: "video", aspect: "16:9", results: [{ url: clip, mime: "video/webm" }] },
  ];

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        <div className="page-gutter mx-auto w-full max-w-3xl py-12">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-serif text-page-title">Generation</h1>
              <p className="mt-1 text-body text-muted-foreground">The wait and the arrival of generated images, video and music.</p>
            </div>
            <Button variant="outline" size="sm" data-theme-toggle onClick={() => setDark((d) => !d)}>
              {dark ? "Light" : "Dark"}
            </Button>
          </div>

          {show("pending") && (
            <Section id="pending" title="Waiting" note="Drawn at the requested ratio, at the width the result will take. The field drifts; the line is the real stage and real seconds.">
              <div data-gen-case="image-1x1">
                <Label>Image, 1:1</Label>
                <GenerationPlaceholder progress={{ modality: "image", stage: "generating", aspect: "1:1" }} />
              </div>
              <div data-gen-case="image-2x3">
                <Label>Image, 2:3</Label>
                <GenerationPlaceholder progress={{ modality: "image", stage: "polling", aspect: "2:3" }} />
              </div>
              <div data-gen-case="image-16x9">
                <Label>Image, 16:9</Label>
                <GenerationPlaceholder progress={{ modality: "image", stage: "generating", aspect: "16:9" }} />
              </div>
              <div data-gen-case="image-grid">
                <Label>Four images, 1:1</Label>
                <GenerationPlaceholder progress={{ modality: "image", stage: "generating", aspect: "1:1", count: 4 }} />
              </div>
              <div data-gen-case="video">
                <Label>Video, with the provider&apos;s progress</Label>
                <GenerationPlaceholder progress={{ modality: "video", stage: "polling", pct: 40, aspect: "16:9" }} />
              </div>
              <div data-gen-case="audio">
                <Label>Music</Label>
                <GenerationPlaceholder progress={{ modality: "audio", stage: "generating" }} />
              </div>
            </Section>
          )}

          {show("reveal") && (
            <Section id="reveal" title="Arrival" note="The real MessageItem, settled with its result: blur, then a top-down resolve while the frame takes the picture's own ratio. Replay runs it again.">
              {scenarios.map((s) => (
                <ReplayTurn key={s.id} scenario={s} hold={hold} />
              ))}
            </Section>
          )}

          {show("history") && (
            <Section id="history" title="From history" note="A turn loaded from the server never generated here, so it does not reveal: the picture fades in at its own ratio.">
              {portrait && <GeneratedImage attachment={attachment("history-portrait", portrait, "IMAGE", "image/png")} />}
              {wide && <GeneratedImage attachment={attachment("history-wide", wide, "IMAGE", "image/png")} />}
            </Section>
          )}
        </div>
      </main>
    </AppProvider>
  );
}
