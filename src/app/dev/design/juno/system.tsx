"use client";

import * as React from "react";
import { CrewFace, type CrewState } from "./crew/face";
import { CREW, DRAFT, PALETTE_GROUPS, RECEIPT, TOKENS, type Segment } from "./fixtures";
import { AppPanel, Composer, ModelPopover, Palette, PlusMenu, Segmented, TokenChip } from "./composer";
import { ContextRow } from "./code";
import { PolicyControl } from "./customize";
import { Icon } from "./icons";
import { ICON_USAGE } from "./icon-usage";
import { AppMark, FileMark } from "./marks";
import { COLOURS, contrast, hex, INKS, PLANES, type Swatch, type Theme } from "./palette";
import { CrewRowItem, face, OrbitLabel, Toast, Wordmark } from "./shell";
import { CrewMark } from "./crew-bridge";
import { Approval, LiveLine, MessageActions, NeedsYouRow, TaskCard, Trace, UserMessage } from "./thread";

/*
 * The component sheet: every piece at rest and in its states, on the tokens,
 * in whichever theme the scene is rendered. Forced states use data-force
 * attributes that restate the real :hover / :active / :focus-visible rules.
 */

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="jn-sys__section" id={id} aria-labelledby={`${id}-h`}>
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

function Cell({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <figure className="jn-sys__cell" data-wide={wide ? "" : undefined}>
      <div className="jn-sys__demo">{children}</div>
      <figcaption className="jn-sys__cap">{label}</figcaption>
    </figure>
  );
}

