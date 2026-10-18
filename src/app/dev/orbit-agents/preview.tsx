"use client";

/**
 * PROPOSAL (dev only): the Orbit agents motion preview. Hover a character, press
 * it, switch states; 3D portraits at large sizes, flat 2D icons at 48 px and
 * under. `?demo=1` cycles the states on its own (for recordings).
 */
import * as React from "react";
import { setFaceMotionSlots, FACE_MOTION_SLOTS } from "@/components/agents/face-motion-slot";
import { DURATION, EASING, SPRING, TIMING_TOKENS } from "@/lib/design/tokens.generated";
import { OrbitIcon, ORBIT_STATES, type OrbitState } from "./orbit-icon";
import { OrbitPortrait } from "./orbit-portrait";
import "./orbit-motion.css";

export const CAST: { id: string; name: string; meaning: string; job: string }[] = [
  { id: "mira", name: "Mira", meaning: "the variable star Mira", job: "Renewals" },
  { id: "otto", name: "Tyco", meaning: "after Tycho Brahe", job: "Finance ops" },
  { id: "bram", name: "Ada", meaning: "after Ada Lovelace", job: "Release notes" },
  { id: "dew", name: "Io", meaning: "a moon of Jupiter", job: "Data" },
  { id: "rhea", name: "Lyra", meaning: "the lyre constellation", job: "Support" },
  { id: "ori", name: "Elli", meaning: "the ellipse of the Orbit glyph", job: "Orchestration" },
  { id: "vanta", name: "Umbra", meaning: "the darkest part of a shadow", job: "Deep research" },
  { id: "sato", name: "Cass", meaning: "after Cassini, of Saturn's rings", job: "Planning" },
  { id: "luna", name: "Lune", meaning: "a crescent figure in geometry", job: "Overnight runs" },
  { id: "kip", name: "Hale", meaning: "after the comet Hale-Bopp", job: "Quick tasks" },
  { id: "vela", name: "Vela", meaning: "the Vela pulsar", job: "Monitoring" },
  { id: "sputnik", name: "Echo", meaning: "after the Echo satellites", job: "Integrations" },
];
const NAME = Object.fromEntries(CAST.map((c) => [c.id, c]));

const SWATCHES: [string, string][] = [
  ["Alevr blue", "#1f3fd9"], ["Tomato", "#ff5a3c"], ["Tangerine", "#ff8a1f"], ["Sunflower", "#ffd21f"], ["Chartreuse", "#b4e02a"],
  ["Emerald", "#1fc48d"], ["Aqua", "#1cc4d8"], ["Violet", "#7d5cff"], ["Bubblegum", "#ff8cc6"], ["Graphite", "#2b2c31"],
];
const CUSTOM = [
  { title: "Alevr blue · badge · dots", color: 0, acc: "Badge", eyes: "Dots" },
  { title: "Tomato · no accessory · pills", color: 1, acc: "None", eyes: "Pills" },
  { title: "Emerald · headphones · pills", color: 5, acc: "Headphones", eyes: "Pills" },
  { title: "Sunflower · glasses · dots", color: 3, acc: "Glasses", eyes: "Dots" },
  { title: "Violet · nightcap · happy", color: 7, acc: "Nightcap", eyes: "Happy" },
  { title: "Aqua · orbit ring · stickers", color: 6, acc: "Orbit ring", eyes: "Stickers" },
];
const ACCESSORIES = ["None", "Badge", "Cap", "Glasses", "Headphones", "Nightcap", "Beanie", "Orbit ring"];
const EYES = ["Dots", "Pills", "Stickers", "Happy"];

function tokenVars(): React.CSSProperties {
  const bez = (k: keyof typeof EASING) => `cubic-bezier(${EASING[k].join(",")})`;
  return {
    "--sp-standard": SPRING.standard.linear,
    "--sp-standard-dur": `${SPRING.standard.settleMs}ms`,
    "--sp-reward": SPRING.reward.linear,
    "--sp-reward-dur": `${SPRING.reward.settleMs}ms`,
    "--sp-snap": SPRING.snap.linear,
    "--sp-snap-dur": `${SPRING.snap.settleMs}ms`,
    "--dur-press": `${DURATION.press}ms`,
    "--dur-base": `${DURATION.base}ms`,
    "--dur-slow": `${DURATION.slow}ms`,
    "--dur-emphasis": `${DURATION.emphasis}ms`,
    "--loop-default": `${TIMING_TOKENS.loop.default}ms`,
    "--loop-beat": `${TIMING_TOKENS.loop.beat}ms`,
    "--loop-calm": `${TIMING_TOKENS.loop.calm}ms`,
    "--ease-breathe": bez("breathe"),
    "--ease-in-out": bez("inOut"),
    "--ease-out-soft": bez("outSoft"),
  } as React.CSSProperties;
}

