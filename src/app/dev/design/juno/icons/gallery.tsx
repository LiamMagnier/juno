"use client";

/**
 * The icon gallery (design round 3). Exported for the foundations lead to
 * mount at /dev/design/juno?scene=icons; also served on its own at
 * /dev/design/juno/icons.
 *
 *   view   sheet (default) | proof | lab | context | reel | states
 *   group  a group name, to show one section only (reel and sheet)
 */
import * as React from "react";
import { ICONS, type IconDrawing, type IconGroup } from "./drawings";
import { Icon, iconStrokePx } from "./index";
import "./gallery.css";

const GROUPS: IconGroup[] = ["Navigation", "Composer", "Message", "States", "Files", "Apps", "Crew and time", "Code", "Library", "Arrows", "Theme"];

const byGroup = (group: IconGroup) => Object.entries(ICONS).filter(([, d]) => d.group === group) as [string, IconDrawing][];

export type GalleryView = "sheet" | "proof" | "lab" | "context" | "reel" | "states" | "focus";

export function IconGallery({ view = "sheet", group, names, on }: { view?: GalleryView; group?: string; names?: string; on?: boolean }) {
  if (view === "focus") return <Focus names={names} on={on} />;
  if (view === "proof") return <Proof />;
  if (view === "lab") return <StrokeLab />;
  if (view === "context") return <Context />;
  if (view === "reel") return <Reel group={group} />;
  if (view === "states") return <States />;
  return <Sheet group={group} />;
}

/* —————————————————————————————— Sheet —————————————————————————————— */

