"use client";

import * as React from "react";

import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { BuildStage } from "@/components/canvas/live-blueprint";
import type { ArtifactType } from "@/lib/message-content";

const HTML_SAMPLE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Northwind Coffee</title>
<style>
  :root { --roast: #3b2416; --cream: #f6efe6; --accent: #c8642c; }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--cream); color: #1d1410; }
  nav { display: flex; justify-content: space-between; padding: 16px 32px; }
  .hero { background: var(--roast); color: var(--cream); padding: 96px 32px; }
  .btn { background: var(--accent); color: white; padding: 10px 18px; border-radius: 999px; text-decoration: none; }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 48px 32px; }
  .card { background: white; border-radius: 12px; padding: 20px; }
  footer { padding: 32px; background: #1d1410; color: #bfae9c; }
</style>
</head>
<body>
<nav>
  <a href="/">Northwind</a>
  <ul><li><a href="#menu">Menu</a></li><li><a href="#visit">Visit</a></li><li><a href="#story">Story</a></li></ul>
  <a class="btn" href="#order">Order</a>
</nav>
<section class="hero">
  <h1>Coffee roasted this morning</h1>
  <p>Small batches from three farms we know by name.</p>
  <a class="btn" href="#order">Order a bag</a>
</section>
<section id="menu">
  <h2>This week</h2>
  <div class="features">
    <div class="card"><img src="https://example.com/a.jpg" alt=""><h3>Huila</h3><p>Cherry, cocoa.</p></div>
    <div class="card"><img src="https://example.com/b.jpg" alt=""><h3>Yirgacheffe</h3><p>Jasmine, lemon.</p></div>
    <div class="card"><img src="https://example.com/c.jpg" alt=""><h3>Sumatra</h3><p>Cedar, molasses.</p></div>
  </div>
</section>
<section id="visit">
  <h2>Visit</h2>
  <p>14 Harbour Street. Open 7 to 4, every day.</p>
  <img src="https://example.com/map.png" alt="">
</section>
<form id="order">
  <h2>Get the newsletter</h2>
  <input type="email" placeholder="you@example.com">
  <button type="submit">Subscribe</button>
</form>
<footer><p>Northwind Coffee Roasters</p></footer>
<script>
  document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); e.target.reset(); });
</script>
</body>
</html>`;

const REACT_SAMPLE = `import { useState } from "react";

const PLANS = [
  { name: "Starter", price: 0 },
  { name: "Team", price: 12 },
  { name: "Scale", price: 40 },
];

export default function Pricing() {
  const [yearly, setYearly] = useState(false);
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="flex items-center justify-between px-8 py-4">
        <span className="font-semibold">Lumen</span>
        <button className="rounded-full bg-indigo-500 px-4 py-2">Sign in</button>
      </nav>
      <header className="px-8 py-20 text-center bg-indigo-900">
        <h1 className="font-bold">Simple pricing</h1>
        <p className="mt-4 text-slate-300">Pay for what you use.</p>
        <button onClick={() => setYearly((y) => !y)} className="mt-6 rounded-full bg-white/10 px-4 py-2">Yearly</button>
      </header>
      <section className="grid grid-cols-3 gap-6 px-8 py-12">
        <PlanCard plan={PLANS[0]} yearly={yearly} />
        <PlanCard plan={PLANS[1]} yearly={yearly} />
        <PlanCard plan={PLANS[2]} yearly={yearly} />
      </section>
      <footer className="px-8 py-10 text-slate-400">© Lumen</footer>
    </div>
  );
}

function PlanCard({ plan, yearly }) {
  return (
    <div className="rounded-xl bg-slate-900 p-6">
      <h3 className="font-semibold">{plan.name}</h3>
      <p className="mt-2 font-bold">\${yearly ? plan.price * 10 : plan.price}</p>
    </div>
  );
}
`;

const SOURCES: Record<string, { type: ArtifactType; title: string; language: string; content: string }> = {
  html: { type: "HTML", title: "Northwind Coffee", language: "html", content: HTML_SAMPLE },
  react: { type: "REACT", title: "Lumen pricing", language: "tsx", content: REACT_SAMPLE },
};

/** Characters per 50ms tick: a model's pace, and a faster one for looking at the end. */
const SPEEDS = { steady: 14, fast: 60 } as const;

function useStream(source: string, speed: number, nonce: number) {
  const [length, setLength] = React.useState(0);
  React.useEffect(() => {
    setLength(0);
    const timer = window.setInterval(() => {
      setLength((n) => {
        const next = Math.min(source.length, n + speed);
        if (next >= source.length) window.clearInterval(timer);
        return next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [source, speed, nonce]);
  return { text: source.slice(0, length), streaming: length < source.length };
}

export function BlueprintGallery() {
  const [which, setWhich] = React.useState<keyof typeof SOURCES>("html");
  const [speed, setSpeed] = React.useState<keyof typeof SPEEDS>("steady");
  const [reduced, setReduced] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const [panelBuilding, setPanelBuilding] = React.useState(true);
  const src = SOURCES[which];
  const stream = useStream(src.content, SPEEDS[speed], nonce);

  // The app's Motion setting lives on <html data-motion>; useReducedMotion reads it there.
  React.useEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute("data-motion");
    if (reduced) root.setAttribute("data-motion", "reduced");
    return () => {
      if (before === null) root.removeAttribute("data-motion");
      else root.setAttribute("data-motion", before);
    };
  }, [reduced]);

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2 text-ui">
          <strong className="mr-2">Live blueprint</strong>
          {Object.keys(SOURCES).map((key) => (
            <button key={key} type="button" className="rounded-control border px-2 py-1" aria-pressed={which === key} onClick={() => setWhich(key)}>
              {key}
            </button>
          ))}
          {(Object.keys(SPEEDS) as Array<keyof typeof SPEEDS>).map((key) => (
            <button key={key} type="button" className="rounded-control border px-2 py-1" aria-pressed={speed === key} onClick={() => setSpeed(key)}>
              {key}
            </button>
          ))}
          <button type="button" className="rounded-control border px-2 py-1" aria-pressed={reduced} onClick={() => setReduced((r) => !r)}>
            reduced motion
          </button>
          <button type="button" className="rounded-control border px-2 py-1" onClick={() => setNonce((n) => n + 1)}>
            restart
          </button>
          <span className="text-muted-foreground tabular-nums">
            {stream.text.length} / {src.content.length}
          </span>
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-label text-muted-foreground">In the transcript (the real card)</h2>
          <div className="max-w-2xl">
            <ArtifactInlineCard key={`${which}-${nonce}`} title={src.title} type={src.type} language={src.language} content={stream.text} streaming={stream.streaming} />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-label text-muted-foreground">
            Canvas size, hand-driven exit{" "}
            <button type="button" className="ml-2 rounded-control border px-2 py-0.5" onClick={() => setPanelBuilding((b) => !b)}>
              {panelBuilding ? "dissolve" : "build again"}
            </button>
          </h2>
          <div className="h-[560px] overflow-hidden rounded-card border">
            <BuildStage building={panelBuilding} content={stream.text} type={src.type} language={src.language} streaming={stream.streaming}>
              <div className="grid h-full place-items-center bg-muted text-ui text-muted-foreground">The rendered preview</div>
            </BuildStage>
          </div>
        </section>
      </div>
    </div>
  );
}
