"use client";

import * as React from "react";
import {
  ArrowUp,
  AudioLines,
  BookOpen,
  Check,
  Folder,
  Mic,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  X,
} from "@/components/ui/icons";
import { CREW, MIRA, PRESENCE_LABEL, PRESENCE_ORDER } from "./fixtures";
import { Face } from "./face";
import { Point } from "./point";
import { TokenChip, AppPanel, Palette } from "./composer";
import { TOKENS } from "./fixtures";

/*
 * The component sheet: every piece at rest and in its states, the type ramp,
 * and the colour ramp with contrast computed from the same hex values the
 * tokens use (canvas.css). Forced states use `is-*` classes that restate the
 * real :hover / :active / :focus-visible rules.
 */

const LIGHT = { bg: "#ffffff", side: "#fafafa", surface2: "#f4f4f4", ink: "#121212", ink2: "#5c5c5c", ink3: "#737373", lineUi: "#8f8f8f", accent: "#3550b3", amber: "#9a5b00" };
const DARK = { bg: "#111111", side: "#0c0c0c", surface2: "#1c1c1c", ink: "#ededed", ink2: "#a3a3a3", ink3: "#8f8f8f", lineUi: "#6b6b6b", accent: "#4967c5", amber: "#f0b35b" };

function lin(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function lum(hex: string) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const RAMP: { name: string; role: string; key: keyof typeof LIGHT; on?: keyof typeof LIGHT; text?: string; min: number }[] = [
  { name: "Ink", role: "Text, primary buttons", key: "ink", min: 4.5 },
  { name: "Ink 2", role: "Secondary text", key: "ink2", min: 4.5 },
  { name: "Ink 3", role: "Labels, placeholders, meta", key: "ink3", min: 4.5 },
  { name: "Edge", role: "Field, switch, needs-connection edge", key: "lineUi", min: 3 },
  { name: "Accent", role: "Send only (white arrow on it)", key: "accent", text: "#ffffff", min: 4.5 },
  { name: "Amber", role: "Needs you, as words", key: "amber", min: 4.5 },
];

function Swatches({ t, label }: { t: typeof LIGHT; label: string }) {
  return (
    <div className="cv-sys__ramp">
      <p className="cv-sys__cap">{label}</p>
      {RAMP.map((r) => {
        const hex = t[r.key];
        const ratio = r.text ? contrast(r.text, hex) : contrast(hex, t.bg);
        const ok = ratio >= r.min;
        return (
          <div key={r.name} className="cv-sys__sw">
            <span className="cv-sys__chip" style={{ background: hex, boxShadow: "inset 0 0 0 1px rgb(127 127 127 / 0.25)" }} />
            <span className="cv-sys__swname">{r.name}</span>
            <span className="cv-sys__swhex">{hex}</span>
            <span className="cv-sys__swrole">{r.role}</span>
            <span className="cv-sys__ratio num">
              {ratio.toFixed(2)}:1 {r.text ? "white on it" : `on ${t.bg}`} {ok ? "" : "below target"}
            </span>
          </div>
        );
      })}
      <div className="cv-sys__sw">
        <span className="cv-sys__chip" style={{ background: t.bg, boxShadow: "inset 0 0 0 1px rgb(127 127 127 / 0.35)" }} />
        <span className="cv-sys__swname">Ground</span>
        <span className="cv-sys__swhex">{t.bg}</span>
        <span className="cv-sys__swrole">Canvas; sidebar {t.side}; sheet {t.surface2}</span>
        <span className="cv-sys__ratio num">Neutral, chroma 0</span>
      </div>
    </div>
  );
}

function Section({ title, note, children, wide }: { title: string; note?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? "cv-sys__sec cv-sys__sec--wide" : "cv-sys__sec"}>
      <h2 className="cv-sys__h">{title}</h2>
      {note ? <p className="cv-sys__note">{note}</p> : null}
      <div className="cv-sys__body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cv-sys__row">
      <span className="cv-sys__rl">{label}</span>
      <div className="cv-sys__rc">{children}</div>
    </div>
  );
}