function Sheet({ group }: { group?: string }) {
  const groups = group ? GROUPS.filter((g) => g.toLowerCase() === group.toLowerCase()) : GROUPS;
  const count = Object.keys(ICONS).length;
  return (
    <main className="jig">
      <header className="jig-head">
        <h1 className="jig-title">Icons</h1>
        <p className="jig-lede">
          {count} drawings on one 24 unit grid, one 1.5 px line and one motion each. Hover any of them; the right-hand three show the hover pose, the on
          state and the disabled state.
        </p>
      </header>
      {groups.map((g) => (
        <section key={g} className="jig-sec" aria-labelledby={`g-${g}`}>
          <h2 id={`g-${g}`} className="jig-h2">
            {g}
          </h2>
          <div className="jig-grid">
            {byGroup(g).map(([name, d]) => (
              <Cell key={name} name={name} d={d} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function Cell({ name, d }: { name: string; d: IconDrawing }) {
  return (
    <div className="jig-cell" title={d.motion}>
      <div className="jig-sizes">
        {[16, 20, 24].map((s) => (
          <button key={s} type="button" className="jig-btn jicon-trigger" data-size={s} aria-label={`${name}, ${s} px`}>
            <Icon name={name} size={s} />
          </button>
        ))}
      </div>
      <div className="jig-states" aria-hidden>
        <span className="jig-state" data-jicon-pose="hover">
          <Icon name={name} size={20} />
        </span>
        <span className="jig-state" data-dim={d.on ? undefined : ""}>
          <Icon name={name} size={20} state={d.on ? "active" : "rest"} />
        </span>
        <span className="jig-state">
          <Icon name={name} size={20} state="disabled" />
        </span>
      </div>
      <p className="jig-name">{name}</p>
    </div>
  );
}

/* —————————————————————————————— Focus (drawing review) —————————————————————————————— */

function FocusGrid() {
  return (
    <svg className="jig-focusgrid" viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 25 }, (_, i) => (
        <React.Fragment key={i}>
          <line x1={i} y1={0} x2={i} y2={24} strokeWidth={i % 3 === 0 ? 0.04 : 0.015} />
          <line x1={0} y1={i} x2={24} y2={i} strokeWidth={i % 3 === 0 ? 0.04 : 0.015} />
        </React.Fragment>
      ))}
      <rect x={3} y={3} width={18} height={18} fill="none" strokeWidth={0.04} strokeDasharray="0.3 0.3" />
    </svg>
  );
}

function Focus({ names, on }: { names?: string; on?: boolean }) {
  const list = (names ?? "crew,research,auto,attach").split(",").filter(Boolean);
  return (
    <main className="jig jig--focus">
      {list.map((n) => (
        <div key={n} className="jig-focus">
          <div className="jig-focusbig">
            <FocusGrid />
            <Icon name={n} size={192} line={1.5} state={on && ICONS[n as keyof typeof ICONS]?.on ? "active" : "rest"} />
          </div>
          <div className="jig-focussmall">
            <Icon name={n} size={16} />
            <Icon name={n} size={20} />
            <Icon name={n} size={24} />
            <Icon name={n} size={20} state="active" />
          </div>
          <p className="jig-name">{n}</p>
        </div>
      ))}
    </main>
  );
}

/* —————————————————————————————— 16 px proof —————————————————————————————— */

function Proof() {
  const all = Object.keys(ICONS);
  return (
    <main className="jig jig--proof">
      <div className="jig-split">
        {(["light", "dark"] as const).map((t) => (
          <div key={t} className="jn jig-pane" data-theme={t}>
            <div className="jig-proof">
              {all.map((n) => (
                <div key={n} className="jig-proofcell">
                  <Icon name={n} size={16} />
                  <span>{n}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

/* —————————————————————————————— Stroke lab —————————————————————————————— */

const LAB = ["new-chat", "search", "folder", "library", "customize", "crew", "bell", "sidebar", "plus", "attach", "globe", "mic", "copy", "retry", "document", "calendar"];

function StrokeLab() {
  const options = [
    { label: "1 px", px: 1 },
    { label: "1.25 px", px: 1.25 },
    { label: "1.5 px (house)", px: 1.5 },
  ];
  return (
    <main className="jig jig--lab">
      <div className="jig-split">
        {(["light", "dark"] as const).map((t) => (
          <div key={t} className="jn jig-pane" data-theme={t}>
            {options.map((o) => (
              <section key={o.label} className="jig-labrow">
                <p className="jig-labcap">{o.label} at 16</p>
                <div className="jig-labnav">
                  {LAB.slice(0, 8).map((n) => (
                    <span key={n} className="jig-labitem">
                      <Icon name={n} size={16} style={{ strokeWidth: (o.px * 24) / 16 }} />
                      <span>{n.replace("-", " ")}</span>
                    </span>
                  ))}
                </div>
                <div className="jig-labstrip">
                  {LAB.map((n) => (
                    <Icon key={n} name={n} size={16} style={{ strokeWidth: (o.px * 24) / 16 }} />
                  ))}
                  <span className="jig-labsep" />
                  {LAB.map((n) => (
                    <Icon key={n} name={n} size={20} style={{ strokeWidth: (o.px * 24) / 20 }} />
                  ))}
                </div>
              </section>
            ))}
            <p className="jig-labcap">House ladder: 12 px draws {iconStrokePx(12)} px, 14 px draws {iconStrokePx(14)} px, 16 to 24 px draw 1.5 px</p>
          </div>
        ))}
      </div>
    </main>
  );
}

/* —————————————————————————————— In context —————————————————————————————— */

function Context() {
  return (
    <main className="jig jig--context">
      <div className="jig-split">
        {(["light", "dark"] as const).map((t) => (
          <div key={t} className="jn jig-pane jig-ctx" data-theme={t}>
            <ContextBody />
          </div>
        ))}
      </div>
    </main>
  );
}

function ContextBody() {
  const [copied, setCopied] = React.useState(false);
  const [menu, setMenu] = React.useState(true);
  const [up, setUp] = React.useState(false);
  return (
    <>
      <aside className="jig-side">
        <div className="jig-sidehead">
          <span className="jig-wordmark">Juno</span>
          <span className="jig-sidetools">
            <button type="button" className="jig-ib jicon-trigger" aria-label="Activity">
              <Icon name="bell" size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Hide sidebar">
              <Icon name="sidebar" size={16} />
            </button>
          </span>
        </div>
        {[
          ["new-chat", "New chat"],
          ["search", "Search"],
          ["folder", "Projects"],
          ["library", "Library"],
          ["customize", "Customize"],
        ].map(([icon, label], i) => (
          <a key={icon} href="#" className="jig-row jicon-trigger" aria-current={i === 3 ? "page" : undefined} onClick={(e) => e.preventDefault()}>
            <Icon name={icon} size={16} />
            <span>{label}</span>
          </a>
        ))}
        <p className="jig-sidelabel">
          Crew
          <button type="button" className="jig-ib jig-ib--sm jicon-trigger" aria-label="Add to crew">
            <Icon name="plus" size={16} />
          </button>
        </p>
        <p className="jig-sidelabel">Code sessions</p>
        {[
          ["progress", "Retry flaky upload test", "active"],
          ["hand", "Migrate billing webhooks", "rest"],
          ["check", "Dark mode tokens", "rest"],
          ["alert", "Bump Next to 16.2", "rest"],
        ].map(([icon, label, state]) => (
          <span key={label} className="jig-row jig-row--session" data-kind={icon}>
            <Icon name={icon} size={16} value={icon === "progress" ? 0.62 : undefined} state={state as "rest" | "active"} />
            <span>{label}</span>
          </span>
        ))}
      </aside>

      <section className="jig-main">
        <div className="jig-msg">
          <p>
            The renewal summary for Northwind is ready. Three accounts moved to annual billing and one asked for a pause until March.
          </p>
          <div className="jig-actions jicon-quiet" role="toolbar" aria-label="Message actions">
            <button type="button" className="jig-ib jicon-trigger" aria-label={copied ? "Copied" : "Copy"} onClick={() => setCopied((c) => !c)}>
              <Icon name={copied ? "check" : "copy"} size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Try again">
              <Icon name="retry" size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Good response" aria-pressed={up} onClick={() => setUp((u) => !u)}>
              <Icon name="thumbs-up" size={16} state={up ? "active" : "rest"} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Bad response">
              <Icon name="thumbs-down" size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Share">
              <Icon name="share" size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="More">
              <Icon name="more" size={16} />
            </button>
          </div>
        </div>

        <div className="jig-composer jicon-quiet">
          <p className="jig-placeholder">Ask Juno, or type @ to add a file, app or teammate</p>
          <div className="jig-crow">
            <button type="button" className="jig-ib jicon-trigger" aria-label="Add" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Icon name="plus" size={20} state={menu ? "active" : "rest"} />
            </button>
            <button type="button" className="jig-chip jicon-trigger">
              <Icon name="globe" size={16} />
              Web
            </button>
            <span className="jig-grow" />
            <button type="button" className="jig-model jicon-trigger">
              Auto
              <Icon name="chevron-down" size={16} />
            </button>
            <button type="button" className="jig-ib jicon-trigger" aria-label="Dictate">
              <Icon name="mic" size={20} />
            </button>
            <button type="button" className="jig-send jicon-trigger" aria-label="Send">
              <Icon name="send" size={20} />
            </button>
          </div>
          {menu ? (
            <div className="jig-menu" role="menu">
              {[
                ["attach", "Add files or photos"],
                ["screenshot", "Take a screenshot"],
                ["library", "From Library"],
              ].map(([icon, label]) => (
                <span key={label} className="jig-mrow" role="menuitem">
                  <Icon name={icon} size={16} />
                  {label}
                </span>
              ))}
              <span className="jig-msep" />
              {[
                ["globe", "Web search", true],
                ["memory", "Use memory", false],
              ].map(([icon, label, on]) => (
                <span key={String(label)} className="jig-mrow" role="menuitemcheckbox" aria-checked={Boolean(on)}>
                  <Icon name={String(icon)} size={16} state={icon === "memory" && on ? "active" : "rest"} />
                  {label}
                  <span className="jig-grow" />
                  {on ? <Icon name="check" size={16} state="active" /> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="jig-files">
          {[
            ["document", "Renewal summary, Northwind", "Doc"],
            ["sheet", "Q3 forecast", "Sheet"],
            ["deck", "Board update, October", "Slides"],
            ["pdf", "Signed order form", "PDF"],
            ["file-code", "webhooks.ts", "Code"],
          ].map(([icon, label, kind]) => (
            <span key={label} className="jig-file">
              <Icon name={icon} size={16} />
              <span className="jig-filename">{label}</span>
              <span className="jig-filekind">{kind}</span>
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

/* —————————————————————————————— States (for the motion clips) —————————————————————————————— */

function States() {
  const pairs: { name: string; label: string }[] = [
    { name: "copy", label: "Copy, then copied" },
    { name: "send", label: "Send, then stop" },
    { name: "mic", label: "Dictate, then listening" },
    { name: "play", label: "Play, then pause" },
    { name: "plus", label: "Add, menu open" },
    { name: "chevron-right", label: "Disclosure" },
    { name: "chevron-down", label: "Menu trigger" },
    { name: "star", label: "Star" },
    { name: "pin", label: "Pin" },
    { name: "bell", label: "Unseen activity" },
    { name: "thumbs-up", label: "Good response" },
    { name: "memory", label: "Use memory" },
    { name: "sun", label: "Theme" },
    { name: "success", label: "Done" },
  ];
  const [on, setOn] = React.useState<Record<string, boolean>>({});
  return (
    <main className="jig jig--states">
      <div className="jig-stategrid">
        {pairs.map((p) => (
          <button
            key={p.name}
            type="button"
            className="jig-statebtn jicon-trigger"
            data-name={p.name}
            aria-pressed={!!on[p.name]}
            onClick={() => setOn((s) => ({ ...s, [p.name]: !s[p.name] }))}
          >
            <Icon name={p.name} size={20} state={on[p.name] ? "active" : "rest"} />
            <span>{p.label}</span>
          </button>
        ))}
        <SwapDemo />
      </div>
    </main>
  );
}

function SwapDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <button type="button" className="jig-statebtn jicon-trigger" data-name="name-turn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      <Icon name={open ? "chevron-down" : "chevron-right"} size={20} />
      <span>Name change turns</span>
    </button>
  );
}

/* —————————————————————————————— Reel (large, for recording) —————————————————————————————— */

function Reel({ group }: { group?: string }) {
  const groups = group ? GROUPS.filter((g) => g.toLowerCase().replace(/ /g, "-") === group.toLowerCase()) : GROUPS;
  return (
    <main className="jig jig--reel">
      {groups.map((g) => (
        <section key={g} className="jig-reelsec">
          <h2 className="jig-h2">{g}</h2>
          <div className="jig-reelgrid">
            {byGroup(g).map(([name]) => (
              <button key={name} type="button" className="jig-reelbtn jicon-trigger" data-name={name} aria-label={name}>
                <Icon name={name} size={20} />
                <span>{name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
