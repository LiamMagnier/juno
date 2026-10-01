"use client";

import * as React from "react";
import { AlevrLogo, BRAND_STANDIN, CodeGlyph, ContinuumMark, HANDOFF, ORBIT_ARCS, OrbitGlyph, ThinkingMark, type ThinkingState } from "./brand";
import { CONTINUUM_H, CONTINUUM_W } from "./brand-geometry";
import { Icon } from "./icons";

/*
 * The Alevr identity, shown in the real system (scene=brand). Not a board: the
 * mark, the lockups and the thinking states are the live components, and the
 * three products are the actual scenes, framed and scaled. The mathematical
 * and cosmic meaning stays where the brand puts it: in the logo's open paths,
 * the Orbit glyph and one measured orbital construction on Orbit's charcoal
 * panel. Everything else is the quiet V3 foundation.
 */

type Scheme = "light" | "dark";

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="jn-sys__section jn-brand__section" id={id} aria-labelledby={`${id}-h`}>
      <div className="jn-sys__side">
        <h2 id={`${id}-h`} className="jn-sys__h">
          {title}
        </h2>
        {note ? <p className="jn-sys__note">{note}</p> : null}
      </div>
      <div className="jn-sys__body">{children}</div>
    </section>
  );
}

/** A subtree pinned to one appearance: the tokens resolve against its colour scheme. */
function Themed({ scheme, className, children, label }: { scheme: Scheme; className?: string; children: React.ReactNode; label?: string }) {
  return (
    <div className={className ? `jn-brand__themed ${className}` : "jn-brand__themed"} data-scheme={scheme} aria-label={label}>
      {children}
    </div>
  );
}

/* ———————————————————————————— The mark ———————————————————————————— */

function MarkTiles() {
  return (
    <div className="jn-brand__pair">
      {(["light", "dark"] as const).map((s) => (
        <Themed key={s} scheme={s} className="jn-brand__tile jn-brand__tile--mark" label={`The Continuum, ${s}`}>
          <ContinuumMark size={232} optical={false} className="jn-brand__bigmark" />
          <span className="jn-brand__tilecap">{s === "light" ? "Graphite on the light ground" : "Pale neutral on the dark ground"}</span>
        </Themed>
      ))}
    </div>
  );
}

/** Clear space: one broad path width around the mark, drawn in the presence ink as hairlines. */
function ClearSpace() {
  const w = 220;
  const h = (w * CONTINUUM_H) / CONTINUUM_W;
  const pad = w * 0.17;
  return (
    <div className="jn-brand__clear">
      <div className="jn-brand__clearbox" style={{ width: w + pad * 2, height: h + pad * 2 }}>
        <svg width={w + pad * 2} height={h + pad * 2} viewBox={`0 0 ${w + pad * 2} ${h + pad * 2}`} aria-hidden="true" className="jn-brand__clearsvg">
          <rect x={0.5} y={0.5} width={w + pad * 2 - 1} height={h + pad * 2 - 1} className="jn-brand__cl" />
          <rect x={pad + 0.5} y={pad + 0.5} width={w - 1} height={h - 1} className="jn-brand__cl jn-brand__cl--in" />
          <line x1={0} y1={pad / 2} x2={pad} y2={pad / 2} className="jn-brand__cl jn-brand__cl--in" />
          <text x={pad / 2} y={pad / 2 - 5} className="jn-brand__cltext" textAnchor="middle">
            x
          </text>
        </svg>
        <span className="jn-brand__clearmark" style={{ left: pad, top: pad }}>
          <ContinuumMark size={w} optical={false} />
        </span>
      </div>
      <p className="jn-brand__tilecap">Clear space: one broad path width (x) on every side.</p>
    </div>
  );
}

const OPTICAL = [16, 20, 24, 32, 48];

