"use client";

/**
 * CrewGallery: the character lab and every crew surface, addressable for
 * renders and review at /dev/design/juno/crew?scene=<scene>&theme=<light|dark>.
 *
 *   lab        everything below in one long page
 *   roster     the twelve example members
 *   matrix     every shape in every material
 *   sizes      shapes at 20 / 32 / 64 / 128 / 256 px
 *   eyes       the seven eye styles, brows, cheeks, mouths
 *   wear       the seventeen accessories, on different bodies
 *   colours    the palette, patterns and an uploaded image
 *   states     the six states at 64 and 128 px
 *   tokens     members as 20 px tokens in a sentence
 *   peek       a member's thread: the peek, its colour, a reaction, a setup change
 *   theming    each member's thread colours, light and dark
 *   people     the roster and header components
 *   editor     Customize (&tab=shape|colour|material|eyes|accessories)
 *   create     Add to crew (&step=who|look|ready)
 *   setup      the setup sheet and setup-change cards
 *   motion     a stage that plays every moment (for clips)
 *   perf       twelve live characters and the renderer's numbers
 *   one        one member (&id=&state=&size=)
 */

import * as React from "react";
import { Icon } from "../icons";
import {
  ACCESSORY_IDS,
  ACCESSORIES,
  BODY_SHAPES,
  EYE_LABEL,
  EYE_STYLES,
  MATERIAL_KINDS,
  MATERIAL_LABEL,
  SHAPE_LABEL,
  resemblesSomeoneElse,
  type AvatarConfig,
  type BodyShape,
} from "./avatar2";
import { CrewCreate, type CreateStep } from "./create";
import { AvatarEditor, type EditorTab } from "./editor";
import { CrewFace, CREW_STATE_LABEL, type CrewState, type LiveHandle } from "./face";
import { CREW, CREW_BY_ID, STATE_ORDER } from "./fixtures";
import { PALETTE, PALETTE_IDS } from "./palette";
import { CrewPeek } from "./peek";
import { MessageReaction } from "./reaction";
import { CrewHeader, CrewRoster } from "./roster";
import { SetupChangeCard, SetupSheet, type SetupData } from "./setup";
import { getCrewTheme, themeContrast } from "./theme";
import { SHORT_WORDS } from "./words";

export type GalleryScene =
  | "lab"
  | "all"
  | "roster"
  | "matrix"
  | "sizes"
  | "eyes"
  | "wear"
  | "colours"
  | "states"
  | "tokens"
  | "peek"
  | "theming"
  | "people"
  | "editor"
  | "create"
  | "setup"
  | "motion"
  | "perf"
  | "zoom"
  | "one";

export interface GalleryParams {
  id?: string;
  state?: string;
  size?: number;
  tab?: string;
  step?: string;
}

const still = (cfg: AvatarConfig, id: string) => ({ id, name: id, seed: cfg.seed, avatar: cfg });
const MIRA = CREW_BY_ID.mira;

function Sec({ title, note, children, wide }: { title: string; note?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className="jcg-sec" data-wide={wide ? "" : undefined}>
      <h2 className="jcg-h">{title}</h2>
      {note ? <p className="jcg-note">{note}</p> : null}
      {children}
    </section>
  );
}

/* ——————————————————————————— Lab ——————————————————————————— */

