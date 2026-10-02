"use client";

import * as React from "react";
import { Check, FileText, Telescope } from "@/components/ui/icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { ThinkingMark } from "@/components/brand/thinking-mark";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import type { Provider } from "@/lib/providers";

/**
 * Three chapters, one stage. The text scrolls normally; the stage beside it
 * stays put and changes scene as each chapter reaches the middle of the
 * viewport. On phones each chapter carries its own scene inline.
 */

export type Lab = { provider: Provider; label: string; model: string };

type Chapter = { key: string; title: string; body: string };

function ModelsScene({ labs, on }: { labs: Lab[]; on: boolean }) {
  const rows = labs.slice(0, 6);
  return (
    <div className="alv-scene-pad">
      <span className="alv-scene-label">Choose a model</span>
      <div className="alv-models">
        <div className="alv-model-row" data-active>
          <ContinuumMark size={18} />
          <span>Auto<br /><small>Picks a model for each message</small></span>
          <Check className="alv-check" aria-hidden />
        </div>
        {rows.map(({ provider, label, model }, i) => (
          <div key={provider} className="alv-model-row alv-pop" data-on={on || undefined} style={{ transitionDelay: `${120 + i * 55}ms` }}>
            <ProviderLogo provider={provider} className="size-[18px]" />
            <span>{model}<br /><small>{label}</small></span>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

const SOURCES = [
  { mark: "N", title: "Activation benchmarks for B2B software", site: "Industry report" },
  { mark: "H", title: "Why first sessions decide retention", site: "Research article" },
  { mark: "S", title: "Measuring time to value in onboarding", site: "Practitioner guide" },
  { mark: "P", title: "Templates versus blank states: a field study", site: "Conference paper" },
  { mark: "R", title: "What new users try in their first hour", site: "Product analytics study" },
];

function ResearchScene({ on }: { on: boolean }) {
  const [p, setP] = React.useState(0);
  React.useEffect(() => {
    if (!on) return;
    setP(0.08);
    const t = window.setTimeout(() => setP(0.64), 300);
    return () => clearTimeout(t);
  }, [on]);
  return (
    <div className="alv-scene-pad">
      <span className="alv-scene-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Telescope className="size-4" aria-hidden style={{ color: "var(--alv-presence)" }} />Deep Field
      </span>
      <p className="alv-h3" style={{ marginTop: 14, fontSize: 24 }}>How do the best teams measure onboarding?</p>
      <div className="alv-progress-line" style={{ ["--p" as string]: p }}><i /></div>
      <div className="alv-work" style={{ marginTop: 14 }}>
        <ThinkingMark phase={on ? "working" : "idle"} size={16} />
        <span>Reading 14 of 22 sources</span>
      </div>
      <div className="alv-sources">
        {SOURCES.map((s, i) => (
          <div key={s.title} className="alv-source alv-pop" data-on={on || undefined} style={{ transitionDelay: `${200 + i * 140}ms` }}>
            <span className="alv-favicon">{s.mark}</span>
            <span>{s.title}<br /><small>{s.site}</small></span>
            <small>{i + 1}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function FolioScene() {
  return (
    <div className="alv-scene-pad">
      <span className="alv-scene-label" style={{ display: "flex", alignItems: "center", gap: 8 }}><FileText className="size-4" aria-hidden />Folio</span>
      <div className="alv-doc">
        <div className="alv-doc-page">
          <h5>Onboarding brief</h5>
          <p>New accounts leave at the same moment in all three studies: the empty workspace right after sign-up. <mark>We will start every account from a template that matches the role chosen at sign-up</mark>, and ask for one real file in place of the tour.</p>
          <p>Success is time to a first finished task. Today the median is two days; the target for the next release is one session.</p>
          <p style={{ color: "var(--alv-sub)" }}>Open questions: which roles need their own template, and who owns the first-run copy.</p>
        </div>
        <div className="alv-doc-side">
          <span className="alv-scene-label" style={{ padding: "0 10px 8px" }}>Versions</span>
          <span className="alv-version" data-active>Version 3<small>Now</small></span>
          <span className="alv-version">Version 2<small>Edited by you</small></span>
          <span className="alv-version">Version 1<small>Drafted by Alevr</small></span>
        </div>
      </div>
    </div>
  );
}

export function Chapters({ labs, modelsFloor, totalLabs }: { labs: Lab[]; modelsFloor: number; totalLabs: number }) {
  const chapters: Chapter[] = [
    { key: "models", title: "The right model for every question.", body: `${modelsFloor}+ models from ${totalLabs} labs in one picker. Auto chooses for each message, or you pick exactly the one you want.` },
    { key: "research", title: "Research that reads the sources.", body: "Deep Field searches widely, reads what it finds and cites every claim, so you can check the work yourself." },
    { key: "folio", title: "Answers become finished documents.", body: "Briefs, diagrams, code and small apps open in Folio, with every version kept so you can compare, return and share." },
  ];
  const [active, setActive] = React.useState(0);
  const refs = React.useRef<(HTMLDivElement | null)[]>([]);
  React.useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(Number((e.target as HTMLElement).dataset.index))),
      { rootMargin: "-48% 0px -48% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const scene = (i: number, on: boolean) =>
    i === 0 ? <ModelsScene labs={labs} on={on} /> : i === 1 ? <ResearchScene on={on} /> : <FolioScene />;

  return (
    <section className="alv-chapters" id="features" aria-labelledby="alv-chapters-title">
      <div className="alv-col">
        <div className="alv-chapters-head">
          <h2 id="alv-chapters-title" className="alv-h2">From a question to finished work.</h2>
        </div>
        <div className="alv-chapters-grid">
          <div>
            {chapters.map((c, i) => (
              <div key={c.key} ref={(el) => { refs.current[i] = el; }} data-index={i} className="alv-chapter" data-dim={active !== i || undefined}>
                <h3 className="alv-h3">{c.title}</h3>
                <p className="alv-lede">{c.body}</p>
                <div className="alv-chapter-inline" aria-hidden>
                  <div className="alv-scene" data-on>{scene(i, true)}</div>
                </div>
              </div>
            ))}
          </div>
          <div aria-hidden>
            <div className="alv-chapter-stage">
              {chapters.map((c, i) => (
                <div key={c.key} className="alv-scene" data-on={active === i || undefined}>{scene(i, active === i)}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
