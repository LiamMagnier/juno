"use client";

import * as React from "react";
import { Copy, FolderOpen, Mic, MoreHorizontal, Pencil, Pin, Plus, Search, Trash2, X } from "@/components/ui/icons";
import { Token } from "./composer";
import { Face } from "./face";
import { CREW, MIRA, PRESENCE_LABEL, PRESENCE_ORDER } from "./fixtures";
import { Key, Lens, Wordmark } from "./lens";

/*
 * The component sheet: every part in every state, the type ramp, and the
 * colour ramp with contrast ratios COMPUTED from the rendered colour (a 1px
 * canvas reads back what the browser painted), against the panel and the
 * chassis, so the numbers are the page's, not a spreadsheet's.
 */

function Spec({ cap, children }: { cap: string; children: React.ReactNode }) {
  return (
    <div className="in-spec">
      <div className="flex min-h-9 items-center">{children}</div>
      <span className="in-spec__cap">{cap}</span>
    </div>
  );
}

function Section({ title, line, children }: { title: string; line?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {line ? <p>{line}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/* ---------- Contrast ---------- */

function toRgb(css: string, ctx: CanvasRenderingContext2D): [number, number, number, number] {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}
function lum([r, g, b]: [number, number, number, number]) {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function over(fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
function ratio(a: [number, number, number, number], b: [number, number, number, number]) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function hex([r, g, b]: [number, number, number, number]) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const RAMP: { token: string; name: string; role: string; text?: boolean }[] = [
  { token: "--in-chassis", name: "Chassis", role: "Sidebar and page" },
  { token: "--in-panel", name: "Panel", role: "The display: where work is" },
  { token: "--in-raised", name: "Raised", role: "The composer" },
  { token: "--in-well", name: "Well", role: "Quotes, diff headers" },
  { token: "--in-lens", name: "Lens", role: "Juno's window; always ink" },
  { token: "--in-edge", name: "Edge", role: "Field and switch outlines (3:1)" },
  { token: "--in-ink", name: "Ink", role: "Text, primary", text: true },
  { token: "--in-ink-2", name: "Ink 2", role: "Secondary text, icons", text: true },
  { token: "--in-ink-3", name: "Ink 3", role: "Meta, labels, placeholders", text: true },
  { token: "--in-signal", name: "Signal", role: "Juno and the primary action only" },
  { token: "--in-amber", name: "Amber", role: "Needs you, as a word", text: true },
  { token: "--in-danger", name: "Danger", role: "Destructive words only", text: true },
];

function ColourRamp() {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = React.useState<{ hex: string; panel: number; chassis: number; lens?: number }[]>([]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const cs = getComputedStyle(el);
    const read = (t: string) => toRgb(cs.getPropertyValue(t).trim(), ctx);
    const panel = read("--in-panel");
    const chassis = read("--in-chassis");
    const lens = read("--in-lens");
    setRows(
      RAMP.map((r) => {
        const c = over(read(r.token), panel);
        return { hex: hex(c), panel: ratio(c, panel), chassis: ratio(over(read(r.token), chassis), chassis), lens: r.token === "--in-signal" ? ratio(c, lens) : undefined };
      }),
    );
  }, []);
  return (
    <div ref={ref} className="grid grid-cols-4 gap-x-5 gap-y-6">
      {RAMP.map((r, i) => (
        <div key={r.token}>
          <div className="in-swatch" style={{ background: `var(${r.token})` }} />
          <p className="mt-2 flex items-baseline justify-between gap-2">
            <span className="in-fs-135 font-medium">{r.name}</span>
            <span className="in-mono in-fs-115 in-ink-3">{rows[i]?.hex ?? ""}</span>
          </p>
          <p className="in-t-small in-ink-3">{r.role}</p>
          {rows[i] ? (
            <p className="in-mono mt-1 in-fs-115 in-ink-2">
              {rows[i].panel.toFixed(2)}:1 panel · {rows[i].chassis.toFixed(2)}:1 chassis
              {rows[i].lens ? ` · ${rows[i].lens!.toFixed(2)}:1 on lens` : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ---------- Sheet ---------- */

const STATES = ["default", "hover", "press", "focus"] as const;

export function SystemScene() {
  return (
    <div className="in-panel !m-0 !rounded-none !shadow-none" style={{ minHeight: "100dvh" }}>
      <div className="in-sheet">
        <header className="pb-10">
          <Wordmark />
          <h1 className="in-t-display mt-6">Instrument</h1>
          <p className="mt-3 max-w-[62ch] in-fs-155 leading-[25px] in-ink-2">
            Juno as a precise instrument with one light in it. Graphite and hairlines carry everything; a condensed mono engraves the numbers; one chartreuse signal is kept for Juno itself and the action that sends.
          </p>
        </header>

        <Section title="Signature: the lens" line="A dark window with one lit needle. It rests at 45°, weighs while Juno thinks, ticks while it works, follows the voice, and settles when work ends. It is also the send key: with a draft, the needle swings to twelve and becomes the arrow.">
          <div className="grid grid-cols-6 gap-6">
            <Spec cap="16 · rest"><Lens size={16} /></Spec>
            <Spec cap="20 · wordmark"><Lens size={20} /></Spec>
            <Spec cap="32 · rest"><Lens size={32} /></Spec>
            <Spec cap="48 · detailed"><Lens size={48} /></Spec>
            <Spec cap="Key, empty"><Key armed={false} /></Spec>
            <Spec cap="Key, armed"><Key armed /></Spec>
            <Spec cap="Thinking"><Lens size={32} state="thinking" /></Spec>
            <Spec cap="Working"><Lens size={32} state="working" /></Spec>
            <Spec cap="Listening, level 0.6"><Lens size={32} state="listening" level={0.6} /></Spec>
            <Spec cap="Settle (one-shot)"><Lens size={32} state="settle" /></Spec>
            <div data-rm="" className="contents">
              <Spec cap="Thinking, reduced motion"><Lens size={32} state="thinking" /></Spec>
              <Spec cap="Working, reduced motion"><Lens size={32} state="working" /></Spec>
            </div>
          </div>
        </Section>

        <Section title="Type" line="TikTok Sans with optical size, at two weights (400, 500). Noto Sans Mono at 87.5 width engraves times, paths, counts and keys, and nothing else.">
          <div className="flex flex-col gap-4">
            {[
              { cls: "in-t-display", spec: "Display 38/44 · 400 · −2.4%", text: "Good afternoon, Liam" },
              { cls: "in-t-title", spec: "Title 22/28 · 500 · −1.4%", text: "Crew" },
              { cls: "in-t-heading", spec: "Heading 17/24 · 500", text: "Renewal risk this quarter" },
              { cls: "in-t-read", spec: "Reading 15.5/25 · 400 · 68ch", text: "Stripe shows €412,000 of the €438,000 the forecast expects from renewals." },
              { cls: "in-t-ui", spec: "Interface 13.5/20 · 400", text: "Match Stripe customers to accounts" },
              { cls: "in-t-small", spec: "Small 12.5/18 · 400", text: "Edited 2h ago" },
              { cls: "in-t-label", spec: "Label 11.5/16 · 500", text: "Recent" },
              { cls: "in-mono in-fs-115 leading-4", spec: "Mono 11.5/16 · wdth 87.5 · tabular", text: "src/lib/billing/renewals.ts:118  €23,600  10:42" },
            ].map((t) => (
              <div key={t.spec} className="grid grid-cols-[220px_1fr] items-baseline gap-6">
                <span className="in-mono in-fs-115 in-ink-3">{t.spec}</span>
                <span className={t.cls}>{t.text}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Colour" line="At least 95% of any screen is neutral. The signal appears in at most two places per screen; amber is a word, never a fill. Ratios are measured from the rendered colours.">
          <ColourRamp />
        </Section>

        <Section title="Buttons" line="Hover and press are tonal steps; nothing moves. The solid button is ink, not the signal: the signal belongs to the key alone.">
          <div className="grid grid-cols-[120px_repeat(6,minmax(0,1fr))] items-center gap-x-4 gap-y-5">
            <span />
            {["Default", "Hover", "Pressed", "Focus", "Disabled", "Loading"].map((s) => (
              <span key={s} className="in-t-label">{s}</span>
            ))}
            {(["solid", "secondary", "ghost", "danger"] as const).map((v) => (
              <React.Fragment key={v}>
                <span className="in-t-small in-ink-3">{v === "solid" ? "Solid" : v === "secondary" ? "Secondary" : v === "ghost" ? "Ghost" : "Destructive"}</span>
                {STATES.map((st) => (
                  <span key={st}>
                    <button type="button" className="in-btn" data-variant={v} data-force={st === "default" ? undefined : st}>
                      {v === "danger" ? "Delete" : v === "solid" ? "Allow once" : v === "secondary" ? "Deny" : "Cancel"}
                    </button>
                  </span>
                ))}
                <span>
                  <button type="button" className="in-btn" data-variant={v} disabled>
                    {v === "danger" ? "Delete" : v === "solid" ? "Allow once" : v === "secondary" ? "Deny" : "Cancel"}
                  </button>
                </span>
                <span>
                  <button type="button" className="in-btn" data-variant={v} aria-busy="true">
                    <Lens size={14} state="working" />
                    Working
                  </button>
                </span>
              </React.Fragment>
            ))}
            <span className="in-t-small in-ink-3">Key</span>
            {STATES.map((st) => (
              <span key={st}>
                <span className="in-keybtn" data-force={st === "default" ? undefined : st} tabIndex={-1}>
                  <Key armed />
                </span>
              </span>
            ))}
            <span>
              <span className="in-keybtn">
                <Key armed={false} />
              </span>
            </span>
            <span className="in-t-small in-ink-3">Empty is the lens</span>
          </div>
        </Section>

        <Section title="Icon buttons, switch, segmented, tabs">
          <div className="flex flex-wrap items-start gap-10">
            <div className="flex gap-3">
              {(["default", "hover", "press", "focus"] as const).map((st) => (
                <Spec key={st} cap={st === "default" ? "Default" : st === "hover" ? "Hover" : st === "press" ? "Pressed" : "Focus"}>
                  <button type="button" className="in-iconbtn" data-force={st === "default" ? undefined : st} aria-label="Dictate">
                    <Mic size={18} motion="none" />
                  </button>
                </Spec>
              ))}
              <Spec cap="On">
                <button type="button" className="in-iconbtn" aria-pressed="true" aria-label="Pinned">
                  <Pin size={18} motion="none" />
                </button>
              </Spec>
              <Spec cap="Disabled">
                <button type="button" className="in-iconbtn" disabled aria-label="Add">
                  <Plus size={18} motion="none" />
                </button>
              </Spec>
            </div>
            <div className="flex gap-4">
              <Spec cap="Off"><button type="button" role="switch" aria-checked="false" className="in-switch" aria-label="Web search" /></Spec>
              <Spec cap="On"><button type="button" role="switch" aria-checked="true" className="in-switch" aria-label="Memory" /></Spec>
              <Spec cap="Disabled"><button type="button" role="switch" aria-checked="true" className="in-switch" disabled aria-label="Locked" /></Spec>
            </div>
            <Spec cap="Segmented">
              <div className="in-seg w-[240px]">
                <button type="button" className="in-seg__item" aria-pressed="false">Ask</button>
                <button type="button" className="in-seg__item" aria-pressed="false">Plan</button>
                <button type="button" className="in-seg__item" aria-pressed="true">Code</button>
              </div>
            </Spec>
            <Spec cap="Tabs">
              <div className="in-tabs w-[260px]" role="tablist">
                <button type="button" role="tab" aria-selected="true" className="in-tab">Changes</button>
                <button type="button" role="tab" aria-selected="false" className="in-tab">Preview</button>
                <button type="button" role="tab" aria-selected="false" className="in-tab">Terminal</button>
              </div>
            </Spec>
          </div>
        </Section>

        <Section title="Field" line="Label above, help or error below. The outline is the 3:1 edge; focus adds a soft ring and a darker edge.">
          <div className="grid grid-cols-4 gap-6">
            {(["default", "focus", "error", "disabled"] as const).map((st) => (
              <label key={st} className="flex flex-col gap-1.5">
                <span className="in-fs-13 font-medium">Channel</span>
                <span className="in-field" data-focus={st === "focus" ? "" : undefined} data-error={st === "error" ? "" : undefined} data-disabled={st === "disabled" ? "" : undefined}>
                  <Search size={14} motion="none" className="in-ink-3" />
                  <span className={st === "default" || st === "disabled" ? "in-ink-3" : undefined}>{st === "default" ? "Search channels" : st === "disabled" ? "#design" : st === "error" ? "#desing" : "#design"}</span>
                  {st === "focus" ? <span className="in-caret" /> : null}
                </span>
                <span className="in-t-small" style={{ color: st === "error" ? "var(--in-danger)" : "var(--in-ink-3)" }}>
                  {st === "error" ? "No channel called #desing. Did you mean #design?" : st === "disabled" ? "Set by your workspace" : "Juno posts here after you allow it"}
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Sidebar rows and chips" line="Rows are one line and 30px; the only trailing word is amber and only when someone needs you.">
          <div className="grid grid-cols-[260px_1fr] gap-10">
            <div className="flex flex-col gap-px in-r-12 p-2" style={{ background: "var(--in-chassis)" }}>
              <button type="button" className="in-row"><span className="in-row__icon"><FolderOpen size={16} motion="none" /></span><span className="in-row__label">Default</span></button>
              <button type="button" className="in-row" data-force="hover"><span className="in-row__icon"><FolderOpen size={16} motion="none" /></span><span className="in-row__label">Hover</span><span className="in-row__hint in-kbd in-mono !opacity-100">⌘K</span></button>
              <button type="button" className="in-row" data-selected=""><span className="in-row__icon"><FolderOpen size={16} motion="none" /></span><span className="in-row__label">Selected</span></button>
              <button type="button" className="in-row"><span className="in-row__icon"><Face face={MIRA.face} presence="waiting" size={18} live={false} /></span><span className="in-row__label">Mira</span><span className="in-row__trail in-amber">Needs you</span></button>
              <button type="button" className="in-row" data-dim=""><span className="in-row__icon"><Face face={CREW[4].face} presence="paused" size={18} live={false} /></span><span className="in-row__label">Ines</span></button>
            </div>
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                <button type="button" className="in-chip"><Face face={MIRA.face} presence="waiting" size={16} live={false} />Answer Mira on Halvorsen</button>
                <button type="button" className="in-chip" data-force="hover"><Pencil size={15} motion="none" />Hover</button>
                <button type="button" className="in-chip" data-force="press"><Pencil size={15} motion="none" />Pressed</button>
              </div>
              <p className="in-fs-16 leading-[30px]">
                Tokens: <Token id="q3-forecast" /> <Token id="stripe" /> <Token id="mira" /> <Token id="atlas" /> <Token id="chat-q3" />
              </p>
              <p className="in-fs-16 leading-[30px]">
                Needs connecting: <Token id="slack" /> Selected: <Token id="linear" selected /> In a sent message: <Token id="mira" size="sm" />
              </p>
            </div>
          </div>
        </Section>

        <Section title="Menu, dialog, toast">
          <div className="flex flex-wrap items-start gap-10">
            <div className="in-float in-menu w-[240px]" role="menu">
              <button type="button" role="menuitem" className="in-mrow"><Pencil size={15} motion="none" className="in-ink-3" /><span className="in-mrow__main">Rename</span><span className="in-mono in-fs-11 in-ink-3">R</span></button>
              <button type="button" role="menuitem" className="in-mrow" data-active=""><Pin size={15} motion="none" className="in-ink-3" /><span className="in-mrow__main">Pin</span><span className="in-mono in-fs-11 in-ink-3">P</span></button>
              <button type="button" role="menuitem" className="in-mrow"><FolderOpen size={15} motion="none" className="in-ink-3" /><span className="in-mrow__main">Move to project</span></button>
              <button type="button" role="menuitem" className="in-mrow"><Copy size={15} motion="none" className="in-ink-3" /><span className="in-mrow__main">Copy link</span></button>
              <div className="in-menu__sep" />
              <button type="button" role="menuitem" className="in-mrow" style={{ color: "var(--in-danger)" }}><Trash2 size={15} motion="none" /><span className="in-mrow__main">Delete</span></button>
            </div>
            <div className="relative grid h-[250px] w-[520px] place-items-center overflow-hidden in-r-12" style={{ background: "var(--in-scrim)" }}>
              <div className="in-dialog" role="dialog" aria-label="Delete this chat">
                <div className="px-5 pb-4 pt-5">
                  <p className="in-fs-15 font-medium leading-[22px]">Delete this chat?</p>
                  <p className="mt-1.5 in-t-ui in-ink-2">“Q3 forecast against Stripe revenue” and its files go. Tasks started in it stop.</p>
                </div>
                <div className="flex justify-end gap-2 px-5 pb-5">
                  <button type="button" className="in-btn" data-variant="secondary">Cancel</button>
                  <button type="button" className="in-btn" data-variant="danger">Delete</button>
                </div>
              </div>
            </div>
            <div className="in-toast" role="status">
              Posted to #design
              <button type="button" className="in-btn" data-variant="ghost" data-size="sm">Undo</button>
              <button type="button" className="in-iconbtn" data-size="sm" aria-label="Dismiss" style={{ color: "inherit" }}><X size={14} motion="none" /></button>
            </div>
          </div>
        </Section>

        <Section title="Empty state and skeleton" line="An empty place says what will fill it and offers the one action. Loading is still blocks in the final layout; nothing shimmers.">
          <div className="grid grid-cols-2 gap-10">
            <div className="grid place-items-center in-r-12 py-12" style={{ boxShadow: "inset 0 0 0 1px var(--in-hairline)" }}>
              <div className="flex max-w-[320px] flex-col items-center text-center">
                <Lens size={32} />
                <p className="mt-4 in-fs-15 font-medium">Nothing in your Library yet</p>
                <p className="mt-1 in-t-ui in-ink-3">Files you add and things Juno makes land here, grouped by project.</p>
                <button type="button" className="in-btn mt-4" data-variant="secondary"><Plus size={14} motion="none" />Add a file</button>
              </div>
            </div>
            <div className="flex flex-col gap-3 in-r-12 p-6" style={{ boxShadow: "inset 0 0 0 1px var(--in-hairline)" }} aria-busy="true" aria-label="Loading">
              <span className="in-skel ml-auto h-10 w-[60%] in-r-14" />
              <span className="in-skel mt-4 h-5 w-[40%]" />
              <span className="in-skel h-4 w-[92%]" />
              <span className="in-skel h-4 w-[86%]" />
              <span className="in-skel h-4 w-[64%]" />
            </div>
          </div>
        </Section>

        <Section title="Crew faces" line="The face is the state indicator: pose carries the state, motion happens only on events (appearing, a change, your pointer). State is always also words.">
          <div className="flex flex-wrap gap-10">
            {PRESENCE_ORDER.map((p, i) => (
              <div key={p} className="flex flex-col items-center gap-2">
                <Face face={CREW[i].face} presence={p} size={48} name={CREW[i].name} />
                <span className={p === "waiting" ? "in-t-small in-amber" : "in-t-small in-ink-2"}>{PRESENCE_LABEL[p]}</span>
              </div>
            ))}
            <div className="flex flex-col items-center gap-2">
              <span className="inline-grid size-12 place-items-center"><MoreHorizontal size={18} motion="none" className="in-ink-3" /></span>
              <span className="in-t-small in-ink-3">Sizes 16 to 48</span>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