function Roster() {
  return (
    <Sec title="The crew" note="Twelve members of one account, each a character its person made their own. Modelled in Blender, drawn live in the browser.">
      <div className="jcg-roster">
        {CREW.map((m) => (
          <figure key={m.id} className="jcg-member">
            <CrewFace member={m} size={128} live={false} facing="front" />
            <figcaption>
              <span className="jcg-name">{m.name}</span>
              <span className="jcg-role">{m.role}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </Sec>
  );
}

function Matrix() {
  const base = MIRA.avatar;
  return (
    <Sec title="Shapes in each material" note="Twelve bodies, six materials. One colour and one face, so the form and the surface are what change.">
      <div className="jcg-matrix" style={{ gridTemplateColumns: `92px repeat(${MATERIAL_KINDS.length}, minmax(0, 1fr))` }}>
        <span />
        {MATERIAL_KINDS.map((k) => (
          <span key={k} className="jcg-colhead">
            {MATERIAL_LABEL[k]}
          </span>
        ))}
        {BODY_SHAPES.map((s) => (
          <React.Fragment key={s}>
            <span className="jcg-rowhead">{SHAPE_LABEL[s]}</span>
            {MATERIAL_KINDS.map((k) => (
              <span key={k} className="jcg-cell">
                <CrewFace member={still({ ...base, shape: s, stretch: 0, brows: "none", accessories: [], material: { ...base.material, kind: k } }, `${s}-${k}`)} size={88} live={false} facing="front" />
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
    </Sec>
  );
}

const SIZES = [20, 32, 64, 128, 256];
function Sizes() {
  const ids = ["mira", "scout", "nadia", "bram", "wren"];
  return (
    <Sec title="Every size" note="20 and 28 px are cached sprites with fewer fur shells and larger eyes; 32 px and up are live views of one shared renderer.">
      <div className="jcg-sizes">
        {ids.map((id) => (
          <div key={id} className="jcg-sizerow">
            {SIZES.map((s) => (
              <span key={s} className="jcg-sizecell">
                <CrewFace member={CREW_BY_ID[id]} size={s} live={false} facing="front" />
                {id === "mira" ? <span className="jcg-role">{s}</span> : null}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Sec>
  );
}

function Eyes() {
  const base = { ...MIRA.avatar, accessories: [], brows: "none" as const, cheeks: false };
  const bodies: [BodyShape, AvatarConfig["color"]][] = [
    ["pebble", "cloud"],
    ["orb", "sky"],
  ];
  return (
    <Sec title="Eyes and expression" note="Seven eye styles, always low and wide apart; they blink by squashing and close into a soft stroke. Brows, cheeks and a mouth where they help.">
      {bodies.map(([shape, color]) => (
        <div key={shape} className="jcg-strip">
          {EYE_STYLES.map((style) => (
            <figure key={style} className="jcg-state">
              <CrewFace member={still({ ...base, shape, color, stretch: 0, eyes: { ...base.eyes, style, size: 0.5 } }, `eye-${shape}-${style}`)} size={112} live={false} facing="front" />
              {shape === "pebble" ? <figcaption className="jcg-role">{EYE_LABEL[style]}</figcaption> : null}
            </figure>
          ))}
        </div>
      ))}
      <div className="jcg-strip">
        {(
          [
            ["No brows", { brows: "none" }],
            ["Soft", { brows: "soft" }],
            ["Arched", { brows: "arched" }],
            ["Straight", { brows: "straight" }],
            ["Cheeks", { cheeks: true }],
            ["Smile", { mouth: "smile", cheeks: true }],
            ["Little o", { mouth: "dot" }],
          ] as [string, Partial<AvatarConfig>][]
        ).map(([label, patch]) => (
          <figure key={label} className="jcg-state">
            <CrewFace member={still({ ...base, color: "apricot", shape: "mochi", eyes: { ...base.eyes, style: "oval" }, ...patch }, `expr-${label}`)} size={112} live={false} facing="front" />
            <figcaption className="jcg-role">{label}</figcaption>
          </figure>
        ))}
      </div>
    </Sec>
  );
}

function Wear({ only, size = 96 }: { only?: string; size?: number }) {
  const bodies: AvatarConfig[] = [
    { ...CREW_BY_ID.nadia.avatar, accessories: [], pattern: { kind: "none" } },
    { ...CREW_BY_ID.bram.avatar, accessories: [], shape: "drop", color: "lagoon" },
    { ...CREW_BY_ID.tomas.avatar, accessories: [], shape: "marshmallow", color: "raspberry", material: { kind: "velvet", furLength: 0.5, furDensity: 0.8 } },
  ];
  return (
    <Sec title="Accessories" note="Seventeen pieces, each modelled in its own material and fitted to the body from its anchors, so every piece sits on every shape.">
      {bodies.map((b, i) => (
        <div key={i} className="jcg-wear">
          {ACCESSORY_IDS.filter((id) => !only || only.split(",").includes(id)).map((id) => (
            <figure key={id} className="jcg-state">
              <CrewFace member={still({ ...b, accessories: [{ id }] }, `wear-${i}-${id}`)} size={size} live={false} facing="right" />
              {i === 0 ? <figcaption className="jcg-role">{ACCESSORIES[id].label}</figcaption> : null}
            </figure>
          ))}
        </div>
      ))}
    </Sec>
  );
}

/** A person's own image, drawn as a PNG in the browser (uploads are PNG, JPEG or WebP data URLs). */
function useSampleImage(): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f3e6cf";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 16; i++) {
      const x = (i % 4) * 64 + 32;
      const y = Math.floor(i / 4) * 64 + 32;
      g.fillStyle = i % 2 ? "#2e968d" : "#e4715e";
      g.beginPath();
      if (i % 3 === 0) g.arc(x, y, 18, 0, Math.PI * 2);
      else g.roundRect(x - 16, y - 16, 32, 32, 8);
      g.fill();
    }
    setUrl(c.toDataURL("image/png"));
  }, []);
  return url;
}

function Colours() {
  const image = useSampleImage();
  const base = { ...CREW_BY_ID.nadia.avatar, accessories: [] as AvatarConfig["accessories"], shape: "pebble" as const, mouth: "none" as const };
  return (
    <Sec title="Colour and pattern" note="Sixteen colours chosen as a set, any custom colour, two-tone, belly, spots and stripes, or a person's own image.">
      <div className="jcg-strip jcg-strip--wrap">
        {PALETTE_IDS.map((c) => (
          <figure key={c} className="jcg-state">
            <CrewFace member={still({ ...base, color: c }, `c-${c}`)} size={84} live={false} facing="front" />
            <figcaption className="jcg-role">{PALETTE[c].label}</figcaption>
          </figure>
        ))}
      </div>
      <div className="jcg-strip">
        {(
          [
            ["Two-tone", { pattern: { kind: "dip", color: "oat", scale: 0.5 } }],
            ["Belly", { pattern: { kind: "belly", color: "#fbf3e6", scale: 0.6 } }],
            ["Spots", { pattern: { kind: "spots", color: "cocoa", scale: 0.5 } }],
            ["Stripes", { pattern: { kind: "stripes", color: "cloud", scale: 0.4 } }],
            ["Own image", image ? { pattern: { kind: "image", assetUrl: image, tint: 0.1 } } : {}],
            ["Custom colour", { color: "#5a8f6e" }],
          ] as [string, Partial<AvatarConfig>][]
        ).map(([label, patch]) => (
          <figure key={label} className="jcg-state">
            <CrewFace member={still({ ...base, color: "marigold", ...patch }, `p-${label}`)} size={112} live={false} facing="front" />
            <figcaption className="jcg-role">{label}</figcaption>
          </figure>
        ))}
      </div>
    </Sec>
  );
}

function States({ sizes = [64, 128] }: { sizes?: number[] }) {
  return (
    <Sec title="States" note="The pose and the eyes carry the state; the words beside the face always say it. Never a dot or a pill.">
      {sizes.map((size) =>
        ["mira", "scout", "otto"].map((id) => (
          <div key={`${size}-${id}`} className="jcg-strip">
            {STATE_ORDER.map((s) => (
              <figure key={s} className="jcg-state" style={{ width: Math.max(96, size + 8) }}>
                <CrewFace member={CREW_BY_ID[id]} state={s} size={size} live={false} facing="right" />
                <figcaption className="jcg-role">
                  {CREW_BY_ID[id].name}, {CREW_STATE_LABEL[s].toLowerCase()}
                </figcaption>
              </figure>
            ))}
          </div>
        )),
      )}
    </Sec>
  );
}

function Token({ id, state = "available" }: { id: string; state?: CrewState }) {
  const m = CREW_BY_ID[id];
  return (
    <span className="jcg-token">
      <CrewFace member={m} state={state} size={20} facing="front" />
      {m.name}
    </span>
  );
}

function Tokens() {
  return (
    <Sec title="As tokens" note="20 px sprites in neutral chips, the way they sit in the composer and in sentences.">
      <p className="jcg-sentence">
        Ask <Token id="mira" /> to send the renewal terms, and have <Token id="otto" /> check them against <Token id="sol" />
        ’s redlines before Thursday.
      </p>
      <p className="jcg-sentence">
        <Token id="scout" state="thinking" /> <Token id="rhea" /> <Token id="ines" state="paused" /> <Token id="tomas" state="offline" /> <Token id="nadia" /> <Token id="bram" state="working" />{" "}
        <Token id="wren" /> <Token id="kit" state="thinking" /> <Token id="pia" state="working" />
      </p>
      <div className="jcg-rows">
        {CREW.slice(0, 6).map((m) => (
          <div key={m.id} className="jcg-row">
            <CrewFace member={m} state={m.state} size={20} facing="right" />
            <span className="jcg-row__name">{m.name}</span>
            <span className="jcg-row__state" data-attn={m.state === "waiting" ? "" : undefined}>
              {SHORT_WORDS[m.state]}
            </span>
          </div>
        ))}
      </div>
    </Sec>
  );
}

/* ——————————————————————————— Product ——————————————————————————— */

function ThreadMock({ id = "mira", state: initial = "thinking" as CrewState, react = true, change = true }: { id?: string; state?: CrewState; react?: boolean; change?: boolean }) {
  const m = CREW_BY_ID[id];
  const theme = getCrewTheme(m.avatar);
  const [state, setState] = React.useState<CrewState>(initial);
  const [cheer, setCheer] = React.useState(0);
  return (
    <div className="jcg-thread" style={theme.style as React.CSSProperties}>
      <CrewPeek member={m} state={state} cheer={cheer} />
      <div className="jcg-msgs">
        <div className="jcg-mine">Can you pull the Halvorsen renewal terms and check them against last year?</div>
        <div className="jcg-theirs">
          The renewal keeps the 3-year term and raises the seat price from $38 to $41. Two clauses changed: the uptime credit is now 5% per hour, and termination needs 60 days’ notice instead of 30.
        </div>
        {change ? (
          <SetupChangeCard
            member={m}
            change={{
              title: "Send me a renewal digest every Monday at 9:00",
              rows: [
                { label: "Routine", before: "None", after: "Mondays at 9:00" },
                { label: "Notifies", before: "Only decisions", after: "Decisions and the digest" },
              ],
              affects: "Adds one routine. It reads Salesforce, which it already can.",
            }}
          />
        ) : null}
        <div className="jcg-mine jcg-mine--react">
          Perfect, thank you {m.name}
          {react ? (
            <span className="jcg-react">
              <MessageReaction member={m} />
            </span>
          ) : null}
        </div>
      </div>
      <div className="jcg-compose">
        <span className="jcg-compose__text">Reply to {m.name}…</span>
        <button type="button" className="jcg-send" aria-label="Send">
          <Icon name="send" size={16} />
        </button>
      </div>
      <div className="jcg-controls">
        {STATE_ORDER.map((s) => (
          <button key={s} type="button" className="jce-chip" aria-pressed={state === s} onClick={() => setState(s)}>
            {CREW_STATE_LABEL[s]}
          </button>
        ))}
        <button type="button" className="jce-chip" onClick={() => setCheer((c) => c + 1)}>
          Thank
        </button>
      </div>
    </div>
  );
}

function Peek() {
  return (
    <Sec title="In its own thread" note="The character looks over the thread's top edge; its name and state sit under the edge in words. Its colour themes the person's bubbles and the send button.">
      <div className="jcg-threads">
        <ThreadMock id="mira" state="thinking" />
        <ThreadMock id="scout" state="waiting" change={false} />
      </div>
    </Sec>
  );
}

function Theming() {
  return (
    <Sec title="Thread colour" note="Each member's colour as the person's bubble and the send disc. Text contrast is measured: 4.5:1 or better on every bubble and disc, in both themes.">
      <div className="jcg-themes">
        {CREW.map((m) => {
          const t = getCrewTheme(m.avatar);
          const c = themeContrast(t);
          return (
            <div key={m.id} className="jcg-theme" style={t.style as React.CSSProperties}>
              <CrewFace member={m} size={24} facing="front" />
              <span className="jcg-theme__bubble">Thanks, {m.name}</span>
              <span className="jcg-send" aria-hidden="true">
                <Icon name="send" size={16} />
              </span>
              <span className="jcg-theme__ratio num">
                {c.light.bubbleText.toFixed(1)} / {c.dark.bubbleText.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
    </Sec>
  );
}

function People() {
  const [arrived, setArrived] = React.useState<string | undefined>(undefined);
  return (
    <>
      <Sec title="Roster" note="Live characters that follow the pointer and blink when you arrive over them, and cost nothing while you are elsewhere.">
        <CrewRoster members={CREW} onAdd={() => setArrived(arrived ? undefined : "pia")} arrivedId={arrived} />
      </Sec>
      <Sec title="Header">
        <div className="jcg-headers">
          {(["mira", "otto", "scout", "ines"] as const).map((id) => (
            <CrewHeader key={id} member={CREW_BY_ID[id]} state={CREW_BY_ID[id].state} words={id === "otto" ? "Reconciling invoices, 206 of 214" : undefined} onSetup={() => undefined} />
          ))}
        </div>
      </Sec>
    </>
  );
}

function Editor({ tab }: { tab?: string }) {
  const [cfg, setCfg] = React.useState<AvatarConfig>(MIRA.avatar);
  const [name, setName] = React.useState("Mira");
  return (
    <Sec title={`Customize ${name || "Mira"}`}>
      <AvatarEditor value={cfg} onChange={setCfg} name={name} onName={setName} tab={(tab as EditorTab) ?? "shape"} onSave={() => undefined} onCancel={() => setCfg(MIRA.avatar)} />
    </Sec>
  );
}

function Create({ step }: { step?: string }) {
  const s = (step as CreateStep) ?? "who";
  return (
    <section className="jcg-sec">
      <CrewCreate
        step={s}
        initial={
          s === "who"
            ? { name: "Nova", role: "Product analytics", seed: "nova-3c1d" }
            : {
                name: "Nova",
                role: "Product analytics",
                mission: "Every Monday, summarise last week's signups and flag anything unusual in activation.",
                seed: "nova-3c1d",
                avatar: { ...CREW_BY_ID.scout.avatar, seed: "nova-3c1d", shape: "cub", color: "lagoon", eyes: { ...CREW_BY_ID.scout.avatar.eyes, style: "oval" }, accessories: [{ id: "beanie", color: "marigold" }], cheeks: true },
              }
        }
      />
    </section>
  );
}

const MIRA_SETUP: SetupData = {
  mission: "Look after renewals for the Halvorsen, Brightline and Okafor accounts: draft terms, chase signatures, and tell me what changed.",
  skills: ["Contract summaries", "Renewal checklist", "Pricing rules 2026"],
  apps: [
    { id: "sf", name: "Salesforce", access: "Read accounts and opportunities" },
    { id: "gmail", name: "Gmail", access: "Draft replies, never send without asking" },
    { id: "drive", name: "Google Drive", access: "Read the Renewals folder" },
  ],
  routines: [
    { title: "Renewal digest", when: "Mondays at 9:00" },
    { title: "Signature chase", when: "Weekdays at 14:00" },
  ],
  notify: "Only when it needs a decision",
  approvals: "Asks before sending email, posting, or changing a record",
  memory: "Remembers account contacts and your pricing preferences. 14 notes.",
};

function Setup() {
  const m = MIRA;
  const after: AvatarConfig = { ...m.avatar, material: { kind: "velvet", furLength: 0.5, furDensity: 0.8 }, accessories: [{ id: "headband", color: "cloud" }] };
  return (
    <Sec title="Setup">
      <div className="jcg-setup">
        <div className="jcg-sheet">
          <SetupSheet member={m} data={MIRA_SETUP} onClose={() => undefined} onCustomize={() => undefined} />
        </div>
        <div className="jcg-cards">
          <SetupChangeCard
            member={m}
            change={{
              title: "Connect Linear to file renewal blockers",
              rows: [
                { label: "Apps", before: "Salesforce, Gmail, Drive", after: "adds Linear" },
                { label: "Can", before: "Read", after: "Create issues in Renewals" },
              ],
              affects: "Widens access: Mira could create issues in one Linear team.",
              widens: true,
            }}
          />
          <SetupChangeCard
            member={m}
            status="applied"
            change={{ title: "Only notify me when you need a decision", rows: [{ label: "Notifies", before: "Every update", after: "Decisions only" }], affects: "Narrows what reaches you. Undo any time." }}
          />
          <SetupChangeCard member={m} change={{ title: "Wear the velvet coat and a headband", rows: [], affects: "Only how Mira looks.", look: { before: m.avatar, after } }} />
        </div>
      </div>
    </Sec>
  );
}

/* ——————————————————————————— Motion stage ——————————————————————————— */

declare global {
  interface Window {
    __crewStage?: {
      setState(s: CrewState): void;
      cheer(): void;
      hop(): void;
      arrive(): void;
      blink(): void;
      level(l: number): void;
      handle(): LiveHandle | null;
      setMember(id: string): void;
    };
  }
}

function Motion({ id }: { id?: string }) {
  const [mid, setMid] = React.useState(id ?? "mira");
  const m = CREW_BY_ID[mid] ?? MIRA;
  const [state, setState] = React.useState<CrewState>("available");
  const [cheer, setCheer] = React.useState(0);
  const [hop, setHop] = React.useState(0);
  const [level, setLevel] = React.useState(0);
  const [key, setKey] = React.useState(0);
  const handle = React.useRef<LiveHandle | null>(null);
  React.useEffect(() => {
    window.__crewStage = {
      setState,
      cheer: () => setCheer((c) => c + 1),
      hop: () => setHop((c) => c + 1),
      arrive: () => setKey((k) => k + 1),
      blink: () => handle.current?.blink(),
      level: setLevel,
      handle: () => handle.current,
      setMember: setMid,
    };
  }, []);
  return (
    <div className="jcg-motion">
      <div className="jcg-motion__stage">
        <CrewFace key={`${mid}-${key}`} member={m} state={state} size={320} facing="front" focused idle arrive={key > 0} cheer={cheer} hop={hop} level={level} onHandle={(h) => (handle.current = h)} />
        <span className="jcg-motion__words" data-attn={state === "waiting" ? "" : undefined}>
          {m.name} <span>{SHORT_WORDS[state]}</span>
        </span>
      </div>
      <div className="jcg-controls">
        {STATE_ORDER.map((s) => (
          <button key={s} type="button" className="jce-chip" aria-pressed={state === s} onClick={() => setState(s)}>
            {CREW_STATE_LABEL[s]}
          </button>
        ))}
        <button type="button" className="jce-chip" onClick={() => setKey((k) => k + 1)}>
          Arrive
        </button>
        <button type="button" className="jce-chip" onClick={() => setCheer((c) => c + 1)}>
          Thank
        </button>
        <button type="button" className="jce-chip" onClick={() => handle.current?.blink()}>
          Blink
        </button>
        <label className="jcg-level">
          Voice
          <input type="range" min={0} max={1} step={0.01} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
        </label>
      </div>
    </div>
  );
}

/* ——————————————————————————— Performance ——————————————————————————— */

function Perf() {
  const [stats, setStats] = React.useState<string>("Waiting for the renderer…");
  React.useEffect(() => {
    let last = { frames: 0, renders: 0 };
    const t = setInterval(() => {
      const e = (window as unknown as { __jcEngine?: { stats: { frames: number; renders: number; sprites: number; busyFrames: number; lastFrameMs: number }; info(): Record<string, number> } }).__jcEngine;
      if (!e) return;
      const s = e.stats;
      const i = e.info();
      setStats(
        `Busy frames last second: ${s.busyFrames}. Renders/s: ${s.renders - last.renders}. Live views: ${i.views}. Sprites drawn: ${s.sprites}. Last frame: ${s.lastFrameMs.toFixed(1)} ms. Programs: ${i.programs}.`,
      );
      last = { frames: s.frames, renders: s.renders };
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Sec title="Performance" note="Twelve live characters. Move the pointer across them: they follow it at 60 fps. Leave them: the renderer stops (zero busy frames).">
      <p className="jcg-perf num" data-perf>
        {stats}
      </p>
      <CrewRoster members={CREW} size={88} />
    </Sec>
  );
}

/* ——————————————————————————— One ——————————————————————————— */

function One({ params }: { params: GalleryParams }) {
  const m = CREW.find((c) => c.id === params.id) ?? MIRA;
  const states = params.state ? [params.state as CrewState] : STATE_ORDER;
  return (
    <div className="jcg-strip">
      {states.map((s) => (
        <CrewFace key={s} member={m} state={s} size={params.size ?? 320} live={false} />
      ))}
    </div>
  );
}

function Guard() {
  const clashes = CREW.filter((m) => resemblesSomeoneElse(m.avatar)).map((m) => m.name);
  return clashes.length ? <p className="jce-error">Resembles someone else: {clashes.join(", ")}</p> : null;
}

export function CrewGallery({ scene = "lab", params = {} }: { scene?: GalleryScene; params?: GalleryParams }) {
  const lab = scene === "lab" || scene === "all";
  return (
    <div className="jcg">
      <Guard />
      {scene === "one" && <One params={params} />}
      {scene === "zoom" && <One params={{ ...params, size: params.size ?? 320 }} />}
      {(lab || scene === "roster") && <Roster />}
      {(lab || scene === "states") && <States />}
      {(lab || scene === "sizes") && <Sizes />}
      {(lab || scene === "eyes") && <Eyes />}
      {(lab || scene === "wear") && <Wear only={params.id} size={params.size} />}
      {(lab || scene === "colours") && <Colours />}
      {(lab || scene === "matrix") && <Matrix />}
      {(lab || scene === "tokens") && <Tokens />}
      {scene === "peek" && <Peek />}
      {scene === "theming" && <Theming />}
      {scene === "people" && <People />}
      {scene === "editor" && <Editor tab={params.tab} />}
      {scene === "create" && <Create step={params.step} />}
      {scene === "setup" && <Setup />}
      {scene === "motion" && <Motion id={params.id} />}
      {scene === "perf" && <Perf />}
    </div>
  );
}
