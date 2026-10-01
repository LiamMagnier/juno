"use client";

/**
 * The icon gallery (design round 3). Exported for the foundations lead to
 * mount at /dev/design/juno?scene=icons; also served on its own at
 * /dev/design/juno/icons.
 *
 *   view   sheet (default) | inventory | proof | lab | context | shell | reel | states | focus | pixels
 *   group  a group name, to show one section only (reel and sheet)
 */
import * as React from "react";
import { ICONS, resolveIcon, type IconDrawing, type IconGroup } from "./drawings";
import { Icon, iconStrokePx } from "./index";
import { SEMANTIC_INVENTORY } from "./inventory";
import "./gallery.css";

const GROUPS: IconGroup[] = ["Navigation", "Composer", "Message", "States", "Work and evidence", "Files", "Apps", "Agents and time", "Code", "Library", "Arrows", "Theme", "System"];

/** The F2 destinations whose glyph may articulate on hover (INTERACTION_SPEC I-7, revision 1). */
const DESTINATIONS = new Set(["new-chat", "folder", "library", "customize"]);

const byGroup = (group: IconGroup) => Object.entries(ICONS).filter(([, d]) => d.group === group) as [string, IconDrawing][];

export type GalleryView = "sheet" | "inventory" | "proof" | "lab" | "context" | "shell" | "reel" | "states" | "focus" | "pixels";