export function SystemScene() {
  const [on, setOn] = React.useState(true);
  const [seg, setSeg] = React.useState("Standard");
  return (
    <div className="cv-sys">
      <header className="cv-sys__head">
        <div className="cv-logo">
          <Point size={20} />
          Juno
        </div>
        <h1 className="t-title">Canvas, the component sheet</h1>
        <p className="cv-page__sub">Two weights, one accent on send, colour only where a thing brings its own. Every state below is the real rule, forced.</p>
      </header>

      <Section title="Type" note="Wix Madefor Display for 20px and up, Wix Madefor Text for everything else, JetBrains Mono for code. Regular and medium only." wide>
        <div className="cv-sys__type">
          <div><span className="cv-sys__spec">Display 44/52, 400, −3%</span><p className="t-display">What’s next, Liam?</p></div>
          <div><span className="cv-sys__spec">Title 28/34, 400, −2.2%</span><p className="t-title">Crew</p></div>
          <div><span className="cv-sys__spec">Heading 17/26, 500</span><p className="t-heading">Renewal risk this quarter</p></div>
          <div><span className="cv-sys__spec">Body 16/26, 400, measure 68ch</span><p className="t-body">Stripe shows €412,000 of the €438,000 the forecast expects from renewals.</p></div>
          <div><span className="cv-sys__spec">UI 13.5/20, 400</span><p className="t-ui">Q3 forecast against Stripe revenue</p></div>
          <div><span className="cv-sys__spec">Small 12.5/18 and label 12/16</span><p className="t-small ink-2">Step 2 of 4, started 4 minutes ago</p></div>
          <div><span className="cv-sys__spec">Mono 12.5/20</span><p className="t-mono">await lease.commit(result.next);</p></div>
          <div><span className="cv-sys__spec">Tabular figures</span><p className="t-ui num">€96,000 &nbsp; €72,400 &nbsp; €23,600</p></div>
        </div>
      </Section>

      <Section title="Colour" note="95% neutral. Contrast is computed from the token values." wide>
        <div className="cv-sys__ramps">
          <Swatches t={LIGHT} label="Light" />
          <Swatches t={DARK} label="Dark" />
        </div>
      </Section>

      <Section title="Buttons" note="Hover and press are tonal steps. Nothing moves.">
        {(["primary", "secondary", "ghost"] as const).map((v) => (
          <Row key={v} label={v[0].toUpperCase() + v.slice(1)}>
            <button type="button" className={`cv-btn cv-btn--${v}`}>Allow once</button>
            <button type="button" className={`cv-btn cv-btn--${v} is-hover`}>Hover</button>
            <button type="button" className={`cv-btn cv-btn--${v} is-press`}>Pressed</button>
            <button type="button" className={`cv-btn cv-btn--${v} is-focus`}>Focus</button>
            <button type="button" className={`cv-btn cv-btn--${v}`} disabled>Disabled</button>
          </Row>
        ))}
        <Row label="Small">
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm">Halvorsen AS</button>
          <button type="button" className="cv-btn cv-btn--primary cv-btn--sm">Connect</button>
          <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm">Stop</button>
        </Row>
      </Section>

      <Section title="Icon buttons and send" note="32px on desktop, 44px on touch. The accent appears only when there is something to send.">
        <Row label="Icon">
          <button type="button" className="cv-ibtn" aria-label="Add"><Plus className="cv-i" /></button>
          <button type="button" className="cv-ibtn is-hover" aria-label="Hover"><Mic className="cv-i" /></button>
          <button type="button" className="cv-ibtn is-press" aria-label="Pressed"><Search className="cv-i" /></button>
          <button type="button" className="cv-ibtn" aria-pressed="true" aria-label="Selected"><Pin className="cv-i" /></button>
          <button type="button" className="cv-ibtn is-focus" aria-label="Focus"><MoreHorizontal className="cv-i" /></button>
          <button type="button" className="cv-ibtn" disabled aria-label="Disabled"><X className="cv-i" /></button>
        </Row>
        <Row label="Send, voice">
          <button type="button" className="cv-send" aria-label="Send"><ArrowUp className="cv-i" /></button>
          <button type="button" className="cv-send is-hover-accent" aria-label="Send hover"><ArrowUp className="cv-i" /></button>
          <button type="button" className="cv-send is-press-accent" aria-label="Send pressed"><ArrowUp className="cv-i" /></button>
          <button type="button" className="cv-send" data-mode="voice" aria-label="Talk"><AudioLines className="cv-i" /></button>
        </Row>
      </Section>

      <Section title="Field, switch, segmented, tabs">
        <div className="cv-sys__field">
          <label className="cv-flabel" htmlFor="cv-f1">Name</label>
          <input id="cv-f1" className="cv-input" defaultValue="Mira" />
          <p className="cv-fhelp">Shown in the sidebar and in the thread.</p>
        </div>
        <div className="cv-sys__field">
          <label className="cv-flabel" htmlFor="cv-f2">Budget per task</label>
          <input id="cv-f2" className="cv-input is-focus-field" defaultValue="€40" />
        </div>
        <div className="cv-sys__field">
          <label className="cv-flabel" htmlFor="cv-f3">Slack channel</label>
          <input id="cv-f3" className="cv-input" data-invalid="" aria-invalid="true" defaultValue="design" />
          <p className="cv-ferr">Channels start with #. Try #design.</p>
        </div>
        <Row label="Switch">
          <button type="button" role="switch" aria-checked={on} className="cv-toggle" onClick={() => setOn((v) => !v)}>
            <span className="cv-toggle__knob" />
          </button>
          <span className="t-ui">Web search {on ? "on" : "off"}</span>
          <button type="button" role="switch" aria-checked={false} className="cv-toggle">
            <span className="cv-toggle__knob" />
          </button>
        </Row>
        <Row label="Segmented">
          <div className="cv-seg" role="radiogroup" aria-label="Effort" style={{ width: 240 }}>
            {["Light", "Standard", "Deep"].map((e) => (
              <button key={e} type="button" role="radio" aria-checked={seg === e} className="cv-seg__opt" onClick={() => setSeg(e)}>
                {e}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Tabs">
          <div className="cv-tabs cv-tabs--inline" role="tablist">
            {["Diff", "Files", "Terminal", "Tests"].map((t, i) => (
              <button key={t} type="button" role="tab" aria-selected={i === 0} className="cv-tab">{t}</button>
            ))}
          </div>
        </Row>
      </Section>

      <Section title="Sidebar rows and suggestions">
        <div className="cv-sys__side">
          <a className="cv-row" href="#a"><Folder className="cv-i" /><span className="cv-row__text">Projects</span></a>
          <a className="cv-row is-hover" href="#b"><BookOpen className="cv-i" /><span className="cv-row__text">Library, hover</span><span className="cv-row__hint" style={{ opacity: 1 }}>⌘L</span></a>
          <a className="cv-row" aria-current="page" href="#c"><span className="cv-row__text">Current chat</span></a>
          <a className="cv-row" href="#d"><Face member={MIRA} presence="waiting" size={18} /><span className="cv-row__text">Mira</span><span className="cv-row__attn">Needs you</span></a>
          <a className="cv-row" href="#e"><Face member={CREW[2]} presence="working" size={18} /><span className="cv-row__text">Otto</span></a>
          <a className="cv-row cv-row--muted" href="#f"><span className="cv-row__text">Pricing page copy, second pass</span></a>
        </div>
        <Row label="Chips">
          <button type="button" className="cv-chip"><Face member={MIRA} presence="waiting" size={16} />Answer Mira on Halvorsen</button>
          <button type="button" className="cv-chip is-hover-chip"><Folder className="cv-i" />Hover</button>
        </Row>
      </Section>

      <Section title="Context tokens" note="Neutral chips; the colour is the thing’s own mark. A dashed edge means it needs connecting first.">
        <p className="cv-sys__sentence">
          <TokenChip id="forecast" /> <TokenChip id="stripe" /> <TokenChip id="mira" /> <TokenChip id="atlas" /> <TokenChip id="chat1" />
        </p>
        <p className="cv-sys__sentence">
          <TokenChip id="slack" selected /> <span className="cv-sys__rl">selected</span> <TokenChip id="linear" /> <span className="cv-sys__rl">needs connection</span>
        </p>
        <div className="cv-sys__panels">
          <div className="cv-sys__panelbox"><AppPanel id="slack" style={{ position: "relative" }} /></div>
          <div className="cv-sys__panelbox"><AppPanel id="linear" style={{ position: "relative" }} /></div>
        </div>
      </Section>

      <Section title="Menu and palette">
        <div className="cv-sys__menus">
          <div className="cv-pop cv-sys__static" role="menu" aria-label="Chat">
            <button type="button" role="menuitem" className="cv-pop__row"><Pencil className="cv-i ink-3" /><span className="cv-pop__text">Rename</span></button>
            <button type="button" role="menuitem" className="cv-pop__row" data-active=""><Pin className="cv-i ink-3" /><span className="cv-pop__text">Pin</span><span className="cv-pop__detail">⌘P</span></button>
            <button type="button" role="menuitem" className="cv-pop__row"><Folder className="cv-i ink-3" /><span className="cv-pop__text">Move to project</span></button>
            <div className="cv-pop__sep" />
            <button type="button" role="menuitem" className="cv-pop__row"><Trash2 className="cv-i ink-3" /><span className="cv-pop__text">Delete</span></button>
          </div>
          <div className="cv-sys__static cv-sys__static--palette">
            <Palette
              groups={[
                { label: "Crew", items: [{ token: TOKENS.mira, group: "Crew" }] },
                { label: "Apps", items: [{ token: TOKENS.stripe, group: "Apps" }, { token: TOKENS.linear, group: "Apps" }] },
              ]}
              active={0}
              session={99}
              style={{ position: "relative" }}
              onChoose={() => undefined}
              onHover={() => undefined}
            />
          </div>
        </div>
      </Section>

      <Section title="Dialog and toast">
        <div className="cv-sys__dialogwrap">
          <div className="cv-dialog" role="dialog" aria-labelledby="cv-dlg-t" aria-modal="false">
            <h3 id="cv-dlg-t" className="cv-dialog__t">Delete this chat?</h3>
            <p className="cv-dialog__b">“Q3 forecast against Stripe revenue” and its files leave your Library. Mira’s task stops.</p>
            <div className="cv-dialog__a">
              <button type="button" className="cv-btn cv-btn--secondary">Cancel</button>
              <button type="button" className="cv-btn cv-btn--primary">Delete</button>
            </div>
          </div>
        </div>
        <div className="cv-toast" role="status">
          <Check className="cv-i" />
          Posted the summary to #design
          <button type="button" className="cv-toast__undo">Undo</button>
        </div>
      </Section>

      <Section title="Empty and loading">
        <div className="cv-empty">
          <BookOpen className="cv-i ink-3" />
          <p className="cv-empty__t">Nothing in your Library yet</p>
          <p className="cv-empty__b">Documents, decks and sheets Juno makes land here, with the files you give it.</p>
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--sm"><Plus className="cv-i" />Add a file</button>
        </div>
        <div className="cv-skel" aria-label="Loading" role="status">
          <span style={{ width: "38%" }} />
          <span style={{ width: "92%" }} />
          <span style={{ width: "84%" }} />
          <span style={{ width: "61%" }} />
        </div>
      </Section>

      <Section title="The point, Juno’s signature" note="Rest, thinking (walks the ring), working (reads the row). Under reduced motion the ink point stays in the centre and the words carry the state.">
        <div className="cv-sys__points">
          {(["rest", "thinking", "working"] as const).map((st) => (
            <figure key={st} className="cv-sys__pt">
              <div className="cv-sys__ptrow">
                <Point state={st} size={16} />
                <Point state={st} size={24} />
                <Point state={st} size={48} />
              </div>
              <figcaption>{st === "rest" ? "Rest" : st === "thinking" ? "Thinking" : "Working"}</figcaption>
            </figure>
          ))}
          <figure className="cv-sys__pt cv-rm-demo" data-rm="">
            <div className="cv-sys__ptrow">
              <Point state="thinking" size={16} />
              <Point state="thinking" size={24} />
              <Point state="thinking" size={48} />
            </div>
            <figcaption>Thinking, reduced motion</figcaption>
          </figure>
        </div>
      </Section>

      <Section title="Faces" note="Flat, one tone, eyes carry the state. Gestures only on events: arrival, change, hover.">
        <div className="cv-sys__faces">
          {PRESENCE_ORDER.map((p) => (
            <figure key={p} className="cv-sys__pt" data-face-host="">
              <Face member={MIRA} presence={p} size={36} label />
              <figcaption className={p === "waiting" ? "amber" : undefined}>{PRESENCE_LABEL[p]}</figcaption>
            </figure>
          ))}
        </div>
        <div className="cv-sys__faces">
          {CREW.map((m) => (
            <figure key={m.id} className="cv-sys__pt">
              <Face member={m} presence="available" size={28} />
              <figcaption>{m.name}</figcaption>
            </figure>
          ))}
        </div>
      </Section>
    </div>
  );
}