function useTheme(): Theme {
  const [t, setT] = React.useState<Theme>("light");
  React.useEffect(() => {
    const el = document.querySelector(".jn");
    const read = () => {
      const forced = el?.getAttribute("data-theme");
      setT(forced === "dark" || (forced !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
    };
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return t;
}

function Swatches({ list, theme }: { list: Swatch[]; theme: Theme }) {
  return (
    <div className="jn-sys__swatches">
      {list.map((s) => {
        const value = s[theme];
        const checks = s.text?.on.map((p) => ({ p, r: contrast(value, hex(p, theme)) }));
        const worst = checks?.reduce((a, b) => (b.r < a.r ? b : a));
        return (
          <div key={s.key} className="jn-sys__sw">
            <span className="jn-sys__chip" style={{ background: value }} />
            <span className="jn-sys__swname">{s.name}</span>
            <span className="jn-sys__swhex mono">{value}</span>
            <span className="jn-sys__swrole">{s.role}</span>
            {worst && s.text ? (
              <span className="jn-sys__ratio num" data-fail={worst.r < s.text.min ? "" : undefined}>
                {worst.r.toFixed(2)}:1 at worst, on {worst.p}
              </span>
            ) : (
              <span className="jn-sys__ratio" />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A popover over real transcript content, so the material can be judged. */
function MaterialSample() {
  return (
    <div className="jn-sys__matstage">
      <div className="jn-sys__matcopy" aria-hidden="true">
        <p>
          Compare <TokenChip id="forecast" /> with <TokenChip id="stripe" /> and ask <TokenChip id="mira" /> to flag renewal risk.
        </p>
        <p>
          <b>Halvorsen</b> moved to monthly billing in August. <b>Brightline Studio</b> dropped two seats. <b>Oakridge Health</b> has an unpaid invoice from July.
        </p>
      </div>
      <ModelPopover style={{ position: "absolute", right: 12, top: 40, width: 344 }} />
    </div>
  );
}

const STATES: CrewState[] = ["available", "thinking", "working", "waiting", "paused", "offline"];

/** `?scene=system&lab=cmark`: the small-slot framing lab (zoom × eyeline × size, every member). */
export function CrewMarkLab({ zooms = [1.6, 1.75, 1.9], eyes = [0.44, 0.47, 0.5] }: { zooms?: number[]; eyes?: number[] }) {
  return (
    <main className="jn-sys" style={{ padding: 32 }}>
      {zooms.map((z) =>
        eyes.map((e) => (
          <div key={`${z}-${e}`} style={{ display: "flex", alignItems: "center", gap: 18, margin: "10px 0" }}>
            <span className="mono ink-3" style={{ width: 120 }}>
              zoom {z} eye {e}
            </span>
            {[16, 20, 24].map((size) => (
              <span key={size} style={{ display: "inline-flex", gap: 8, alignItems: "center", padding: "6px 10px", background: "var(--side)", borderRadius: 8 }}>
                {CREW.map((m) => (
                  <CrewMark key={m.id} member={face(m)} state={m.state} size={size} zoom={z} eyeline={e} />
                ))}
              </span>
            ))}
          </div>
        )),
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        {CREW.map((m) => (
          <CrewFace key={m.id} member={face(m)} state={m.state} size={64} live={false} facing="front" />
        ))}
      </div>
    </main>
  );
}

export function SystemScene() {
  const theme = useTheme();
  const tokenSegs: Segment[] = [{ t: "text", v: "Ask " }, { t: "token", id: "mira" }, { t: "text", v: " about " }, { t: "token", id: "forecast" }];
  const [seg, setSeg] = React.useState<"Light" | "Standard" | "Deep">("Standard");
  const paletteGroups = PALETTE_GROUPS.map((g) => ({
    label: g.label,
    items: g.ids.slice(0, g.kind === "crew" || g.kind === "file" || g.kind === "app" ? 2 : 1).map((id) => ({ token: TOKENS[id], group: g.label })),
  }));
  return (
    <main className="jn-sys">
      <header className="jn-sys__head">
        <h1 className="t-title">System</h1>
        <p className="jn-page__lede">
          Every piece of Alevr at rest and in its states, in the {theme} theme. Ninety-five per cent neutral; colour enters only through the things themselves, the presence colour for what is acting now, and amber for the words that say someone needs you.
        </p>
      </header>

      <Section id="colour" title="Colour" note="Planes step by tone, not by line. Text tokens show their worst contrast on the planes they sit on.">
        <p className="jn-sys__sub">Planes</p>
        <Swatches list={PLANES} theme={theme} />
        <p className="jn-sys__sub">Ink</p>
        <Swatches list={INKS} theme={theme} />
        <p className="jn-sys__sub">Meaning</p>
        <Swatches list={COLOURS} theme={theme} />
      </Section>

      <Section id="type" title="Type" note="Newsreader speaks; the sans works; mono is for code, paths and times. Two sans weights per screen: 400 and 500.">
        <div className="jn-sys__type">
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Greeting, serif 44/52</span>
            <span className="t-greet">What’s next, Liam?</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Cyrillic falls back to Literata</span>
            <span className="t-greet">Что дальше, Лиам?</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Page title, serif 32/40</span>
            <span className="t-title">Library</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Display, serif 24/30</span>
            <span className="t-display">Slack</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Heading, 19/26 medium (t-h)</span>
            <span className="t-h">Renewal risk this quarter</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Reading, 16/27 (t-body)</span>
            <span className="t-body" style={{ maxWidth: "58ch" }}>
              Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap.
            </span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Interface, 14/20</span>
            <span className="t-ui">Q3 forecast against Stripe revenue</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Small, 13/18</span>
            <span className="t-small ink-2">Waiting for your answer at step 2 of 4</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Meta, 12/16</span>
            <span className="t-meta">Q3 Forecast.xlsx and Stripe added. Mira takes the renewal check.</span>
          </div>
          <div className="jn-sys__typerow">
            <span className="jn-sys__typemeta">Mono, 12.5</span>
            <span className="mono">src/sync/worker.ts +14 −4</span>
          </div>
        </div>
      </Section>

      <Section id="shape" title="Shape and depth" note="Radii are concentric; free-standing controls are capsules. Only floating layers cast a shadow, and they sit on the material. The composer has none.">
        <div className="jn-sys__grid">
          <Cell label="Token, 7">
            <span className="jn-sys__rad" style={{ borderRadius: 7, width: 72, height: 24 }} />
          </Cell>
          <Cell label="Row, 8">
            <span className="jn-sys__rad" style={{ borderRadius: 8, width: 120, height: 32 }} />
          </Cell>
          <Cell label="Card, 12">
            <span className="jn-sys__rad" style={{ borderRadius: 12, width: 120, height: 64 }} />
          </Cell>
          <Cell label="Popover and panel, 14">
            <span className="jn-sys__rad jn-sys__rad--pop" style={{ borderRadius: 14, width: 120, height: 64 }} />
          </Cell>
          <Cell label="Composer, 22, hairline only">
            <span className="jn-sys__rad jn-sys__rad--composer" style={{ borderRadius: 22, width: 160, height: 64 }} />
          </Cell>
          <Cell label="Control, capsule">
            <span className="jn-sys__rad" style={{ borderRadius: 999, width: 96, height: 32 }} />
          </Cell>
        </div>
      </Section>

      <Section id="shell" title="Shell" note="The window is the frame; the sidebar sits on it and the content is an inset panel, 8 px in, radius 14, with a low-contrast edge. Sidebar rows are 32 px on a 4 px grid: two left edges, the icons at 18 and the labels at 46.">
        <div className="jn-sys__stack">
          <Cell label="Frame and panel: the header and the sidebar head share one centre line" wide>
            <div className="jn-sys__frame">
              <div className="jn-side jn-sys__frameside">
                <div className="jn-side__head">
                  <Wordmark />
                  <span className="jn-side__headtools">
                    <span className="jib jib--sm">
                      <Icon name="bell" size={16} />
                    </span>
                    <span className="jib jib--sm">
                      <Icon name="sidebar" size={16} />
                    </span>
                  </span>
                </div>
                <a href="#" className="jrow jn-side__nav">
                  <span className="jn-side__lead">
                    <Icon name="new-chat" size={16} />
                  </span>
                  <span className="jrow__text">New chat</span>
                </a>
                <a href="#" className="jrow jn-side__nav" aria-current="page">
                  <span className="jn-side__lead">
                    <Icon name="library" size={16} />
                  </span>
                  <span className="jrow__text">Library</span>
                </a>
              </div>
              <div className="jn-sys__framepanel">
                <header className="jn-top jn-sys__top" data-edge="">
                  <span className="jn-top__title">
                    <span>Q3 forecast against Stripe revenue</span>
                    <Icon name="chevron-down" size={16} />
                  </span>
                  <span className="jn-top__actions">
                    <span className="jib">
                      <Icon name="share" size={20} />
                    </span>
                  </span>
                </header>
                <p className="jn-sys__framecopy">Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap.</p>
              </div>
            </div>
          </Cell>
          <div className="jn-sys__grid">
            <Cell label="Rows: rest, hover, current, focus">
              <div className="jn-side jn-sys__siderows">
                <a href="#" className="jrow jn-side__nav">
                  <span className="jn-side__lead">
                    <Icon name="search" size={16} />
                  </span>
                  <span className="jrow__text">Search</span>
                </a>
                <a href="#" className="jrow jn-side__nav" data-force="hover">
                  <span className="jn-side__lead">
                    <Icon name="folder" size={16} />
                  </span>
                  <span className="jrow__text">Projects</span>
                  <kbd className="jn-side__kbd" style={{ opacity: 1 }}>
                    ⌘P
                  </kbd>
                </a>
                <a href="#" className="jrow jn-side__nav" aria-current="page">
                  <span className="jn-side__lead">
                    <Icon name="library" size={16} />
                  </span>
                  <span className="jrow__text">Library</span>
                </a>
                <a href="#" className="jrow jn-side__nav" data-force="focus">
                  <span className="jn-side__lead">
                    <Icon name="customize" size={16} />
                  </span>
                  <span className="jrow__text">Customize</span>
                </a>
              </div>
            </Cell>
            <Cell label="A section: its label and action, agent rows with their state on the right (Ready says nothing)">
              <div className="jn-side jn-sys__siderows">
                <OrbitLabel />
                <CrewRowItem m={CREW[0]} />
                <CrewRowItem m={CREW[1]} />
                <CrewRowItem m={CREW[2]} />
              </div>
            </Cell>
            <Cell label="A chat waiting on you, and the account">
              <div className="jn-side jn-sys__siderows">
                <a href="#" className="jrow jrow--text">
                  <span className="jrow__text">Q3 forecast against Stripe revenue</span>
                  <span className="jn-side__state jn-attn">Needs you</span>
                </a>
                <span className="jrow jn-side__account">
                  <span className="jn-avatar">LM</span>
                  <span className="jn-side__who">
                    <span className="jn-side__whoname">Liam Magnier</span>
                    <span className="jn-side__whoplan">Pro plan</span>
                  </span>
                  <Icon name="chevrons-up-down" size={16} />
                </span>
              </div>
            </Cell>
          </div>
        </div>
      </Section>

      <Section id="material" title="Material" note="Only what floats over content is translucent: menus, popovers, the palette, the app panel, sheets, toasts, the sticky header and the dock’s backdrop. Blur and saturation, tuned per theme, with a hairline edge. Reduce Transparency turns every one of them solid.">
        <div className="jn-sys__layers">
          <Cell label="A popover over a transcript">
            <MaterialSample />
          </Cell>
          <Cell label="The same, with Reduce Transparency">
            <div data-rt="">
              <MaterialSample />
            </div>
          </Cell>
          <Cell label="The sticky header once content is under it">
            <div className="jn-sys__matbar">
              <p className="jn-sys__matcopy">
                <b>Halvorsen</b> moved to monthly billing in August and has not renewed the annual plan. <b>Brightline Studio</b> dropped two seats on 12 September.
              </p>
              <header className="jn-top jn-sys__top" data-edge="">
                <span className="jn-top__title">
                  <span>Q3 forecast against Stripe revenue</span>
                  <Icon name="chevron-down" size={16} />
                </span>
              </header>
            </div>
          </Cell>
          <Cell label="Toast: one confirmation, at most one verb">
            <div className="jn-sys__toasts">
              <Toast verb="Undo">Posted to #design</Toast>
              <Toast icon="copy">Copied</Toast>
            </div>
          </Cell>
        </div>
      </Section>

      <Section id="buttons" title="Buttons" note="Hover is tone only; press is one step deeper. The primary is the ink: a dark disc in light, a light disc in dark.">
        <div className="jn-sys__matrix">
          <span />
          {["Rest", "Hover", "Press", "Focus", "Disabled", "Pending"].map((s) => (
            <span key={s} className="jn-sys__colh">
              {s}
            </span>
          ))}
          {(
            [
              ["Primary", "jb jb--primary", "Post to #design"],
              ["Secondary", "jb jb--secondary", "Not now"],
              ["Ghost", "jb jb--ghost", "Skip"],
              ["Danger", "jb jb--danger", "Delete forever"],
            ] as const
          ).map(([name, cls, text]) => (
            <React.Fragment key={name}>
              <span className="jn-sys__rowh">{name}</span>
              <span>
                <button type="button" className={cls}>
                  {text}
                </button>
              </span>
              <span>
                <button type="button" className={cls} data-force="hover">
                  {text}
                </button>
              </span>
              <span>
                <button type="button" className={cls} data-force="press">
                  {text}
                </button>
              </span>
              <span>
                <button type="button" className={cls} data-force="focus">
                  {text}
                </button>
              </span>
              <span>
                <button type="button" className={cls} aria-disabled="true">
                  {text}
                </button>
              </span>
              <span>
                <button type="button" className={cls} data-loading="" aria-busy="true">
                  {text}
                  <span className="jb__spin">
                    <span className="jspin" />
                  </span>
                </button>
              </span>
            </React.Fragment>
          ))}
          <span className="jn-sys__rowh">Icon</span>
          <span>
            <button type="button" className="jib jicon-trigger" aria-label="Copy">
              <Icon name="copy" size={20} />
            </button>
          </span>
          <span>
            <button type="button" className="jib jicon-trigger" data-force="hover" aria-label="Copy">
              <Icon name="copy" size={20} />
            </button>
          </span>
          <span>
            <button type="button" className="jib jicon-trigger" data-force="press" aria-label="Copy">
              <Icon name="copy" size={20} />
            </button>
          </span>
          <span>
            <button type="button" className="jib jicon-trigger" data-force="focus" aria-label="Copy">
              <Icon name="copy" size={20} />
            </button>
          </span>
          <span>
            <button type="button" className="jib" aria-disabled="true" style={{ opacity: 0.4 }} aria-label="Copy">
              <Icon name="copy" size={20} state="disabled" />
            </button>
          </span>
          <span>
            <button type="button" className="jib" aria-label="Copied">
              <Icon name="check" size={20} state="active" />
            </button>
          </span>
        </div>
        <div className="jn-sys__split">
          <Cell label="The verb with its other forms, arming (first 500 ms)">
            <span className="jsplit">
              <button type="button" className="jb jb--primary jsplit__main" aria-disabled="true">
                Post to #design
              </button>
              <button type="button" className="jb jb--primary jsplit__caret" aria-disabled="true" aria-label="More ways to post">
                <Icon name="chevron-down" size={16} />
              </button>
            </span>
          </Cell>
          <Cell label="Armed">
            <span className="jsplit" data-armed="">
              <button type="button" className="jb jb--primary jsplit__main">
                Post to #design
              </button>
              <button type="button" className="jb jb--primary jsplit__caret" aria-label="More ways to post">
                <Icon name="chevron-down" size={16} />
              </button>
            </span>
          </Cell>
          <Cell label="Link">
            <button type="button" className="jb jb--link">
              Tell Alevr what to do instead
            </button>
          </Cell>
        </div>
      </Section>

      <Section id="controls" title="Controls" note="Segmented thumbs travel on the standard spring. Switch and radio edges meet 3:1.">
        <div className="jn-sys__grid">
          <Cell label="Segmented">
            <Segmented options={["Light", "Standard", "Deep"] as const} value={seg} onChange={setSeg} label="Effort" layoutKey="sys-seg" />
          </Cell>
          <Cell label="Allow, Ask, Off">
            <PolicyControl value="ask" label="Post a message to a channel" />
          </Cell>
          <Cell label="Switch, off and on">
            <span style={{ display: "inline-flex", gap: 14 }}>
              <button type="button" role="switch" aria-checked="false" className="jswitch" aria-label="Off" />
              <button type="button" role="switch" aria-checked="true" className="jswitch" aria-label="On" />
            </span>
          </Cell>
          <Cell label="Field, rest and focus">
            <span style={{ display: "grid", gap: 10, width: 240 }}>
              <label className="jfield">
                <Icon name="search" size={16} />
                <input placeholder="Search apps" aria-label="Search apps" />
              </label>
              <label className="jfield" data-force="focus">
                <Icon name="search" size={16} />
                <input defaultValue="Lin" aria-label="Search apps" />
              </label>
            </span>
          </Cell>
          <Cell label="Keys">
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <span className="jkbd">⌘</span>
              <span className="jkbd">K</span>
              <span className="jkbd">↵</span>
              <span className="jkbd">esc</span>
            </span>
          </Cell>
          <Cell label="Rows: rest, hover, selected">
            <span style={{ display: "grid", gap: 2, width: 220 }}>
              <a href="#" className="jrow">
                <Icon name="library" size={16} />
                <span className="jrow__text">Library</span>
              </a>
              <a href="#" className="jrow" style={{ background: "var(--fill-hover)" }}>
                <Icon name="customize" size={16} />
                <span className="jrow__text">Customize</span>
              </a>
              <a href="#" className="jrow" aria-current="page">
                <Icon name="folder" size={16} />
                <span className="jrow__text">Projects</span>
              </a>
            </span>
          </Cell>
        </div>
      </Section>

      <Section id="tokens" title="Tokens" note="Neutral chips carrying the thing’s own mark. A token that cannot resolve dims its mark; the first Backspace selects before it deletes.">
        <div className="jn-sys__grid jn-sys__grid--tokens">
          <Cell label="File">
            <TokenChip id="forecast" still />
          </Cell>
          <Cell label="App">
            <TokenChip id="stripe" still />
          </Cell>
          <Cell label="Agent">
            <TokenChip id="mira" still />
          </Cell>
          <Cell label="Project">
            <TokenChip id="atlas" still />
          </Cell>
          <Cell label="Chat">
            <TokenChip id="chat1" still />
          </Cell>
          <Cell label="Not connected">
            <TokenChip id="linear" still />
          </Cell>
          <Cell label="Selected">
            <TokenChip id="slack" still selected />
          </Cell>
        </div>
      </Section>

      <Section id="composer" title="Composer" note="No shadow: surface and one crisp hairline. Pointer focus darkens the hairline; keyboard focus adds the ring. The disc is voice when empty, send with words, stop while Alevr works.">
        <div className="jn-sys__stack">
          <Cell label="Rest, empty: the disc is quiet (voice)" wide>
            <Composer initial={[]} />
          </Cell>
          <Cell label="Pointer focus: the hairline darkens" wide>
            <Composer initial={[]} still={{ pointerFocused: true }} />
          </Cell>
          <Cell label="Keyboard focus, with words: the ring, and the ink disc (send)" wide>
            <Composer initial={tokenSegs} still={{ focused: true }} />
          </Cell>
          <Cell label="Docked while Alevr works: stop, and the dock naming what needs you out of view" wide>
            <Composer initial={[]} variant="dock" busy placeholder="Reply…" dockRow={<NeedsYouRow count={2} />} />
          </Cell>
          <Cell label="Code: the quiet context row, permission mode as words" wide>
            <Composer initial={[]} variant="code" placeholder="Describe the change. @ files, / commands" context={<ContextRow mode="Plan" />} />
          </Cell>
        </div>
      </Section>

      <Section id="layers" title="Menus and popovers" note="On the material, always outside the composer. Pointer-opened layers grow from their trigger (220 ms from 0.96, opacity in 80 ms); keyboard-opened ones appear in the same frame with focus inside. The @ palette is keyboard-born.">
        <div className="jn-sys__layers">
          <Cell label="+ menu">
            <PlusMenu style={{ position: "relative", width: 280 }} />
          </Cell>
          <Cell label="@ palette">
            <Palette groups={paletteGroups} active={0} onChoose={() => {}} onHover={() => {}} style={{ position: "relative", width: 340 }} />
          </Cell>
          <Cell label="Model">
            <ModelPopover style={{ position: "relative" }} />
          </Cell>
          <Cell label="An app token’s popover">
            <AppPanel id="stripe" style={{ position: "relative", width: 344 }} />
          </Cell>
          <Cell label="Not connected">
            <AppPanel id="linear" style={{ position: "relative", width: 344 }} />
          </Cell>
        </div>
      </Section>

      <Section id="transcript" title="Transcript" note="Replies are plain text on the page. While Alevr works, the Continuum beside the truthful phase words is the one colour (a tonal handoff through its paths), the words stay in the second ink, and words fade in where they stay.">
        <div className="jn-sys__stack jn-sys__stack--narrow">
          <Cell label="The person’s turn and its receipt" wide>
            <UserMessage segments={DRAFT} receipt={RECEIPT} />
          </Cell>
          <Cell label="The live line, then with seconds" wide>
            <span style={{ display: "grid", gap: 8 }}>
              <LiveLine text="Reading Q3 Forecast.xlsx" />
              <LiveLine text="Comparing renewals with the forecast" seconds={4} />
              <LiveLine text="Mira is checking renewal usage" who="mira" />
            </span>
          </Cell>
          <Cell label="The trace, folded and open" wide>
            <span style={{ display: "grid", gap: 4 }}>
              <Trace />
              <Trace open />
            </span>
          </Cell>
          <Cell label="The action row" wide>
            <MessageActions />
          </Cell>
        </div>
      </Section>

      <Section id="cards" title="Task and approval" note="Flat tone steps, radius 12, no border and no shadow. The approval’s button is the verb; it arms after 500 ms; Always sits behind its caret.">
        <div className="jn-sys__stack jn-sys__stack--narrow">
          <Cell label="A task that needs your answer" wide>
            <TaskCard />
          </Cell>
          <Cell label="Answered, working, plan open" wide>
            <TaskCard answered="Halvorsen AS" planOpen />
          </Cell>
          <Cell label="Approval, armed, with its other forms open" wide>
            <div style={{ paddingBottom: 96 }}>
              <Approval menuOpen />
            </div>
          </Cell>
        </div>
      </Section>

      <Section
        id="crew"
        title="Agent faces"
        note="Each member is a character its person made. State is pose and expression, and always also words beside it. From 32 px up the whole character; at 24 px and below (rows, tokens, task headers) only the head, on a soft disc in the member's own colour, like an app's mark on its tile."
      >
        <div className="jn-sys__faces">
          <span />
          {STATES.map((s) => (
            <span key={s} className="jn-sys__colh">
              {s === "waiting" ? "Needs you" : s[0].toUpperCase() + s.slice(1)}
            </span>
          ))}
          {[96, 64, 32].map((size) => (
            <React.Fragment key={size}>
              <span className="jn-sys__rowh num">{size}</span>
              {STATES.map((s, i) => (
                <span key={s} className="jn-sys__face">
                  <CrewFace member={face(CREW[i])} state={s} size={size} live={size >= 32} />
                </span>
              ))}
            </React.Fragment>
          ))}
          {[24, 20, 16].map((size) => (
            <React.Fragment key={size}>
              <span className="jn-sys__rowh num">{size}, head</span>
              {STATES.map((s, i) => (
                <span key={s} className="jn-sys__face">
                  <CrewMark member={face(CREW[i])} state={s} size={size} />
                </span>
              ))}
            </React.Fragment>
          ))}
        </div>
      </Section>

      <Section id="icons" title="Icons" note="Alevr’s own set, drawn on a 24 grid for 16 and 20. Hover the grid: each icon has its own small motion, triggered by the control it sits in.">
        <div className="jn-sys__icons">
          {ICON_USAGE.map((g) => (
            <div key={g.group} className="jn-sys__icongroup">
              <p className="jn-sys__sub">{g.group}</p>
              <div className="jn-sys__iconrow">
                {g.names.map((n) => (
                  <button key={n} type="button" className="jn-sys__icon jicon-trigger" aria-label={n}>
                    <Icon name={n} size={20} />
                    <span className="jn-sys__iconname">{n}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="marks" title="Marks" note="The only colour in the chrome comes from the things themselves: an app’s real mark, a file type’s glyph, an agent’s face.">
        <div className="jn-sys__marks">
          {["slack", "stripe", "linear", "github", "notion", "figma", "gmail", "drive"].map((id) => (
            <span key={id} className="jn-sys__mark">
              <AppMark id={id} size={24} />
            </span>
          ))}
          {["Q3 Forecast.xlsx", "Board deck, October.pdf", "Office floor plan.png", "Renewal notes.md"].map((n) => (
            <span key={n} className="jn-sys__mark">
              <FileMark name={n} size={24} />
            </span>
          ))}
        </div>
      </Section>
    </main>
  );
}