function OpticalSizes() {
  return (
    <div className="jn-brand__pair">
      {(["light", "dark"] as const).map((s) => (
        <Themed key={s} scheme={s} className="jn-brand__tile jn-brand__tile--sizes">
          <div className="jn-brand__sizes">
            {OPTICAL.map((px) => (
              <figure key={px} className="jn-brand__size">
                <span className="jn-brand__sizebox">
                  <ContinuumMark size={px} />
                </span>
                <figcaption className="num">{px}</figcaption>
              </figure>
            ))}
          </div>
          <span className="jn-brand__tilecap">Optical masters: below 48 px the open channels widen so they stay visible.</span>
        </Themed>
      ))}
    </div>
  );
}

/* ———————————————————————————— Lockups and icon ———————————————————————————— */

function Lockups() {
  return (
    <div className="jn-brand__pair">
      {(["light", "dark"] as const).map((s) => (
        <Themed key={s} scheme={s} className="jn-brand__tile jn-brand__tile--lockups">
          <div className="jn-brand__lockups">
            <AlevrLogo size={40} />
            <AlevrLogo size={19} />
            <div className="jn-brand__products">
              <AlevrLogo size={17} product="Chat" />
              <AlevrLogo size={17} product="Orbit" />
              <AlevrLogo size={17} product="Code" />
            </div>
            <div className="jn-brand__navglyphs" aria-label="Navigation, with the product glyphs">
              <span className="jn-brand__navglyph">
                <Icon name="chat" size={16} />
                Chat
              </span>
              <span className="jn-brand__navglyph">
                <OrbitGlyph size={16} />
                Orbit
              </span>
              <span className="jn-brand__navglyph">
                <CodeGlyph size={16} />
                Code
              </span>
            </div>
          </div>
        </Themed>
      ))}
    </div>
  );
}

function AppIcons() {
  return (
    <div className="jn-brand__icons">
      <figure className="jn-brand__appicon" data-tone="charcoal">
        <span className="jn-brand__squircle">
          <ContinuumMark size={118} />
        </span>
        <figcaption>App icon, charcoal (shared master)</figcaption>
      </figure>
      <figure className="jn-brand__appicon" data-tone="light">
        <span className="jn-brand__squircle">
          <ContinuumMark size={118} />
        </span>
        <figcaption>Light alternate</figcaption>
      </figure>
      <figure className="jn-brand__favicons">
        <span className="jn-brand__favrow">
          <span className="jn-brand__fav" data-size="32">
            <ContinuumMark size={28} />
          </span>
          <span className="jn-brand__fav" data-size="16">
            <ContinuumMark size={16} />
          </span>
        </span>
        <span className="jn-brand__tab">
          <ContinuumMark size={16} />
          <span>Alevr</span>
          <Icon name="close" size={16} />
        </span>
        <figcaption>Favicon 32 and 16, and in a tab</figcaption>
      </figure>
    </div>
  );
}

/* ———————————————————————————— The products ———————————————————————————— */

