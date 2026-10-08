"use client";

import * as React from "react";
import { ArrowUp, Check, ChevronDown, Mic, Plus, Share2, Telescope } from "@/components/ui/icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import type { Provider } from "@/lib/providers";
import { DotRings } from "./dot-construction";

/**
 * From a question to finished work: one wide stage, three scenes. The tabs
 * advance on their own while the stage is on screen (a progress line under
 * the active tab shows the time left), pause while the pointer or focus is
 * inside, and stop for good once the reader picks a tab. Reduced motion: no
 * auto-advance, scenes swap without travel.
 */

export type Lab = { provider: Provider; label: string; model: string };

const DWELL = 7000;

const TABS = [
  { key: "models", label: "Every model", title: "The right model for every question.", body: (n: number, l: number) => `${n}+ models from ${l} labs in one picker. Auto chooses for each message, or pick exactly the one you want.` },
  { key: "research", label: "Deep Field", title: "Research that reads the sources.", body: () => "Deep Field plans the search, reads what it finds and cites every claim, so you can check the work yourself." },
  { key: "folio", label: "Folio", title: "Answers become finished documents.", body: () => "Briefs, diagrams, code and small apps open in Folio. Edit together, keep every version, share when it is ready." },
] as const;

/* ───────── Models ───────── */
function ModelsScene({ labs, on }: { labs: Lab[]; on: boolean }) {
  const [pick, setPick] = React.useState(0);
  React.useEffect(() => {
    if (!on) { setPick(0); return; }
    const t = window.setTimeout(() => setPick(1), 2600);
    return () => clearTimeout(t);
  }, [on]);
  const rows = labs.slice(0, 5);
  return (
    <div className="alv-sc-models">
      <div className="alv-sc-menu alv-seq" data-on={on || undefined}>
        <div className="alv-sc-menu-row alv-pop" data-active={pick === 0 || undefined}>
          <ContinuumMark size={18} />
          <span><b>Auto</b><small>Picks a model for each message</small></span>
          {pick === 0 && <Check className="alv-sc-check" aria-hidden />}
        </div>
        <div className="alv-sc-menu-sep" />
        {rows.map(({ provider, label, model }, i) => (
          <div key={provider} className="alv-sc-menu-row alv-pop" data-active={pick === 1 && i === 0 ? true : undefined} style={{ transitionDelay: `${90 + i * 60}ms` }}>
            <ProviderLogo provider={provider} className="size-[18px]" />
            <span><b>{model}</b><small>{label.split(" · ")[0]}</small></span>
            {pick === 1 && i === 0 && <Check className="alv-sc-check" aria-hidden />}
          </div>
        ))}
      </div>
      <div className="alv-composer alv-sc-composer">
        <div className="alv-composer-text" style={{ color: "var(--alv-ink)" }}>Draft a reply to the investor update, warm but brief.</div>
        <div className="alv-composer-row">
          <span className="alv-icon-btn"><Plus /></span>
          <span className="alv-model alv-sc-model-on">{pick === 0 ? "Auto" : rows[0]?.model ?? "Auto"}<ChevronDown /></span>
          <span className="alv-icon-btn"><Mic /></span>
          <span className="alv-send"><ArrowUp /></span>
        </div>
      </div>
    </div>
  );
}

/* ───────── Deep Field ───────── */
const SOURCES = [
  { m: "N", t: "Activation benchmarks", x: 18, y: 26 },
  { m: "H", t: "First sessions and retention", x: 80, y: 20 },
  { m: "S", t: "Time to value", x: 88, y: 62 },
  { m: "P", t: "Templates vs blank states", x: 64, y: 86 },
  { m: "R", t: "What users try first", x: 22, y: 78 },
  { m: "A", t: "Onboarding teardown", x: 8, y: 52 },
];
/** The research map's orbits, as fractions of the map. */
const SC_RINGS = [0.2, 0.34, 0.48].map((r) => ({ cy: 0.52, rx: r, ry: r * 0.92 }));
const PLAN = ["Find activation benchmarks", "Read four case studies", "Compare how teams measure", "Write the brief with sources"];

