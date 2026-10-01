"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import raster from "../../../../docs/rework/brand/assets/alevr-continuum-symbol.png";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { AlevrWordmark } from "@/components/brand/alevr-wordmark";
import { ALEVR_WORDMARK } from "@/components/brand/alevr-wordmark-geometry";
import { CodeGlyph } from "@/components/brand/code-glyph";
import {
  CONTINUUM_APERTURE,
  CONTINUUM_BOUNDS,
  CONTINUUM_MASTER,
  CONTINUUM_MASTER_PATHS,
  CONTINUUM_OPTICAL,
  CONTINUUM_PATH_WIDTH,
  CONTINUUM_SOURCE,
  CONTINUUM_SQUARE_VIEWBOX,
  type ContinuumOpticalSize,
} from "@/components/brand/continuum-geometry";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { OrbitGlyph } from "@/components/brand/orbit-glyph";
import { ThinkingMark, type ThinkingPhase } from "@/components/brand/thinking-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* V3 specimen plates: explicit values so light and dark sit side by side whatever the page theme. */
const PLATE = {
  light: { background: "#fcfcfd", color: "#191b1e", rule: "#e3e4e6", sub: "#686b70" },
  dark: { background: "#18191b", color: "#e8e9eb", rule: "#2d2e31", sub: "#95979c" },
} as const;
type PlateTone = keyof typeof PLATE;

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-border py-10">
      <h2 id={`${id}-title`} className="font-serif text-heading font-semibold tracking-tight">
        {title}
      </h2>
      {note ? <p className="mt-1.5 max-w-prose text-ui text-muted-foreground">{note}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Plate({ tone, className, children, label }: { tone: PlateTone; className?: string; children: ReactNode; label?: string }) {
  const p = PLATE[tone];
  return (
    <figure className={cn("min-w-0 rounded-xl border p-5", className)} style={{ background: p.background, color: p.color, borderColor: p.rule }}>
      {children}
      {label ? (
        <figcaption className="mt-4 text-label" style={{ color: p.sub }}>
          {label}
        </figcaption>
      ) : null}
    </figure>
  );
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** Rasterises an SVG at `size` px in this browser, then shows it enlarged with hard pixels. */
function PixelZoom({ svg, size, zoom = 8, label }: { svg: string; size: number; zoom?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    loadImage(svgUrl(svg)).then((img) => {
      if (cancelled || !ref.current) return;
      const small = document.createElement("canvas");
      small.width = size;
      small.height = size;
      small.getContext("2d")?.drawImage(img, 0, 0, size, size);
      const c = ref.current;
      c.width = size * zoom;
      c.height = size * zoom;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, size * zoom, size * zoom);
    });
    return () => {
      cancelled = true;
    };
  }, [svg, size, zoom]);
  return <canvas ref={ref} role="img" aria-label={label} style={{ width: size * zoom, height: size * zoom, imageRendering: "pixelated" }} />;
}

const markSvg = (viewBox: string, paths: readonly { d: string }[], size: number, fg: string, bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}"><rect x="-1000" y="-1000" width="3000" height="3000" fill="${bg}"/><g fill="${fg}">${paths.map((p) => `<path d="${p.d}"/>`).join("")}</g></svg>`;

/* ———————————————————————— 1. The mark at size ———————————————————————— */

const LADDER = [16, 20, 24, 32, 64, 256] as const;

function MarkLadder() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["light", "dark"] as const).map((tone) => (
        <Plate key={tone} tone={tone} label={`${tone === "light" ? "Graphite on light" : "Pale neutral on dark"} · 16, 20, 24, 32, 64, 256 px`}>
          <div className="flex flex-wrap items-end gap-6">
            {LADDER.map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <ContinuumMark size={s} tone="current" className={s === 256 ? "max-w-full h-auto" : undefined} />
                <span className="font-mono text-micro tabular-nums" style={{ color: PLATE[tone].sub }}>
                  {s}
                </span>
              </div>
            ))}
          </div>
        </Plate>
      ))}
    </div>
  );
}

/* ———————————————————————— 2. Fidelity: vector over the raster ———————————————————————— */

type Fidelity = { iou: number; inter: number; union: number; rasterOnly: number; vectorOnly: number };

