"use client";

import * as React from "react";
import { ArrowUp, BookOpen, FolderInput, Pencil, Pin, Plus, Search, Share2, Trash2, X } from "@/components/ui/icons";
import { Face } from "./face";
import { CREW, MIRA, PRESENCE_LABEL, PRESENCE_ORDER } from "./fixtures";
import { Orbit, Wordmark } from "./glyphs";
import { TOK, Token } from "./composer";

/*
 * The component sheet: every part in every state, the type ramp, the colour
 * ramp with contrast computed from the live tokens, the signature and its
 * reduced-motion form, radius and depth. Light and dark side by side where
 * the difference matters.
 */

function Sec({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`pc-sheet-sec ${className ?? ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Cap({ children }: { children: React.ReactNode }) {
  return <p className="pc-small pc-quiet mt-2">{children}</p>;
}

/* ---------- contrast, computed from the rendered tokens ---------- */
function parseRgb(c: string): [number, number, number] | null {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r / 255, g / 255, b / 255];
  }
  const s = c.match(/color\(srgb ([^)]+)\)/);
  if (s) {
    const [r, g, b] = s[1].split(/\s+/).map(Number);
    return [r, g, b];
  }
  return null;
}
function lum([r, g, b]: [number, number, number]) {
  const f = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: [number, number, number], b: [number, number, number]) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SWATCHES: { v: string; role: string; text?: boolean }[] = [
  { v: "--pc-canvas", role: "Canvas" },
  { v: "--pc-sidebar", role: "Sidebar, a whisper darker" },
  { v: "--pc-surface", role: "Composer, cards" },
  { v: "--pc-well", role: "Bubble, insets" },
  { v: "--pc-ink", role: "Ink: text, primary actions", text: true },
  { v: "--pc-ink-2", role: "Secondary text", text: true },
  { v: "--pc-ink-3", role: "Labels, meta", text: true },
  { v: "--pc-ink-4", role: "Icons at rest (3:1)", text: true },
  { v: "--pc-sig", role: "Celadon: Juno only", text: true },
  { v: "--pc-amber", role: "Needs you", text: true },
  { v: "--pc-danger", role: "Destructive", text: true },
];

function Swatch({ v, role, text }: { v: string; role: string; text?: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = React.useState<{ hex: string; canvas: string; surface: string } | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (name: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      el.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return parseRgb(c);
    };
    const me = read(v);
    const canvas = read("--pc-canvas");
    const surface = read("--pc-surface");
    if (!me || !canvas || !surface) return;
    const hex = "#" + me.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
    setInfo({ hex, canvas: ratio(me, canvas).toFixed(2), surface: ratio(me, surface).toFixed(2) });
  }, [v]);
  return (
    <div ref={ref} className="min-w-0">
      <div className="pc-swatch" style={{ background: `var(${v})` }} />
      <p className="pc-small mt-2 truncate">{role}</p>
      <p className="pc-small pc-quiet">
        <span className="pc-mono !text-[12px]">{info?.hex ?? v}</span>
        {text && info ? (
          <>
            {"  "}
            <span className="pc-mono !text-[12px]">
              {info.canvas}:1 / {info.surface}:1
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function Palette({ theme }: { theme: "light" | "dark" }) {
  return (
    <div className="pc rounded-card p-5" data-theme={theme} style={{ minHeight: 0 }}>
      <p className="pc-small pc-quiet mb-3">
        {theme === "light" ? "Light" : "Dark"}. Contrast is against canvas / surface, read from the rendered tokens.
      </p>
      <div className="grid grid-cols-4 gap-x-4 gap-y-5">
        {SWATCHES.map((s) => (
          <Swatch key={s.v} {...s} />
        ))}
      </div>
    </div>
  );
}

/* ---------- the sheet ---------- */
const BTN_STATES = [
  { label: "Default", force: undefined },
  { label: "Hover", force: "hover" },
  { label: "Pressed", force: "press" },
  { label: "Focus", force: "focus" },
] as const;

export function SystemScene() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-12 pb-24 pt-14">
      <header className="flex items-end justify-between gap-8 pb-10">
        <div>
          <Wordmark />
          <h1 className="pc-greet mt-8">Porcelain</h1>
          <p className="pc-read pc-muted mt-3 max-w-[60ch]">
            A cool porcelain body, graphite ink, and one celadon glaze that appears only where Juno itself is present: the orbit&apos;s dot,
            the caret and the focus ring.
          </p>
        </div>
      </header>

      <Sec title="Type: Wix Madefor Display and Text, two weights">
        <div className="grid gap-5">
          {[
            { cls: "pc-greet", sample: "Good afternoon, Liam", spec: "Display 40 / 1.12, 400, -0.026em. Greeting only." },
            { cls: "pc-title", sample: "Crew", spec: "Display 26 / 1.2, 400, -0.02em. Page titles." },
            { cls: "pc-h", sample: "Renewal risk this quarter", spec: "Text 18 / 1.4, 500. Headings in answers." },
            { cls: "pc-read", sample: "Stripe shows €412,000 of the €438,000 the forecast expects from renewals.", spec: "Text 16 / 1.625, 400. Reading, 68ch measure." },
            { cls: "pc-ui", sample: "Customize, Library, New chat", spec: "Text 14 / 1.4, 400. Interface." },
            { cls: "pc-small pc-muted", sample: "Step 2 of 4: matching Stripe customers", spec: "Text 13 / 1.4, 400. Meta and captions." },
            { cls: "pc-micro pc-quiet", sample: "Recent", spec: "Text 12 / 1.3, 500. Section labels, sentence case." },
            { cls: "pc-mono", sample: "npm test -- renewals", spec: "JetBrains Mono 12.5 / 20, ligatures off. Code only." },
          ].map((r) => (
            <div key={r.spec} className="grid grid-cols-[1fr_340px] items-baseline gap-8">
              <p className={r.cls}>{r.sample}</p>
              <p className="pc-small pc-quiet">{r.spec}</p>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_340px] items-baseline gap-8">
            <p className="pc-read">Добрый день, Лиам. Chào buổi chiều, Liam.</p>
            <p className="pc-small pc-quiet">Cyrillic and Vietnamese from the same cuts.</p>
          </div>
        </div>
      </Sec>

      <Sec title="Colour: at least 95% neutral">
        <div className="grid grid-cols-2 gap-4">
          <Palette theme="light" />
          <Palette theme="dark" />
        </div>
      </Sec>

      <div className="grid grid-cols-2 gap-x-12">
        <Sec title="Buttons">
          <div className="grid grid-cols-[88px_repeat(4,1fr)] items-center gap-x-3 gap-y-3">
            <span />
            {BTN_STATES.map((s) => (
              <span key={s.label} className="pc-small pc-quiet">
                {s.label}
              </span>
            ))}
            {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
              <React.Fragment key={v}>
                <span className="pc-small pc-quiet capitalize">{v}</span>
                {BTN_STATES.map((s) => (
                  <span key={s.label}>
                    <button type="button" className={`pc-btn pc-btn--${v}`} data-force={s.force}>
                      {v === "danger" ? "Delete" : v === "primary" ? "Allow once" : v === "secondary" ? "Deny" : "Cancel"}
                    </button>
                  </span>
                ))}
              </React.Fragment>
            ))}
            <span className="pc-small pc-quiet">Disabled</span>
            <span>
              <button type="button" className="pc-btn pc-btn--primary" disabled>
                Commit
              </button>
            </span>
            <span className="pc-small pc-quiet">Loading</span>
            <span className="col-span-2">
              <button type="button" className="pc-btn pc-btn--secondary" aria-busy="true">
                <Orbit state="thinking" size={14} className="pc-orbit--line" />
                Connecting
              </button>
            </span>
          </div>
          <Cap>Hover and press are tonal steps; nothing moves. Focus is a 2px celadon ring, offset 2px.</Cap>
          <div className="mt-6 flex items-center gap-2">
            {BTN_STATES.map((s) => (
              <button key={s.label} type="button" className="pc-icon-btn" data-force={s.force} aria-label={`Share, ${s.label}`}>
                <Share2 />
              </button>
            ))}
            <button type="button" className="pc-icon-btn" disabled aria-label="Share, disabled">
              <Share2 />
            </button>
            <span className="w-4" />
            <button type="button" className="pc-send" aria-label="Send">
              <ArrowUp />
            </button>
            <button type="button" className="pc-send" data-force="hover" aria-label="Send, hover">
              <ArrowUp />
            </button>
          </div>
          <Cap>Icon buttons 32px (44px on touch). The send disc is the one filled object in the composer.</Cap>
        </Sec>

        <Sec title="Field, switch, segmented, tabs">
          <div className="grid grid-cols-3 gap-4">
            <div className="pc-field">
              <label>Name</label>
              <div className="pc-input">Mira</div>
              <span className="pc-help">Shown in the sidebar</span>
            </div>
            <div className="pc-field">
              <label>Channel</label>
              <div className="pc-input" data-force="focus">
                #design
                <span className="pc-caret" />
              </div>
              <span className="pc-help">Focus</span>
            </div>
            <div className="pc-field">
              <label>Budget</label>
              <div className="pc-input" data-error>
                €-40
              </div>
              <span className="pc-error">Enter an amount above zero</span>
            </div>
          </div>
          <div className="mt-6 flex items-center gap-6">
            <span className="flex items-center gap-2">
              <span className="pc-switch" role="switch" aria-checked="false" aria-label="Memory off" />
              <span className="pc-small">Off</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="pc-switch" role="switch" aria-checked="true" aria-label="Memory on" />
              <span className="pc-small">On</span>
            </span>
            <div className="pc-seg" role="radiogroup" aria-label="Effort">
              {["Light", "Standard", "Deep"].map((e) => (
                <button key={e} type="button" aria-pressed={e === "Standard"}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="pc-tabs mt-6 !px-0" role="tablist">
            {["Diff", "Files", "Terminal", "Tests"].map((t) => (
              <button key={t} type="button" role="tab" className="pc-tab" aria-selected={t === "Diff"}>
                {t}
              </button>
            ))}
          </div>
          <Cap>The switch track and thumb hold 3:1 against the canvas in both states.</Cap>
        </Sec>
      </div>

      <div className="grid grid-cols-2 gap-x-12">
        <Sec title="Sidebar rows">
          <div className="pc-side !h-auto !static w-[264px] rounded-card py-2">
            <a className="pc-row" href="#">
              <BookOpen />
              <span className="pc-row__label">Library</span>
            </a>
            <a className="pc-row" href="#" data-force="hover">
              <Search />
              <span className="pc-row__label">Search</span>
              <span className="pc-row__hint !opacity-100">⌘K</span>
            </a>
            <a className="pc-row pc-row--recent" href="#" aria-current="page">
              <span className="pc-row__label">Q3 forecast against Stripe revenue</span>
            </a>
            <a className="pc-row" href="#">
              <Face avatar={MIRA.avatar} presence="waiting" size={20} />
              <span className="pc-row__label">Mira</span>
              <span className="pc-needs">Needs you</span>
            </a>
            <a className="pc-row" href="#">
              <Face avatar={CREW[2].avatar} presence="working" size={20} />
              <span className="pc-row__label">Otto</span>
            </a>
            <a className="pc-row" href="#" data-force="focus">
              <span className="pc-row__label pc-muted">Pricing page copy, second pass</span>
            </a>
          </div>
          <Cap>Default, hover, current, crew with attention, crew working, keyboard focus. 32px, single line.</Cap>
        </Sec>

        <Sec title="Chips and context tokens">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="pc-chip">
              <Face avatar={MIRA.avatar} presence="waiting" size={18} />
              Answer Mira on Halvorsen
            </button>
            <button type="button" className="pc-chip" data-force="hover">
              <Plus />
              Hover
            </button>
          </div>
          <div className="pc-read mt-5 leading-[34px]">
            <Token tok={TOK.forecast} /> <Token tok={TOK.notes} /> <Token tok={TOK.stripe} /> <Token tok={TOK.slack} /> <Token tok={TOK.mira} />{" "}
            <Token tok={TOK.atlas} /> <Token tok={TOK.hubspot} /> <Token tok={TOK.stripe} open />
          </div>
          <Cap>
            A token carries the thing&apos;s own mark and ink text. File, app, crew member, project; an app that needs connecting is an outline
            that says so; open is a hairline.
          </Cap>
        </Sec>
      </div>

      <div className="grid grid-cols-3 gap-x-10">
        <Sec title="Menu">
          <div className="pc-pop !static w-[232px]" role="menu">
            {[
              { i: <Pencil />, t: "Rename" },
              { i: <Pin />, t: "Pin" },
              { i: <Share2 />, t: "Share" },
              { i: <FolderInput />, t: "Move to project" },
            ].map((r, k) => (
              <div key={r.t} className="pc-opt" role="menuitem" data-active={k === 1 ? "" : undefined}>
                {r.i}
                {r.t}
              </div>
            ))}
            <div className="pc-pop__sep" />
            <div className="pc-opt !text-[color:var(--pc-danger)]" role="menuitem">
              <Trash2 />
              Delete
            </div>
          </div>
        </Sec>
        <Sec title="Dialog">
          <div className="pc-dialog">
            <p className="pc-ui-m">Delete this chat?</p>
            <p className="pc-small pc-muted mt-1.5">&ldquo;Q3 forecast against Stripe revenue&rdquo; and its files will be removed. This can&apos;t be undone.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="pc-btn pc-btn--secondary">
                Cancel
              </button>
              <button type="button" className="pc-btn pc-btn--danger">
                Delete
              </button>
            </div>
          </div>
        </Sec>
        <Sec title="Toast">
          <div className="pc-toast">
            Posted to #design
            <button type="button" className="pc-btn pc-btn--ghost !h-8">
              Undo
            </button>
            <button type="button" className="pc-icon-btn pc-icon-btn--sm !text-[color:var(--pc-on-ink)]" aria-label="Dismiss">
              <X />
            </button>
          </div>
          <Cap>Bottom centre, 4 seconds, one at a time.</Cap>
        </Sec>
      </div>

      <div className="grid grid-cols-2 gap-x-12">
        <Sec title="Empty state and skeleton">
          <div className="grid grid-cols-2 gap-6">
            <div className="pc-card flex flex-col items-center px-6 py-8 text-center">
              <Orbit size={28} />
              <p className="pc-ui-m mt-4">Nothing in your Library yet</p>
              <p className="pc-small pc-muted mt-1.5 max-w-[28ch]">Documents, sheets and decks Juno makes for you will land here.</p>
              <button type="button" className="pc-btn pc-btn--secondary mt-4">
                <Plus />
                Add a file
              </button>
            </div>
            <div className="pc-card grid content-start gap-3 p-6" aria-busy="true" aria-label="Loading">
              <div className="pc-skel h-4 w-2/3" />
              <div className="pc-skel h-3 w-full" />
              <div className="pc-skel h-3 w-11/12" />
              <div className="pc-skel h-3 w-4/5" />
              <div className="pc-skel mt-3 h-24 w-full !rounded-control" />
            </div>
          </div>
        </Sec>

        <Sec title="The signature: the orbit">
          <div className="flex items-end gap-6">
            {[16, 20, 32, 48].map((s) => (
              <span key={s} className="flex flex-col items-center gap-2">
                <Orbit size={s} />
                <span className="pc-small pc-quiet">{s}</span>
              </span>
            ))}
            <span className="flex flex-col items-center gap-2">
              <span className="pc-send">
                <Orbit size={20} state="listening" />
              </span>
              <span className="pc-small pc-quiet">On ink</span>
            </span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3">
            <span className="pc-thinking">
              <Orbit state="thinking" size={16} className="pc-orbit--line" />
              Thinking
            </span>
            <span className="pc-thinking">
              <Orbit state="thinking" size={16} still className="pc-orbit--line" />
              Thinking, reduced motion
            </span>
            <span className="pc-thinking">
              <Orbit state="listening" size={16} className="pc-orbit--line" />
              Listening
            </span>
            <span className="pc-thinking">
              <Orbit state="speaking" size={16} still className="pc-orbit--line" />
              Speaking, reduced motion
            </span>
          </div>
          <Cap>
            The dot is Juno. At rest it sits at the upper right and the path stops short of it. Thinking, it makes one orbit, rests a beat and
            goes again. Reduced motion holds a distinct pose (the dot at the bottom) and the words say the state.
          </Cap>
        </Sec>
      </div>

      <Sec title="Crew presence: the face is the state, the words say it too">
        <div className="flex flex-wrap gap-8">
          {PRESENCE_ORDER.map((p, i) => (
            <span key={p} className="flex flex-col items-center gap-3">
              <Face avatar={CREW[i].avatar} presence={p} size={44} />
              <span className={p === "waiting" ? "pc-needs !text-[13px]" : "pc-small pc-muted"}>{PRESENCE_LABEL[p]}</span>
            </span>
          ))}
        </div>
        <Cap>Blink on arrival and on hover; a settle on every change; two small lifts when a wait begins, then stillness. No idle loops.</Cap>
      </Sec>

      <div className="grid grid-cols-2 gap-x-12">
        <Sec title="Radius">
          <div className="flex flex-wrap items-end gap-4">
            {[
              { r: 6, n: "Keycap" },
              { r: 7, n: "Token" },
              { r: 8, n: "Row" },
              { r: 10, n: "Button" },
              { r: 14, n: "Menu" },
              { r: 16, n: "Card" },
              { r: 24, n: "Composer" },
            ].map((x) => (
              <span key={x.n} className="flex flex-col items-center gap-2">
                <span className="block size-12 bg-[color:var(--pc-well)]" style={{ borderRadius: x.r }} />
                <span className="pc-small pc-quiet">
                  {x.n} {x.r}
                </span>
              </span>
            ))}
          </div>
          <Cap>Nested shapes are concentric: a row inside a 14px menu with 6px padding is 8px.</Cap>
        </Sec>
        <Sec title="Depth">
          <div className="grid grid-cols-3 gap-4">
            <div className="pc-card grid h-20 place-items-center pc-small pc-muted">Flat, hairline</div>
            <div className="pc-composer grid h-20 place-items-center pc-small pc-muted">The composer</div>
            <div className="pc-pop !static grid h-20 place-items-center pc-small pc-muted">Floating layer</div>
          </div>
          <Cap>Flat by default. One elevated object per screen (the composer). Menus and popovers float.</Cap>
        </Sec>
      </div>

      <Sec title="Motion tokens">
        <div className="grid grid-cols-4 gap-4">
          {[
            { n: "Hover, press", d: "120ms", e: "ease (0.2, 0, 0, 1)" },
            { n: "Popover in", d: "140ms", e: "ease; out 100ms linear fade" },
            { n: "Panel from token", d: "180ms", e: "ease, origin at the token" },
            { n: "State change", d: "220ms", e: "ease" },
            { n: "Send: dock and rise", d: "360ms", e: "ease; shared element" },
            { n: "Token lands", d: "240ms", e: "ease; mark flies row to chip" },
            { n: "Thinking orbit", d: "1.7s", e: "in-out, rests 22%" },
            { n: "Stream run", d: "260ms", e: "opacity only" },
          ].map((m) => (
            <div key={m.n} className="pc-card p-4">
              <p className="pc-small">{m.n}</p>
              <p className="pc-ui-m mt-1">{m.d}</p>
              <p className="pc-small pc-quiet mt-0.5">{m.e}</p>
            </div>
          ))}
        </div>
      </Sec>

    </main>
  );
}