function ResearchScene({ on }: { on: boolean }) {
  const [read, setRead] = React.useState(0);
  React.useEffect(() => {
    if (!on) { setRead(0); return; }
    const ids = SOURCES.map((_, i) => window.setTimeout(() => setRead(i + 1), 500 + i * 780));
    return () => ids.forEach(clearTimeout);
  }, [on]);
  // Each source read draws a line of dots out to it; only the one being read
  // now is presence blue (the frame's one live object), the rest settle to ink.
  const links = React.useMemo(
    () =>
      SOURCES.map((s, i) => ({
        x1: 0.5,
        y1: 0.52,
        x2: s.x / 100,
        y2: s.y / 100,
        tone: i === read - 1 ? ("presence" as const) : ("ink" as const),
        strength: i === read - 1 ? 0.5 : 0.34,
        on: i < read,
      })),
    [read],
  );
  const step = Math.min(PLAN.length - 1, Math.floor((read / SOURCES.length) * (PLAN.length - 1)));
  return (
    <div className="alv-sc-research">
      <div className="alv-sc-map">
        <DotRings rings={SC_RINGS} lines={links} animate={on} />
        <div className="alv-sc-question"><Telescope className="size-4" aria-hidden /><span>How do the best teams measure onboarding?</span></div>
        {SOURCES.map((s, i) => (
          <span key={s.t} className="alv-sc-source" data-on={i < read || undefined} style={{ left: `${s.x}%`, top: `${s.y}%` }}>
            <i>{s.m}</i>{s.t}<sup>{i + 1}</sup>
          </span>
        ))}
      </div>
      <aside className="alv-sc-plan">
        <span className="alv-scene-label">Research plan</span>
        <ol>
          {PLAN.map((p, i) => (
            <li key={p} data-state={i < step ? "done" : i === step ? "now" : "next"}>
              <span className="alv-sc-plan-mark">{i < step ? <Check aria-hidden /> : i === step ? <GalaxyMark phase={on ? "working" : "idle"} size={14} /> : null}</span>{p}
            </li>
          ))}
        </ol>
        <p className="alv-sc-plan-foot">{read} of 22 sources read</p>
      </aside>
    </div>
  );
}

/* ───────── Folio ───────── */
function FolioScene({ on }: { on: boolean }) {
  return (
    <div className="alv-sc-folio">
      <div className="alv-sc-sheet">
        <div className="alv-sc-sheet-bar"><span>Onboarding brief</span><span className="alv-sc-share"><Share2 aria-hidden />Share</span></div>
        <h5>Fix the first five minutes</h5>
        <p>New accounts leave at the same moment in all three studies: the empty workspace right after sign-up.</p>
        <p className="alv-sc-edit" data-on={on || undefined}>Every new account will start from <del>a blank workspace</del><ins>the template for the role chosen at sign-up</ins>, and we will ask for one real file in place of the tour.</p>
        <p>Success is time to a first finished task. Today the median is two days; the target for the next release is one session.</p>
        <div className="alv-sc-lines" aria-hidden><i /><i /><i style={{ width: "62%" }} /></div>
      </div>
      <aside className="alv-sc-versions">
        <span className="alv-scene-label">Versions</span>
        <span className="alv-version" data-active>Version 3<small>Suggested edit</small></span>
        <span className="alv-version">Version 2<small>Edited by you</small></span>
        <span className="alv-version">Version 1<small>Drafted by Alevr</small></span>
      </aside>
    </div>
  );
}

export function Showcase({ labs, modelsFloor, totalLabs }: { labs: Lab[]; modelsFloor: number; totalLabs: number }) {
  const [active, setActive] = React.useState(0);
  const [visible, setVisible] = React.useState(false);
  const [held, setHeld] = React.useState(false);
  const [chosen, setChosen] = React.useState(false);
  const [reduce, setReduce] = React.useState(false);
  const ref = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.45 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = visible && !held && !chosen && !reduce;
  React.useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % TABS.length), DWELL);
    return () => clearTimeout(t);
  }, [running, active]);

  const tab = TABS[active];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    setChosen(true);
    setActive((a) => (a + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length);
  };

  return (
    <section ref={ref} className="alv-showcase" id="features" aria-labelledby="alv-showcase-title">
      <div className="alv-col">
        <h2 id="alv-showcase-title" className="alv-h2 alv-showcase-title">From a question<br />to finished work.</h2>
        <div className="alv-showcase-tabs" role="tablist" aria-label="Capabilities" onKeyDown={onKey}>
          {TABS.map((t, i) => (
            <button key={t.key} type="button" role="tab" id={`alv-tab-${t.key}`} aria-selected={active === i} aria-controls="alv-showcase-panel" tabIndex={active === i ? 0 : -1}
              className="alv-showcase-tab" onClick={() => { setChosen(true); setActive(i); }}>
              {t.label}
              <span className="alv-showcase-meter" aria-hidden>
                <i key={`${active}-${running}`} data-run={active === i && running ? "" : undefined} data-full={active === i && !running ? "" : undefined} style={{ animationDuration: `${DWELL}ms` }} />
              </span>
            </button>
          ))}
        </div>
        <div className="alv-showcase-copy" aria-live="polite">
          <h3 key={tab.key} className="alv-h3 alv-swap">{tab.title}</h3>
          <p key={`${tab.key}-b`} className="alv-lede alv-swap">{tab.body(modelsFloor, totalLabs)}</p>
        </div>
        <div id="alv-showcase-panel" role="tabpanel" aria-labelledby={`alv-tab-${tab.key}`} className="alv-showcase-stage"
          onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
          {TABS.map((t, i) => (
            <div key={t.key} className="alv-showcase-scene" data-on={active === i || undefined} aria-hidden={active !== i}>
              {i === 0 ? <ModelsScene labs={labs} on={active === 0 && visible} /> : i === 1 ? <ResearchScene on={active === 1 && visible} /> : <FolioScene on={active === 2 && visible} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