const ROWS: [string, OrbitState, string][] = [
  ["mira", "waiting", "Needs your answer"],
  ["otto", "working", "Reconciling March invoices"],
  ["ori", "thinking", "Thinking"],
  ["luna", "paused", "Paused until 9:00"],
  ["rhea", "finished", "Finished · 3 replies drafted"],
];
const TREE: [string, OrbitState, string, string, number][] = [
  ["ori", "thinking", "Lead", "Planning the change", 0],
  ["bram", "working", "Builder 1", "Editing src/cart/total.ts", 1],
  ["kip", "working", "Builder 2", "Running pnpm test", 1],
  ["dew", "paused", "Explorer", "Paused", 2],
  ["vela", "waiting", "Verifier", "Needs you", 1],
  ["sato", "finished", "Reviewer", "Done", 1],
];

export function OrbitMotionPreview({ base, demo = false }: { base: string; demo?: boolean }) {
  const [state, setState] = React.useState<OrbitState>("ready");
  const [rm, setRm] = React.useState(false);
  const [cap, setCap] = React.useState(12);
  const [custom, setCustom] = React.useState(0);
  React.useEffect(() => setFaceMotionSlots(cap), [cap]);
  React.useEffect(() => {
    if (!demo) return;
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % ORBIT_STATES.length;
      setState(ORBIT_STATES[i]!.id);
    }, 3200);
    return () => clearInterval(t);
  }, [demo]);
  const label = ORBIT_STATES.find((s) => s.id === state)!.label;

  return (
    <div className="orbit-motion om" style={tokenVars()} data-rm={rm || undefined}>
      <style>{CSS}</style>
      <header className="om-head">
        <div>
          <h1>Orbit agents · motion</h1>
          <p>Hover a character (its eyes follow you; it leans in), press it (squish), switch states. 3D portraits are Blender renders; at 48 px and under the flat 2D icons take over.</p>
        </div>
        <div className="om-controls" role="toolbar" aria-label="State">
          {ORBIT_STATES.map((s) => (
            <button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>
              {s.label}
            </button>
          ))}
          <label className="om-tog">
            <input type="checkbox" checked={rm} onChange={(e) => setRm(e.target.checked)} /> Reduce motion
          </label>
          <label className="om-tog">
            <input type="checkbox" checked={cap === FACE_MOTION_SLOTS} onChange={(e) => setCap(e.target.checked ? FACE_MOTION_SLOTS : 12)} /> Product cap ({FACE_MOTION_SLOTS} moving)
          </label>
        </div>
      </header>

      <section className="om-stage">
        <div className="om-hero">
          <OrbitPortrait id="mira" state={state} size={300} base={base} sequenced reducedMotion={rm} />
          <div className="om-words">
            <span className="om-name">Mira</span>
            <span className={state === "waiting" || state === "blocked" ? "om-state need" : "om-state"}>{label}</span>
          </div>
        </div>
        <div className="om-flat">
          <div className="om-cap">The same character, flat 2D</div>
          <div className="om-flatrow">
            <OrbitIcon id="mira" state={state} size={96} />
            <OrbitIcon id="mira" state={state} size={48} />
            <OrbitIcon id="mira" state={state} size={28} />
            <OrbitIcon id="mira" state={state} size={20} />
            <span className="om-dark">
              <OrbitIcon id="mira" state={state} size={28} />
              <OrbitIcon id="mira" state={state} size={20} />
            </span>
          </div>
          <div className="om-cap">Every state, 2D at 48 px</div>
          <div className="om-flatrow">
            {ORBIT_STATES.map((s) => (
              <figure key={s.id}>
                <OrbitIcon id="mira" state={s.id} size={48} />
                <figcaption>{s.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <h2>Mira · every state in 3D (a still of each loop; words always beside the face)</h2>
      <section className="om-states">
        {ORBIT_STATES.map((s) => (
          <figure key={s.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${base}/mira_${s.id}.png`} width={132} height={132} alt={`Mira, ${s.label}`} />
            <figcaption>{s.label}</figcaption>
          </figure>
        ))}
      </section>

      <h2>The twelve · 3D at 140 px, 2D at 48 and 20 px · {label}</h2>
      <section className="om-grid">
        {CAST.map((c) => (
          <figure key={c.id}>
            <OrbitPortrait id={c.id} state={state} size={140} base={base} sequenced={false} reducedMotion={rm} />
            <div className="om-pair">
              <OrbitIcon id={c.id} state={state} size={48} />
              <OrbitIcon id={c.id} state={state} size={20} />
            </div>
            <figcaption>
              {c.name}
              <span>{c.meaning}</span>
            </figcaption>
          </figure>
        ))}
      </section>

      <h2>Make it yours</h2>
      <section className="om-edit">
        <div className="om-editprev">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${base}/mira_custom${custom}.png`} width={220} height={220} alt="" />
          <div className="om-pair">
            <OrbitIcon id={`mira_custom${custom}`} state="ready" size={48} />
            <OrbitIcon id={`mira_custom${custom}`} state="ready" size={28} />
            <OrbitIcon id={`mira_custom${custom}`} state="ready" size={20} />
          </div>
        </div>
        <div className="om-editside">
          <div className="om-cap">Colour</div>
          <div className="om-swatches">
            {SWATCHES.map(([n, hex], i) => (
              <button key={n} type="button" title={n} aria-label={n} aria-pressed={CUSTOM[custom]!.color === i} style={{ background: hex }} onClick={() => { const k = CUSTOM.findIndex((c) => c.color === i); if (k >= 0) setCustom(k); }} />
            ))}
          </div>
          <div className="om-cap">Accessory</div>
          <div className="om-chips">
            {ACCESSORIES.map((a) => (
              <button key={a} type="button" aria-pressed={CUSTOM[custom]!.acc === a} onClick={() => { const k = CUSTOM.findIndex((c) => c.acc === a); if (k >= 0) setCustom(k); }}>{a}</button>
            ))}
          </div>
          <div className="om-cap">Eyes</div>
          <div className="om-chips">
            {EYES.map((a) => (
              <button key={a} type="button" aria-pressed={CUSTOM[custom]!.eyes === a} onClick={() => { const k = CUSTOM.findIndex((c) => c.eyes === a); if (k >= 0) setCustom(k); }}>{a}</button>
            ))}
          </div>
          <div className="om-combos">
            {CUSTOM.map((c, i) => (
              <button key={c.title} type="button" aria-pressed={custom === i} onClick={() => setCustom(i)} title={c.title}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${base}/mira_custom${i}.png`} width={84} height={84} alt={c.title} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <h2>In the product · flat 2D icons</h2>
      <section className="om-panes">
        {[false, true].map((dark) => (
          <div key={String(dark)} className={dark ? "om-pane dark" : "om-pane"}>
            {ROWS.map(([id, st, words], i) => (
              <div key={id} className={i === 0 ? "om-li sel" : "om-li"}>
                <OrbitIcon id={id} state={st} size={28} />
                <span className="who">
                  <span className="nm">{NAME[id]!.name}</span>
                  <span className="job">{NAME[id]!.job}</span>
                </span>
                <span className={st === "waiting" ? "st need" : "st"}>{words}</span>
              </div>
            ))}
            <div className="om-note">Agent list · 28 px</div>
            <div className="om-tree">
              {TREE.map(([id, st, n, words, d]) => (
                <div key={n} className={`om-li d${d}`}>
                  <OrbitIcon id={id} state={st} size={20} />
                  <span className="nm">{n}</span>
                  <span className={st === "waiting" ? "st need" : "st"}>{words}</span>
                </div>
              ))}
            </div>
            <div className="om-note">Code agents tree · 20 px</div>
          </div>
        ))}
      </section>
    </div>
  );
}

const CSS = `
.om{font:14px/1.4 "Inter",-apple-system,system-ui,sans-serif;color:#16151b;background:#f4f3f0;padding:28px 36px 40px;min-height:100vh;box-sizing:border-box}
.om h1{font:500 30px/1.1 "Iowan Old Style",Georgia,serif;margin:0 0 4px}
.om p{margin:0;color:#5d5a66;max-width:640px}
.om h2{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6a6774;margin:26px 0 10px}
.om-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;flex-wrap:wrap}
.om-controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:620px}
.om-controls button,.om-chips button{font:inherit;font-size:13px;border:1px solid #dcd8cf;background:#fff;border-radius:999px;padding:5px 11px;cursor:pointer}
.om-controls button[aria-pressed=true],.om-chips button[aria-pressed=true]{background:#16151b;color:#fff;border-color:#16151b}
.om-tog{font-size:12.5px;color:#5d5a66;display:flex;gap:5px;align-items:center;margin-left:6px}
.om-stage{display:flex;gap:40px;align-items:center;margin-top:18px;background:#fff;border-radius:18px;padding:18px 28px}
.om-hero{display:flex;flex-direction:column;align-items:center}
.om-words{display:flex;flex-direction:column;align-items:center;margin-top:-6px}
.om-name{font:500 22px/1.2 "Iowan Old Style",Georgia,serif}
.om-state{color:#76737f}.om-state.need{color:#b5530f;font-weight:500}
.om-flat{display:flex;flex-direction:column;gap:8px}
.om-cap{font-size:12px;color:#7a7784}
.om-flatrow{display:flex;gap:18px;align-items:flex-end}
.om-flatrow figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px}
.om-flatrow figcaption{font-size:11.5px;color:#7a7784}
.om-dark{display:flex;gap:12px;align-items:center;background:#1b1a1f;border-radius:10px;padding:8px 10px}
.om-states{display:flex;gap:6px;justify-content:space-between}
.om-states figure{margin:0;display:flex;flex-direction:column;align-items:center}
.om-states figcaption{font-size:12.5px;margin-top:-4px}
.om-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px 8px}
.om-grid figure{margin:0;display:flex;flex-direction:column;align-items:center}
.om-grid figcaption{font-size:13px;text-align:center}
.om-grid figcaption span{display:block;color:#7a7784;font-size:11.5px;font-style:italic}
.om-pair{display:flex;gap:10px;align-items:flex-end;margin:2px 0 4px}
.om-edit{display:flex;gap:28px;background:#fff;border-radius:18px;padding:16px 24px;align-items:center}
.om-editprev{display:flex;flex-direction:column;align-items:center}
.om-editside{display:flex;flex-direction:column;gap:7px}
.om-swatches{display:flex;gap:8px}
.om-swatches button{width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #dcd8cf;cursor:pointer}
.om-swatches button[aria-pressed=true]{box-shadow:0 0 0 2px #16151b}
.om-chips{display:flex;gap:6px;flex-wrap:wrap}
.om-combos{display:flex;gap:6px;margin-top:6px}
.om-combos button{border:1px solid #e7e4dd;background:#f8f7f4;border-radius:12px;padding:0;cursor:pointer}
.om-combos button[aria-pressed=true]{border-color:#16151b}
.om-panes{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.om-pane{border-radius:16px;padding:14px;background:#fff;border:1px solid #e7e4dd}
.om-pane.dark{background:#1b1a1f;border-color:#2a2930;color:#ecebef}
.om-li{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px}
.om-li.sel{background:#f0eee9}.dark .om-li.sel{background:#26252b}
.om-li .who{display:flex;flex-direction:column;line-height:1.2}
.om-li .nm{font-weight:500}.om-li .job{font-size:11.5px;color:#8a8794}
.om-li .st{color:#76737f;margin-left:auto;font-size:12.5px}.dark .om-li .st{color:#9a98a3}
.om-li .st.need{color:#b5530f;font-weight:500}.dark .om-li .st.need{color:#f2a15c}
.om-tree{margin-top:10px}.om-tree .om-li{padding:4px 8px;font-size:13px}.om-tree .d1{padding-left:30px}.om-tree .d2{padding-left:52px}
.om-note{color:#7a7784;font-size:12px;margin-top:8px}
.om img{mix-blend-mode:normal}
`;