export function IconGallery({
  view = "sheet",
  group,
  names,
  on,
  size,
  fit = true,
  theme,
}: {
  view?: GalleryView;
  group?: string;
  names?: string;
  on?: boolean;
  size?: number;
  fit?: boolean;
  /** shell: one pane in this theme instead of light beside dark (for recording). */
  theme?: "light" | "dark";
}) {
  if (view === "pixels") return <Pixels names={names} size={size ?? 16} fit={fit} />;
  if (view === "focus") return <Focus names={names} on={on} />;
  if (view === "inventory") return <Inventory />;
  if (view === "proof") return <Proof />;
  if (view === "lab") return <StrokeLab />;
  if (view === "context") return <Context />;
  if (view === "shell") return <ShellContext theme={theme} />;
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
          Alevr&apos;s own set: {count} drawings on one 24 unit grid, one optically sized line (1.25 px at 16, 1.5 px from 18), fitted to the pixel grid
          at every size, with a small cut below 18 px where detail would turn to mud, and at most one motion each. In the product, hover motion is
          opt-in (low-frequency destinations only) and Orbit never moves; here every cell opts in. Hover any of them; the right-hand three show the
          hover pose, the on state and the disabled state. The brand&apos;s semantic inventory is at ?view=inventory.
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
          <button key={s} type="button" className="jig-btn jicon-trigger jicon-hover" data-size={s} aria-label={`${name}, ${s} px`}>
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

/* —————————————————————————————— Semantic inventory (Alevr, NAMES_AND_ICONS.md) —————————————————————————————— */

/** Every row of the brand's semantic icon inventory, each label drawn from this set at 16 and 20 px, light beside dark. */
function Inventory() {
  const total = SEMANTIC_INVENTORY.reduce((n, r) => n + r.items.length, 0);
  const missing = SEMANTIC_INVENTORY.flatMap((r) => r.items).filter((it) => !resolveIcon(it.icon));
  return (
    <main className="jig jig--inv">
      <div className="jig-split">
        {(["light", "dark"] as const).map((t) => (
          <div key={t} className="jn jig-pane" data-theme={t}>
            <header className="jig-invhead">
              <h1 className="jig-invtitle">Semantic inventory</h1>
              <p className="jig-invlede">
                {SEMANTIC_INVENTORY.length} groups, {total} labels, {missing.length === 0 ? "every one drawn" : `${missing.length} missing`}. The name under each
                label is what a call site asks for.
              </p>
            </header>
            {SEMANTIC_INVENTORY.map((row) => (
              <section key={row.group} className="jig-invrow">
                <h2 className="jig-invgroup">{row.group}</h2>
                <div className="jig-invitems">
                  {row.items.map((it) => (
                    <div key={it.label} className="jig-invitem" data-missing={resolveIcon(it.icon) ? undefined : ""}>
                      <span className="jig-invglyphs">
                        <Icon name={it.icon} size={16} />
                        <Icon name={it.icon} size={20} />
                      </span>
                      <span className="jig-invlabel">{it.label}</span>
                      <span className="jig-invname">{it.icon}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ))}
      </div>
    </main>
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
  const list = (names ?? "orbit,code,memory,apps").split(",").filter(Boolean);
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

/* —————————————————————————————— Pixels (for the nearest-neighbour proofs) —————————————————————————————— */

/** Every icon (or `names`) at one size on whole-pixel positions, for tools/pixels.mjs to capture and enlarge. `fit=0` draws the raw geometry. */
function Pixels({ names, size, fit }: { names?: string; size: number; fit: boolean }) {
  const list = names ? names.split(",").filter(Boolean) : Object.keys(ICONS);
  return (
    <main className="jig jig--pixels">
      <div className="jig-pixgrid">
        {list.map((n) => (
          <span key={n} className="jig-pixcell" data-name={n}>
            <Icon name={n} size={size} fit={fit} />
          </span>
        ))}
      </div>
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
    { label: "1.25 px (house)", px: 1.25 },
    { label: "1.5 px", px: 1.5 },
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
                      <Icon name={n} size={16} px={o.px} />
                      <span>{n.replace("-", " ")}</span>
                    </span>
                  ))}
                </div>
                <div className="jig-labstrip">
                  {LAB.map((n) => (
                    <Icon key={n} name={n} size={16} px={o.px} />
                  ))}
                  <span className="jig-labsep" />
                  {LAB.map((n) => (
                    <Icon key={n} name={n} size={20} px={o.px} />
                  ))}
                </div>
              </section>
            ))}
            <p className="jig-labcap">
              House ladder: 12 px draws {iconStrokePx(12)} px, 14 px draws {iconStrokePx(14)} px, 16 px draws {iconStrokePx(16)} px, 18 px draws {iconStrokePx(18)} px,
              20 px and up draw {iconStrokePx(20)} px. Every row is grid fitted.
            </p>
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
          <span className="jig-wordmark">Alevr</span>
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
          <a
            key={icon}
            href="#"
            className={DESTINATIONS.has(icon) ? "jig-row jicon-trigger jicon-hover" : "jig-row jicon-trigger"}
            aria-current={i === 3 ? "page" : undefined}
            onClick={(e) => e.preventDefault()}
          >
            <Icon name={icon} size={16} />
            <span>{label}</span>
          </a>
        ))}
        <p className="jig-sidelabel">
          Orbit
          <button type="button" className="jig-ib jig-ib--sm jicon-trigger" aria-label="Create agent">
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
          <p className="jig-placeholder">Ask Alevr, or type @ to add a file, app or agent</p>
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

/* —————————————————————————————— The framed shell and its menus (D-033) —————————————————————————————— */

/**
 * Every glyph the framed shell, the sidebar and the blurred layers ask for, in
 * place: the frame and its inset panel, the sticky header on the bar
 * material, a chat row's menu (S9), the account menu with its theme submenu,
 * the command palette (O7) and the Undo toast (O6), on the material over
 * busy content, light beside dark. The layout is a stand-in for the lead's
 * shell; the glyphs, sizes and inks are the real ones.
 */
function ShellContext({ theme }: { theme?: "light" | "dark" }) {
  return (
    <main className="jig jig--shell">
      <div className={theme ? "jig-one" : "jig-split"}>
        {(theme ? [theme] : (["light", "dark"] as const)).map((t) => (
          <div key={t} className="jn jig-pane jig-sh" data-theme={t}>
            <ShellBody />
          </div>
        ))}
      </div>
    </main>
  );
}

function MenuRow({ icon, label, kbd, checked, sub, danger, state }: { icon?: string; label: string; kbd?: string; checked?: boolean; sub?: boolean; danger?: boolean; state?: "active" }) {
  return (
    <span className="jig-sh-mrow" role="menuitem" data-danger={danger ? "" : undefined}>
      <span className="jig-sh-mlead">{icon ? <Icon name={icon} size={16} state={state} /> : null}</span>
      <span className="jig-sh-mtext">{label}</span>
      {kbd ? <kbd className="jig-sh-kbd">{kbd}</kbd> : null}
      {checked ? <Icon name="check" size={16} /> : null}
      {sub ? <Icon name="chevron-right" size={16} /> : null}
    </span>
  );
}

function ShellBody() {
  return (
    <div className="jig-sh-frame">
      <aside className="jig-sh-side">
        <div className="jig-sh-head">
          <span className="jig-wordmark">Alevr</span>
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
          ["new-chat", "New chat", "⇧⌘O"],
          ["search", "Search", "⌘K"],
          ["folder", "Projects"],
          ["library", "Library"],
          ["customize", "Customize"],
          ["orbit", "Orbit"],
          ["code", "Code"],
        ].map(([icon, label, kbd], i) => (
          <a
            key={icon}
            href="#"
            className={DESTINATIONS.has(icon) ? "jig-sh-row jicon-trigger jicon-hover" : "jig-sh-row jicon-trigger"}
            data-hover={i === 1 ? "" : undefined}
            onClick={(e) => e.preventDefault()}
          >
            <span className="jig-sh-lead">
              <Icon name={icon} size={16} />
            </span>
            <span className="jig-sh-text">{label}</span>
            {kbd && i === 1 ? <kbd className="jig-sh-kbd">{kbd}</kbd> : null}
          </a>
        ))}
        <p className="jig-sh-label">Pinned</p>
        <span className="jig-sh-row jig-sh-row--text" data-menu="">
          <span className="jig-sh-text">Northwind renewal</span>
          <span className="jig-sh-more jicon-trigger">
            <Icon name="more" size={16} />
          </span>
        </span>
        <span className="jig-sh-row jig-sh-row--text">
          <span className="jig-sh-text">Pricing page copy</span>
        </span>
        <p className="jig-sh-label">Recent</p>
        {["Q3 forecast against Stripe", "Why the sync worker drops", "Lisbon offsite venues"].map((r, i) => (
          <span key={r} className="jig-sh-row jig-sh-row--text" aria-current={i === 0 ? "page" : undefined}>
            <span className="jig-sh-text">{r}</span>
          </span>
        ))}
        <span className="jig-sh-grow" />
        <span className="jig-sh-row jig-sh-account" data-open="">
          <span className="jig-sh-avatar">LM</span>
          <span className="jig-sh-text">Liam Magnier</span>
          <Icon name="chevrons-up-down" size={16} />
        </span>
      </aside>

      <section className="jig-sh-panel">
        <header className="jig-sh-bar">
          <span className="jig-sh-title">
            Q3 forecast against Stripe
            <Icon name="chevron-down" size={16} />
          </span>
          <span className="jig-sh-grow" />
          <button type="button" className="jig-ib jicon-trigger" aria-label="Share">
            <Icon name="share" size={20} />
          </button>
          <button type="button" className="jig-ib jicon-trigger" aria-label="Open the document">
            <Icon name="panel-right" size={20} />
          </button>
          <button type="button" className="jig-ib jicon-trigger" aria-label="More">
            <Icon name="more" size={20} />
          </button>
        </header>
        <div className="jig-sh-content" aria-hidden>
          <p>Stripe booked 412 new annual plans in Q3, against 388 in the forecast.</p>
          <div className="jig-sh-cards">
            {[
              ["sheet", "Q3 Forecast.xlsx", "#1f8a4c"],
              ["deck", "Board update, October", "#c2581c"],
              ["document", "Renewal summary", "#2f6fd6"],
              ["design", "Pricing page, v3", "#8a4fd6"],
            ].map(([icon, label, tint]) => (
              <span key={label} className="jig-sh-card" style={{ "--tint": tint } as React.CSSProperties}>
                <Icon name={icon} size={20} />
                {label}
              </span>
            ))}
          </div>
          <p>Churn held at 2.1%. Two of the three accounts that paused asked to resume in March.</p>
        </div>

        <div className="jig-sh-palette jmat jicon-quiet" role="dialog" aria-label="Search">
          <div className="jig-sh-field">
            <Icon name="search" size={20} />
            <span className="jig-sh-ph">Search chats, files and people</span>
            <kbd className="jig-sh-kbd">esc</kbd>
          </div>
          <p className="jig-sh-mlabel">Recent</p>
          <MenuRow icon="history" label="Q3 forecast against Stripe" />
          <span className="jig-sh-mrow" data-active="">
            <span className="jig-sh-mlead">
              <Icon name="history" size={16} />
            </span>
            <span className="jig-sh-mtext">Why the sync worker drops cursors</span>
            <Icon name="enter" size={16} />
          </span>
          <MenuRow icon="folder" label="Atlas launch" />
          <MenuRow icon="document" label="Renewal summary, Northwind" />
        </div>

        <div className="jig-sh-toast" role="status">
          <Icon name="trash" size={16} />
          <span>Chat deleted</span>
          <button type="button" className="jig-sh-verb jicon-trigger">
            <Icon name="undo" size={16} />
            Undo
          </button>
        </div>
      </section>

      <div className="jig-sh-rowmenu jmat jicon-quiet" role="menu" aria-label="Chat">
        <MenuRow icon="rename" label="Rename" />
        <MenuRow icon="unpin" label="Unpin" />
        <MenuRow icon="move" label="Move to" sub />
        <MenuRow icon="fork" label="Branch" />
        <MenuRow icon="bell-off" label="Mute" />
        <span className="jig-sh-msep" />
        <MenuRow icon="trash" label="Delete" danger />
      </div>

      <div className="jig-sh-acctmenu jmat jicon-quiet" role="menu" aria-label="Account">
        <p className="jig-sh-mlabel">Liam Magnier, Pro plan</p>
        <MenuRow icon="settings" label="Settings" kbd="⌘," />
        <MenuRow icon="keyboard" label="Keyboard shortcuts" kbd="⌘/" />
        <span className="jig-sh-mrow" data-active="">
          <span className="jig-sh-mlead">
            <Icon name="contrast" size={16} />
          </span>
          <span className="jig-sh-mtext">Theme</span>
          <Icon name="chevron-right" size={16} />
        </span>
        <MenuRow icon="phone" label="Get the iPhone app" />
        <MenuRow icon="help" label="Help" />
        <span className="jig-sh-msep" />
        <MenuRow icon="sign-out" label="Sign out" />
      </div>
      <div className="jig-sh-submenu jmat jicon-quiet" role="menu" aria-label="Theme">
        <MenuRow icon="sun" label="Light" />
        <MenuRow icon="moon" label="Dark" />
        <MenuRow icon="contrast" label="Match the system" checked />
      </div>
    </div>
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
            className="jig-statebtn jicon-trigger jicon-press"
            data-name={p.name}
            aria-pressed={!!on[p.name]}
            onClick={() => setOn((s) => ({ ...s, [p.name]: !s[p.name] }))}
          >
            <Icon name={p.name} size={20} state={on[p.name] ? "active" : "rest"} />
            <span>{p.label}</span>
          </button>
        ))}
        <SwapDemo />
        <LiveDemo />
      </div>
    </main>
  );
}

function SwapDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <button type="button" className="jig-statebtn jicon-trigger jicon-press" data-name="name-turn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      <Icon name={open ? "chevron-down" : "chevron-right"} size={20} />
      <span>Name change turns</span>
    </button>
  );
}

/**
 * Dictation with live input: the mic swaps to the meter and the bars follow a
 * level signal (here a recorded-speech-like envelope, for 2.4 s, then it
 * stops, as a real take would). Under reduced motion the bars hold each value
 * for 250 ms and jump, with no easing.
 */
function LiveDemo() {
  const [levels, setLevels] = React.useState<number[] | null>(null);
  const start = () => {
    if (levels) return;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      if (t > 2.4) {
        setLevels(null);
        return;
      }
      const env = Math.min(1, t * 4) * Math.min(1, (2.4 - t) * 4);
      setLevels([0.9, 1.7, 2.3, 1.3, 0.7].map((f, i) => env * (0.35 + 0.3 * Math.sin(t * 7 * f + i * 1.3)) * [0.6, 0.85, 1, 0.8, 0.55][i]));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  return (
    <button type="button" className="jig-statebtn jicon-trigger jicon-press" data-name="live" aria-pressed={levels != null} onClick={start}>
      <Icon name="mic" size={20} state={levels ? "active" : "rest"} levels={levels ?? undefined} />
      <span>Listening, live levels</span>
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
              <button key={name} type="button" className="jig-reelbtn jicon-trigger jicon-hover jicon-press" data-name={name} aria-label={name}>
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