function FidelityCheck() {
  const [result, setResult] = useState<Fidelity | null>(null);
  const diff = useRef<HTMLCanvasElement>(null);
  const { size: W, origin, unitPx } = CONTINUUM_SOURCE;
  const vectorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><rect width="${W}" height="${W}" fill="#fff"/><g fill="#000" transform="translate(${origin[0]} ${origin[1]}) scale(${unitPx})">${CONTINUUM_MASTER_PATHS.map((p) => `<path d="${p.d}"/>`).join("")}</g></svg>`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [r, v] = await Promise.all([loadImage(raster.src), loadImage(svgUrl(vectorSvg))]);
      const grab = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = W;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, W);
        ctx.drawImage(img, 0, 0, W, W);
        return ctx.getImageData(0, 0, W, W);
      };
      const a = grab(r).data;
      const b = grab(v).data;
      const out = new ImageData(W, W);
      let inter = 0;
      let union = 0;
      let rasterOnly = 0;
      let vectorOnly = 0;
      for (let i = 0; i < W * W; i++) {
        const o = i * 4;
        const la = 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2] < 128;
        const lb = 0.2126 * b[o] + 0.7152 * b[o + 1] + 0.0722 * b[o + 2] < 128;
        if (la && lb) inter++;
        if (la || lb) union++;
        if (la && !lb) rasterOnly++;
        if (lb && !la) vectorOnly++;
        // both: graphite; raster only: red; vector only: blue; neither: paper
        const [cr, cg, cb] = la && lb ? [200, 201, 204] : la ? [214, 40, 40] : lb ? [45, 73, 201] : [252, 252, 253];
        out.data[o] = cr;
        out.data[o + 1] = cg;
        out.data[o + 2] = cb;
        out.data[o + 3] = 255;
      }
      if (cancelled) return;
      setResult({ iou: inter / union, inter, union, rasterOnly, vectorOnly });
      const c = diff.current;
      if (c) {
        c.width = W;
        c.height = W;
        c.getContext("2d")?.putImageData(out, 0, 0);
      }
    })().catch(() => setResult(null));
    return () => {
      cancelled = true;
    };
  }, [vectorSvg, W]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Plate tone="light" label="The vector (blue, 50%) over the owner-selected raster">
        <div className="relative mx-auto aspect-square w-full max-w-[560px]">
          {/* eslint-disable-next-line @next/next/no-img-element -- the raw source pixels are the point */}
          <img src={raster.src} alt="The selected Continuum raster" className="absolute inset-0 size-full" />
          <svg viewBox={`0 0 ${W} ${W}`} className="absolute inset-0 size-full" aria-hidden="true">
            <g fill="#2d49c9" fillOpacity={0.5} transform={`translate(${origin[0]} ${origin[1]}) scale(${unitPx})`}>
              {CONTINUUM_MASTER_PATHS.map((p) => (
                <path key={p.id} d={p.d} />
              ))}
            </g>
          </svg>
        </div>
      </Plate>
      <Plate tone="light" label="Thresholded at 50% luminance, in this browser: both (grey), raster only (red), vector only (blue)">
        <canvas ref={diff} role="img" aria-label="Silhouette difference map" className="mx-auto block aspect-square w-full max-w-[560px]" />
        <p className="mt-4 font-mono text-ui tabular-nums" data-testid="fidelity-result">
          {result
            ? `IoU ${result.iou.toFixed(4)} · ${result.inter.toLocaleString("en")} shared px · raster only ${result.rasterOnly.toLocaleString("en")} · vector only ${result.vectorOnly.toLocaleString("en")}`
            : "Measuring…"}
        </p>
      </Plate>
    </div>
  );
}

/* ———————————————————————— 3. Construction ———————————————————————— */

function Construction({ tone }: { tone: PlateTone }) {
  const p = PLATE[tone];
  const b = CONTINUUM_BOUNDS;
  const pad = 30;
  const presence = tone === "light" ? "#2d49c9" : "#97a6e6";
  return (
    <Plate tone={tone} label="Nodes only at tips (diamonds) and extrema (circles), axis-aligned handles at every extremum, the aperture circle (r 24) at the origin, one path width (48) as clear space">
      <svg viewBox={`${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`} className="mx-auto block w-full max-w-[720px]" role="img" aria-label="Continuum construction">
        <rect x={b.x - CONTINUUM_PATH_WIDTH / 2} y={b.y - CONTINUUM_PATH_WIDTH / 2} width={b.width + CONTINUUM_PATH_WIDTH} height={b.height + CONTINUUM_PATH_WIDTH} fill="none" stroke={p.rule} strokeDasharray="3 3" strokeWidth={0.6} />
        <rect x={b.x} y={b.y} width={b.width} height={b.height} fill="none" stroke={p.sub} strokeWidth={0.4} />
        <line x1={b.x - pad} x2={b.x + b.width + pad} y1={0} y2={0} stroke={p.rule} strokeWidth={0.4} />
        <line y1={b.y - pad} y2={b.y + b.height + pad} x1={0} x2={0} stroke={p.rule} strokeWidth={0.4} />
        <g fill={p.color} fillOpacity={0.14}>
          {CONTINUUM_MASTER_PATHS.map((m) => (
            <path key={m.id} d={m.d} />
          ))}
        </g>
        <g fill="none" stroke={p.color} strokeWidth={0.6}>
          {CONTINUUM_MASTER_PATHS.map((m) => (
            <path key={m.id} d={m.d} />
          ))}
        </g>
        <circle cx={CONTINUUM_APERTURE.cx} cy={CONTINUUM_APERTURE.cy} r={CONTINUUM_APERTURE.r} fill="none" stroke={presence} strokeWidth={0.6} />
        {CONTINUUM_MASTER.map((blade) =>
          blade.segments.map((s, i) => {
            const from = blade.nodes[i].p;
            return (
              <g key={`${blade.id}-${i}`} stroke={presence} strokeWidth={0.4}>
                <line x1={from[0]} y1={from[1]} x2={s.c1[0]} y2={s.c1[1]} />
                <line x1={s.to[0]} y1={s.to[1]} x2={s.c2[0]} y2={s.c2[1]} />
                <circle cx={s.c1[0]} cy={s.c1[1]} r={0.9} fill={p.background} />
                <circle cx={s.c2[0]} cy={s.c2[1]} r={0.9} fill={p.background} />
              </g>
            );
          }),
        )}
        {CONTINUUM_MASTER.map((blade) =>
          blade.nodes.map((n, i) =>
            n.kind === "tip" ? (
              <rect key={`${blade.id}-n${i}`} x={n.p[0] - 1.6} y={n.p[1] - 1.6} width={3.2} height={3.2} transform={`rotate(45 ${n.p[0]} ${n.p[1]})`} fill={presence} />
            ) : (
              <circle key={`${blade.id}-n${i}`} cx={n.p[0]} cy={n.p[1]} r={1.6} fill={presence} />
            ),
          ),
        )}
        {CONTINUUM_MASTER.map((blade, i) => {
          const c = blade.nodes.reduce((acc, n) => [acc[0] + n.p[0] / blade.nodes.length, acc[1] + n.p[1] / blade.nodes.length], [0, 0]);
          return (
            <text key={blade.id} x={c[0]} y={c[1]} fontSize={7} textAnchor="middle" fill={p.sub} fontFamily="ui-monospace, monospace">
              {i + 1}
            </text>
          );
        })}
      </svg>
    </Plate>
  );
}

/* ———————————————————————— 4. Optical masters ———————————————————————— */

const OPTICAL_SIZES: ContinuumOpticalSize[] = [16, 20, 24, 32];

function OpticalBench({ tone }: { tone: PlateTone }) {
  const p = PLATE[tone];
  return (
    <Plate tone={tone} label="Each pair: the master scaled down (left) and the optical master (right), rasterised by this browser at the real size, then enlarged 8x">
      <div className="flex flex-wrap gap-8">
        {OPTICAL_SIZES.map((n) => (
          <div key={n} className="flex flex-col gap-3">
            <div className="flex items-end gap-3">
              <PixelZoom size={n} zoom={n <= 20 ? 8 : 6} label={`Master scaled to ${n} px`} svg={markSvg(CONTINUUM_SQUARE_VIEWBOX, CONTINUUM_MASTER_PATHS, n, p.color, p.background)} />
              <PixelZoom size={n} zoom={n <= 20 ? 8 : 6} label={`Optical master at ${n} px`} svg={markSvg(`0 0 ${n} ${n}`, CONTINUUM_OPTICAL[n].blades, n, p.color, p.background)} />
            </div>
            <div className="flex items-center gap-3">
              <ContinuumMark size={n} tone="current" />
              <span className="font-mono text-micro tabular-nums" style={{ color: p.sub }}>
                {n} px · channels ≥ {CONTINUUM_OPTICAL[n].channel} px
              </span>
            </div>
          </div>
        ))}
      </div>
    </Plate>
  );
}

/* ———————————————————————— 5. Wordmark and lockups ———————————————————————— */

function Lockups() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["light", "dark"] as const).map((tone) => (
        <Plate key={tone} tone={tone} label="Lockup at 64, 40 and 24 px; wordmark at 72 px wide (the minimum) and 40 px tall; one path width of clear space dashed">
          <div className="flex flex-col items-start gap-8">
            <div className="relative max-w-full">
              <AlevrLockup height={64} tone="current" withClearSpace className="h-auto max-w-full" style={{ outline: `1px dashed ${PLATE[tone].rule}` }} />
            </div>
            <AlevrLockup height={40} tone="current" className="h-auto max-w-full" />
            <AlevrLockup height={24} tone="current" />
            <div className="flex items-end gap-8">
              <AlevrWordmark height={40} tone="current" />
              <AlevrWordmark height={Math.round(((72 * ALEVR_WORDMARK.bounds.height) / ALEVR_WORDMARK.bounds.width) * 100) / 100} tone="current" />
            </div>
          </div>
        </Plate>
      ))}
    </div>
  );
}

/* ———————————————————————— 6. Orbit and Code ———————————————————————— */

function Glyphs() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["light", "dark"] as const).map((tone) => (
        <Plate key={tone} tone={tone} label="Orbit and Code at their 16, 20 and 24 px masters, then beside their navigation labels at 16 px">
          <div className="flex flex-wrap items-end gap-6">
            {([16, 20, 24] as const).map((s) => (
              <div key={`o${s}`} className="flex flex-col items-center gap-2">
                <OrbitGlyph size={s} />
                <span className="font-mono text-micro" style={{ color: PLATE[tone].sub }}>
                  {s}
                </span>
              </div>
            ))}
            {([16, 20, 24] as const).map((s) => (
              <div key={`c${s}`} className="flex flex-col items-center gap-2">
                <CodeGlyph size={s} />
                <span className="font-mono text-micro" style={{ color: PLATE[tone].sub }}>
                  {s}
                </span>
              </div>
            ))}
          </div>
          <ul className="mt-6 flex w-56 flex-col gap-0.5 text-ui">
            <li className="flex h-8 items-center gap-2.5 rounded-lg px-2">
              <ContinuumMark size={16} tone="current" />
              Chat
            </li>
            <li className="flex h-8 items-center gap-2.5 rounded-lg px-2" style={{ background: tone === "light" ? "#e6e7e9" : "#2d2e31" }}>
              <OrbitGlyph size={16} />
              Orbit
            </li>
            <li className="flex h-8 items-center gap-2.5 rounded-lg px-2">
              <CodeGlyph size={16} />
              Code
            </li>
          </ul>
        </Plate>
      ))}
    </div>
  );
}

/* ———————————————————————— 7. Application icons and favicon ———————————————————————— */

function Icons() {
  // Cache-bust so a re-export shows without a hard reload.
  const v = "?v=continuum-1";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-6">
        {[
          { src: `/brand/icon-512.png${v}`, label: "Manifest any 512 · icon.png", size: 128 },
          { src: `/apple-icon.png${v}`, label: "Apple touch 180 (system rounds it)", size: 128 },
          { src: `/brand/app-icon-mac.png${v}`, label: "Download page Mac icon", size: 128 },
          { src: `/brand/icon-192.png${v}`, label: "Manifest any 192", size: 96 },
        ].map((i) => (
          <figure key={i.src} className="flex flex-col items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- the exported file itself is under review */}
            <img src={i.src} alt="" width={i.size} height={i.size} />
            <figcaption className="max-w-36 text-center text-label text-muted-foreground">{i.label}</figcaption>
          </figure>
        ))}
        <figure className="flex flex-col items-center gap-2">
          <div className="relative size-32 overflow-hidden rounded-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- the exported file itself is under review */}
            <img src={`/brand/icon-maskable-512.png${v}`} alt="" width={128} height={128} className="size-32" style={{ transform: "scale(1.25)" }} />
          </div>
          <figcaption className="max-w-36 text-center text-label text-muted-foreground">Maskable 512 under a circle mask (80% safe zone)</figcaption>
        </figure>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {(["light", "dark"] as const).map((tone) => (
          <Plate key={tone} tone={tone} label="favicon.ico at its real 16 px, in a tab">
            <div className="flex items-center gap-2 rounded-t-lg border px-3 py-2" style={{ background: tone === "light" ? "#ffffff" : "#222326", borderColor: PLATE[tone].rule, width: 240 }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the real favicon at its real size */}
              <img src={`/favicon.ico${v}`} alt="" width={16} height={16} />
              <span className="truncate text-label">Alevr</span>
            </div>
          </Plate>
        ))}
      </div>
    </div>
  );
}

/* ———————————————————————— 8. Thinking bench ———————————————————————— */

const PHASE_WORDS: Record<ThinkingPhase, string> = {
  thinking: "Thinking",
  working: "Reading files",
  waiting: "Waiting for your answer",
  finished: "Finished",
  error: "Couldn’t finish",
  idle: "Ready",
};

const PHASE_STYLE: Record<ThinkingPhase, CSSProperties> = {
  thinking: { color: "hsl(var(--foreground))" },
  working: { color: "hsl(var(--foreground))" },
  waiting: { color: "hsl(var(--attention))" },
  finished: { color: "hsl(var(--muted-foreground))" },
  error: { color: "hsl(var(--foreground))" },
  idle: { color: "hsl(var(--muted-foreground))" },
};

function ThinkingBench() {
  const [phase, setPhase] = useState<ThinkingPhase>("idle");
  const [eventKey, setEventKey] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [sent, setSent] = useState(0);
  const [passes, setPasses] = useState<number[]>([]);
  // A fresh run remounts the marks, the way a new work row mounts one in the product,
  // so the 200 ms show delay is part of what the bench shows.
  const [run, setRun] = useState(0);
  const t0 = useRef(0);
  const burst = useRef<ReturnType<typeof setInterval> | null>(null);
  const watched = useRef<HTMLDivElement>(null);

  // Count passes as the mark draws them (the <g data-mode="pass"> remounts per pass).
  useEffect(() => {
    const el = watched.current;
    if (!el) return;
    let last: Element | null = null;
    const check = () => {
      const g = el.querySelector('[data-mode="pass"]');
      if (g && g !== last) setPasses((p) => [...p, Math.round(performance.now() - t0.current)]);
      last = g;
    };
    const mo = new MutationObserver(check);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-mode"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => () => {
    if (burst.current) clearInterval(burst.current);
  }, []);

  const go = (p: ThinkingPhase) => {
    if (p === "thinking" || p === "working") {
      if (phase !== "thinking" && phase !== "working") {
        t0.current = performance.now();
        setPasses([]);
        setSent(0);
        setRun((r) => r + 1);
      }
    }
    setPhase(p);
  };
  const event = () => {
    setEventKey((k) => k + 1);
    setSent((n) => n + 1);
  };
  const runBurst = () => {
    if (burst.current) clearInterval(burst.current);
    const start = performance.now();
    burst.current = setInterval(() => {
      event();
      if (performance.now() - start > 3000 && burst.current) {
        clearInterval(burst.current);
        burst.current = null;
      }
    }, 50);
  };

  const pending = phase === "thinking" || phase === "working";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Thinking mark controls">
        <Button size="sm" variant="outline" onClick={() => go("thinking")}>Start thinking</Button>
        <Button size="sm" variant="outline" onClick={() => go("working")}>Tool work</Button>
        <Button size="sm" variant="outline" onClick={event} disabled={!pending}>One event</Button>
        <Button size="sm" variant="outline" onClick={runBurst} disabled={!pending}>Event burst (3 s at 20 Hz)</Button>
        <Button size="sm" variant="outline" onClick={() => go("waiting")}>Waiting</Button>
        <Button size="sm" variant="outline" onClick={() => go("finished")}>Finished</Button>
        <Button size="sm" variant="outline" onClick={() => go("error")}>Error</Button>
        <Button size="sm" variant="outline" onClick={() => go("idle")}>Idle</Button>
        <Button size="sm" variant={reduced ? "secondary" : "outline"} aria-pressed={reduced} onClick={() => setReduced((r) => !r)}>
          Reduced motion {reduced ? "on" : "off"}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-ui" aria-live="polite">
            <ThinkingMark key={`s${run}`} phase={phase} eventKey={eventKey} size={16} reducedMotion={reduced || undefined} />
            <span style={PHASE_STYLE[phase]}>{PHASE_WORDS[phase]}</span>
          </div>
          <div className="flex items-center gap-2.5 text-body">
            <ThinkingMark key={`m${run}`} phase={phase} eventKey={eventKey} size={20} reducedMotion={reduced || undefined} />
            <span style={PHASE_STYLE[phase]}>{PHASE_WORDS[phase]}</span>
          </div>
          <p className="mt-2 font-mono text-label tabular-nums text-muted-foreground" data-testid="thinking-log">
            phase {phase} · events sent {sent} · passes {passes.length}
            {passes.length ? ` at ${passes.map((t) => `${(t / 1000).toFixed(2)}s`).join(", ")}` : ""}
          </p>
        </div>
        <div ref={watched} className="flex items-center justify-center rounded-xl border border-border bg-card p-6" data-testid="thinking-large">
          <ThinkingMark key={`l${run}`} phase={phase} eventKey={eventKey} size={96} reducedMotion={reduced || undefined} />
        </div>
      </div>
    </div>
  );
}

/* ———————————————————————— Page ———————————————————————— */

export function BrandGallery() {
  return (
    <main className="mx-auto min-h-dvh max-w-6xl bg-background px-4 pb-24 pt-10 text-foreground sm:px-8">
      <header className="flex flex-col gap-4">
        <AlevrLockup height={44} tone="ink" />
        <p className="max-w-prose text-ui text-muted-foreground">
          Continuum, rebuilt from the owner-selected raster as four clockwise blades with nodes only at tips and extrema, curvature-continuous joins and a half-unit lattice; optical masters for 16, 20, 24 and 32 px; the outlined Newsreader wordmark; the Orbit and Code glyphs; every exported icon; and the thinking mark. Method and evidence: docs/rework/brand/CONTINUUM_GEOMETRY.md.
        </p>
      </header>
      <Section id="ladder" title="The mark at size">
        <MarkLadder />
      </Section>
      <Section id="fidelity" title="Fidelity to the selected raster" note="The silhouette overlap is measured here, in this browser, by thresholding both images at 50% luminance.">
        <FidelityCheck />
      </Section>
      <Section id="construction" title="Construction">
        <div className="grid gap-4 xl:grid-cols-2">
          <Construction tone="light" />
          <Construction tone="dark" />
        </div>
      </Section>
      <Section id="optical" title="Optical masters" note="Below 32 px the master's channels fall under a pixel and the blades fuse. Each optical master opens every channel to its minimum width and leaves the rest of the outline where it was.">
        <div className="flex flex-col gap-4">
          <OpticalBench tone="light" />
          <OpticalBench tone="dark" />
        </div>
      </Section>
      <Section id="lockups" title="Wordmark and lockups" note="Upright Newsreader SemiBold, outlined, with optical kerning. The mark stands 1.18 cap heights tall, 1.5 path widths from the word.">
        <Lockups />
      </Section>
      <Section id="glyphs" title="Orbit and Code" note="Two separated open elliptical arcs in point symmetry (b = a / φ); opposed brackets with an inset cursor. Static, in the V3 icon grammar.">
        <Glyphs />
      </Section>
      <Section id="icons" title="Application icons and favicon" note="Exported by scripts/brand/export-brand-assets.ts from the same geometry: a charcoal tile with the pale mark at 64% of its width.">
        <Icons />
      </Section>
      <Section id="thinking" title="Thinking mark" note="The silhouette never moves. A pass hands presence ink along the blades in order (220 ms per blade, 70 ms apart), once when work starts and again for new real activity, at most once every 1.6 s. Nothing for the first 200 ms; once shown, at least 400 ms. Waiting and error are static; finished settles once.">
        <ThinkingBench />
      </Section>
    </main>
  );
}