/** An actual scene, framed at 1440 × 900 and scaled to its column. */
function Screen({ q, label }: { q: string; label: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [k, setK] = React.useState(0.4);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setK(Math.round((e.contentRect.width / 1440) * 10000) / 10000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="jn-brand__screen">
      <iframe title={label} src={`/dev/design/juno?${q}&still=1`} width={1440} height={900} loading="eager" tabIndex={-1} style={{ transform: `scale(${k})` }} />
    </div>
  );
}

/**
 * Orbit's one cosmic moment: the Continuum inside a measured ellipse, the
 * Orbit glyph's two separated arcs drawn at full size, and the construction
 * that makes them (a = 1, b = 0.618, so e = 0.786; the foci at a·e). Charcoal
 * in both themes, as the brand assigns it. No stars, no planet, nothing turns.
 */
export function OrbitConstruction() {
  const W = 640;
  const H = 400;
  const cx = W / 2;
  const cy = H / 2 - 18;
  const rx = 200;
  const ry = rx * 0.618;
  const rot = -22;
  const c = rx * 0.786;
  const s = rx / 9.5;
  const mark = 150;
  return (
    <figure className="jn-brand__orbit" aria-label="Alevr Orbit: the Continuum inside the Orbit ellipse, with its construction">
      <svg viewBox={`0 0 ${W} ${H}`} className="jn-brand__orbitsvg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g transform={`translate(${cx} ${cy}) rotate(${rot})`} className="jn-brand__constr">
          <circle r={rx} />
          <line x1={-rx - 26} y1={0} x2={rx + 26} y2={0} />
          <line x1={0} y1={-ry - 26} x2={0} y2={ry + 26} />
          <ellipse rx={rx} ry={ry} className="jn-brand__constr--ghost" />
          {[-c, c].map((x) => (
            <g key={x} transform={`translate(${x} 0)`}>
              <line x1={-4} y1={0} x2={4} y2={0} className="jn-brand__constr--focus" />
              <line x1={0} y1={-4} x2={0} y2={4} className="jn-brand__constr--focus" />
            </g>
          ))}
        </g>
        <g transform={`translate(${cx - 12 * s} ${cy - 12 * s}) scale(${s})`} className="jn-brand__arcs">
          {ORBIT_ARCS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
      <span className="jn-brand__orbitmark" style={{ left: `${((cx - mark / 2) / W) * 100}%`, top: `${((cy - (mark * CONTINUUM_H) / CONTINUUM_W / 2) / H) * 100}%`, width: `${(mark / W) * 100}%` }}>
        <ContinuumMark size={mark} optical={false} />
      </span>
      <figcaption className="jn-brand__orbitcap">
        <span className="jn-brand__orbitlock">
          <AlevrLogo size={22} product="Orbit" label={false} />
          <span className="jn-brand__orbitdesc">Your agents</span>
        </span>
        <span className="jn-brand__orbitmath mono">
          <span>a = 1, b = 0.618, e = 0.786</span>
          <span>two arcs of one ellipse</span>
        </span>
      </figcaption>
    </figure>
  );
}

function Products() {
  return (
    <div className="jn-brand__productgrid">
      <article className="jn-brand__prod" aria-labelledby="bp-chat">
        <header className="jn-brand__prodhead">
          <h3 id="bp-chat" className="jn-brand__prodtitle">
            <Icon name="chat" size={20} />
            Chat
          </h3>
          <p className="jn-brand__prodline">The quietest expression: the serif greeting, a centred composer with no shadow, context named in the sentence.</p>
        </header>
        <div className="jn-brand__screens">
          <Screen q="scene=home&theme=light" label="Alevr Chat, home, light" />
          <Screen q="scene=thread&theme=dark" label="Alevr Chat, a thread, dark" />
        </div>
      </article>
      <article className="jn-brand__prod" aria-labelledby="bp-orbit">
        <header className="jn-brand__prodhead">
          <h3 id="bp-orbit" className="jn-brand__prodtitle">
            <OrbitGlyph size={20} />
            Orbit
          </h3>
          <p className="jn-brand__prodline">The expressive one, and still restrained: the cosmos lives in the logo, the glyph and this one construction. The work itself is a conversation with a named agent.</p>
        </header>
        <div className="jn-brand__screens jn-brand__screens--orbit">
          <OrbitConstruction />
          <Screen q="scene=crew&member=mira&theme=light" label="Alevr Orbit, an agent’s thread, light" />
        </div>
      </article>
      <article className="jn-brand__prod" aria-labelledby="bp-code">
        <header className="jn-brand__prodhead">
          <h3 id="bp-code" className="jn-brand__prodtitle">
            <CodeGlyph size={20} />
            Code
          </h3>
          <p className="jn-brand__prodline">Precise: denser rows, mono for paths and counts, the diff as the panel’s second pane, and the same thinking mark beside what is running.</p>
        </header>
        <div className="jn-brand__screens">
          <Screen q="scene=code&state=start&theme=light" label="Alevr Code, start, light" />
          <Screen q="scene=code&theme=dark" label="Alevr Code, a working session, dark" />
        </div>
      </article>
    </div>
  );
}

/* ———————————————————————————— Thinking ———————————————————————————— */

const ROWS: { words: string; state: ThinkingState; note: string; secs?: number }[] = [
  { words: "Thinking", state: "active", note: "Only while the model is actually reasoning." },
  { words: "Reading Q3 Forecast.xlsx", state: "active", note: "A tool says its real phase." },
  { words: "Searching Stripe subscriptions", state: "active", note: "A new phase asks for one more pass.", secs: 4 },
  { words: "Running Python, 2 of 3 cells", state: "active", note: "Counts are real or absent." },
  { words: "Waiting for your answer", state: "waiting", note: "Still. The words carry it." },
  { words: "Finished, read 3 sources", state: "done", note: "Settles once, then yields to the result." },
  { words: "Couldn’t reach Stripe. Try again", state: "error", note: "Still, with the way forward." },
];

function ThinkingRows({ run, events }: { run: number; events: number }) {
  return (
    <ul className="jn-brand__think">
      {ROWS.map((r, i) => (
        <li key={r.words} className="jn-brand__thinkrow">
          <span className="jn-live" data-state={r.state}>
            <span className="jn-live__glyph" aria-hidden="true">
              <ThinkingMark key={`${run}-${i}`} size={20} state={r.state} pulse={r.state === "active" ? events : 0} />
            </span>
            <span className={r.state === "error" ? "jn-live__text jn-brand__err" : r.state === "waiting" ? "jn-live__text jn-attn" : "jn-live__text"}>{r.words}</span>
            {r.secs ? <span className="jn-live__secs num">{r.secs}s</span> : null}
          </span>
          <span className="jn-brand__thinknote">{r.note}</span>
        </li>
      ))}
    </ul>
  );
}

function Thinking() {
  const [run, setRun] = React.useState(0);
  const [events, setEvents] = React.useState(0);
  return (
    <div className="jn-brand__thinking">
      <div className="jn-brand__thinkbar">
        <button type="button" className="jb jb--secondary jb--sm jicon-trigger" data-replay="" onClick={() => setRun((r) => r + 1)}>
          <Icon name="retry" size={16} />
          Start again
        </button>
        <button type="button" className="jb jb--secondary jb--sm" data-event="" onClick={() => setEvents((e) => e + 1)}>
          A new event
        </button>
        <span className="jn-brand__thinkspec num">
          Tone {HANDOFF.tone} ms, stagger {HANDOFF.stagger} ms, one pass per real event, at most one every {HANDOFF.coalesce / 1000} s
        </span>
      </div>
      <div className="jn-brand__pair">
        {(["light", "dark"] as const).map((s) => (
          <Themed key={s} scheme={s} className="jn-brand__tile jn-brand__tile--think">
            <ThinkingRows run={run} events={events} />
          </Themed>
        ))}
      </div>
      <div className="jn-brand__pair">
        {(["light", "dark"] as const).map((s) => (
          <Themed key={s} scheme={s} className="jn-brand__tile jn-brand__tile--bigthink">
            <ThinkingMark key={run} size={176} pulse={events} className="jn-brand__bigthink" />
            <span className="jn-brand__tilecap">The handoff, large: the silhouette never moves; a tone passes clockwise from the top path and rests on the last.</span>
          </Themed>
        ))}
      </div>
    </div>
  );
}

/* ———————————————————————————— Words ———————————————————————————— */

const WORDS: [string, string][] = [
  ["Alevr", "The product. Pronounced AL-ver. Never AleVR."],
  ["Chat", "Navigation. Alevr Chat in explanatory copy."],
  ["Orbit", "Navigation. Your agents is the descriptor; one is an agent, called by its own name. Never crew, never an Orbit."],
  ["Code", "Navigation. Alevr Code at its entry point."],
  ["Create agent", "Never Add to crew or Hire."],
  ["Folio", "What Alevr made (D-038): the Library filter Folios and Open folio. Sentences still name the real type: a deck, a document, a site."],
  ["Deep Field", "Deep research, always with its descriptor and always two words. Quick lookups stay Search."],
  ["Memory, Library, Projects, Skills, Routines", "Plain words: places you trust and controls you count on."],
  ["Ready, Thinking, Working, Needs your answer, Blocked, Finished", "An agent’s states, always in words. Never Free."],
  ["Go further.", "The signature line, for identity moments only."],
];

function Words() {
  return (
    <dl className="jn-brand__words">
      {WORDS.map(([w, d]) => (
        <div key={w} className="jn-brand__word">
          <dt>{w}</dt>
          <dd>{d}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ———————————————————————————— Type ———————————————————————————— */

function Type() {
  return (
    <div className="jn-brand__type">
      <div className="jn-brand__typerow">
        <span className="jn-brand__spec jn-alevr" style={{ fontSize: 48 }}>
          Alevr
        </span>
        <span className="jn-brand__typecap">Wordmark: Newsreader 600, upright, optical kerning</span>
      </div>
      <div className="jn-brand__typerow">
        <span className="jn-brand__spec t-greet">Go further.</span>
        <span className="jn-brand__typecap">Display: Newsreader 400</span>
      </div>
      <div className="jn-brand__typerow">
        <span className="jn-brand__spec jn-brand__ui">Mira is checking renewal usage for three accounts</span>
        <span className="jn-brand__typecap">Interface: Inter 400 and 500</span>
      </div>
      <div className="jn-brand__typerow">
        <span className="jn-brand__spec mono">fix/sync-cursor-lease +14 −4</span>
        <span className="jn-brand__typecap">Code and values: JetBrains Mono</span>
      </div>
    </div>
  );
}

/* ———————————————————————————— The page ———————————————————————————— */

export function BrandScene() {
  return (
    <main className="jn-sys jn-brand">
      <header className="jn-brand__hero">
        <AlevrLogo size={56} className="jn-brand__herologo" />
        <p className="jn-brand__signature">Go further.</p>
        <p className="jn-brand__lede">
          Conversation. Agents. Code. Alevr (AL-ver) takes its name from aleph and the infinite cardinalities: understanding that keeps opening, carried into work. The meaning lives in the mark; the product stays calm.
        </p>
        {BRAND_STANDIN ? (
          <p className="jn-brand__standin">
            <Icon name="info" size={16} />
            Stand-in geometry: the Continuum here is traced from the selected raster. The production mark from src/components/brand replaces it everywhere at once.
          </p>
        ) : null}
      </header>

      <Section id="mark" title="Continuum" note="Broad folded paths around an open aperture, their ends pointed: understanding becoming action. Uniform graphite on light, pale neutral on dark. It never rotates and never glows.">
        <MarkTiles />
        <div className="jn-brand__row2">
          <ClearSpace />
          <OpticalSizes />
        </div>
      </Section>

      <Section id="lockups" title="Lockups" note="The mark and Alevr together are the application lockup. A product word joins it only where it explains (an entry point, onboarding); navigation says Chat, Orbit and Code with their glyphs.">
        <Lockups />
        <AppIcons />
      </Section>

      <Section id="products" title="Three products" note="One foundation, three characters. These are the real scenes, framed and scaled, in both themes.">
        <Products />
      </Section>

      <Section id="thinking" title="Thinking" note="The Continuum beside the truthful phase words: a stationary tonal handoff through its paths on each real event, a quiet held tone while work is live, stillness when it waits, settles or fails. Static under reduced motion.">
        <Thinking />
      </Section>

      <Section id="type" title="Type" note="The V3 foundation, unchanged: Newsreader for the wordmark and the moments that speak, Inter for everything you operate, JetBrains Mono for code and values.">
        <Type />
      </Section>

      <Section id="words" title="Words" note="Plain verbs and the product’s own names. Third-party names and technical identifiers stay as they are.">
        <Words />
      </Section>
    </main>
  );
}
