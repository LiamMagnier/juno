"use client";

/**
 * AvatarEditor: "Customize Mira".
 *
 * A live character on the left (drag it round; it blinks when you take hold,
 * wobbles home when you let go, hops when it puts something on, boings at
 * every other change), and five tabs on the right: Shape, Colour, Material,
 * Eyes, Accessories. Every choice is shown as the character itself wearing
 * it, drawn by the shared renderer (cached sprites), never a swatch standing
 * in for a look. Surprise me composes a whole character; Undo walks back one
 * change at a time; Save keeps it.
 *
 * Everything edits one small serialisable AvatarConfig v2, so Mac and iPhone
 * render exactly the same character.
 */

import * as React from "react";
import { Icon } from "../icons";
import {
  ACCESSORIES,
  ACCESSORY_IDS,
  BODY_SHAPES,
  BROWS,
  BROW_LABEL,
  EYE_LABEL,
  EYE_STYLES,
  MATERIAL_KINDS,
  MATERIAL_LABEL,
  MAX_ACCESSORIES,
  MOUTHS,
  MOUTH_LABEL,
  PATTERN_LABEL,
  SHAPE_LABEL,
  defaultPatternColor,
  describeAvatar,
  removeAccessory,
  surpriseAvatar,
  wearAccessory,
  type AccessoryId,
  type AccessorySlot,
  type AvatarConfig,
  type AvatarPattern,
  type PatternKind,
} from "./avatar2";
import { CrewFace, type LiveHandle } from "./face";
import { PALETTE, PALETTE_IDS, colorHex, colorLabel, isHex, type ColorValue } from "./palette";
import "./crew-ui.css";

export type EditorTab = "shape" | "colour" | "material" | "eyes" | "accessories";
const TABS: { id: EditorTab; label: string }[] = [
  { id: "shape", label: "Shape" },
  { id: "colour", label: "Colour" },
  { id: "material", label: "Material" },
  { id: "eyes", label: "Eyes" },
  { id: "accessories", label: "Accessories" },
];

export interface AvatarEditorProps {
  value: AvatarConfig;
  onChange: (cfg: AvatarConfig) => void;
  name: string;
  onName?: (name: string) => void;
  /** Initial tab (renders and deep links). */
  tab?: EditorTab;
  onSave?: (cfg: AvatarConfig, name: string) => void;
  onCancel?: () => void;
  /** Hide the editor's own footer (the creation flow brings its own). */
  bare?: boolean;
  /** Play the arrival on first show (a brand new member). */
  arrive?: boolean;
  /** Preview size. */
  size?: number;
  className?: string;
}

type Change = "shape" | "colour" | "material" | "eyes" | "wear" | "take-off" | "surprise";

export function AvatarEditor({ value, onChange, name, onName, tab: initialTab = "shape", onSave, onCancel, bare, arrive, size = 264, className }: AvatarEditorProps) {
  const [tab, setTab] = React.useState<EditorTab>(initialTab);
  const [history, setHistory] = React.useState<AvatarConfig[]>([]);
  const [spins, setSpins] = React.useState(0);
  const handle = React.useRef<LiveHandle | null>(null);
  const cfg = value;
  const member = React.useMemo(() => ({ id: "editing", name: name || "Unnamed", seed: cfg.seed, avatar: cfg }), [cfg, name]);

  const commit = (next: AvatarConfig, change: Change, push = true) => {
    if (push) setHistory((h) => [...h.slice(-39), cfg]);
    onChange(next);
    const h = handle.current;
    if (!h) return;
    // The character answers the change.
    if (change === "wear") setTimeout(() => h.hop(), 40);
    else if (change === "eyes") setTimeout(() => h.blink(), 60);
  };
  const set = (patch: Partial<AvatarConfig>, change: Change, push = true) => commit({ ...cfg, ...patch }, change, push);
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      onChange(h[h.length - 1]);
      return h.slice(0, -1);
    });
  };
  const surprise = () => {
    const n = spins + 1;
    setSpins(n);
    commit(surpriseAvatar(`${cfg.seed}:${n}`), "surprise");
  };

  /* Drag to turn. */
  const drag = React.useRef<{ x: number; y: number; t: number; vx: number; vy: number; lx: number; ly: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0, lx: e.clientX, ly: e.clientY };
    handle.current?.blink();
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.t);
    d.vx = (e.clientX - d.lx) / dt;
    d.vy = (e.clientY - d.ly) / dt;
    d.lx = e.clientX;
    d.ly = e.clientY;
    d.t = now;
    const yaw = Math.max(-1.5, Math.min(1.5, (e.clientX - d.x) * 0.012));
    const pitch = Math.max(-0.35, Math.min(0.35, (e.clientY - d.y) * 0.004));
    handle.current?.drag(yaw, pitch);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    handle.current?.release(d.vx * 12, d.vy * 4);
  };

  const slotsWorn = cfg.accessories.length;

  return (
    <div className={className ? `jce ${className}` : "jce"}>
      <div className="jce__preview">
        <div
          className="jce__stage"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          role="img"
          aria-label={`${name || "New member"}: ${describeAvatar(cfg)}. Drag to turn.`}
        >
          <CrewFace member={member} state="available" size={size} facing="front" focused morph forceLive arrive={arrive} onHandle={(h) => (handle.current = h)} />
        </div>
        {onName ? (
          <input className="jce__name" value={name} onChange={(e) => onName(e.target.value)} placeholder="Name" aria-label="Name" maxLength={24} spellCheck={false} />
        ) : (
          <div className="jce__name" aria-hidden="true">
            {name}
          </div>
        )}
        <p className="jce__desc">{describeAvatar(cfg)}</p>
        <div className="jce__tools">
          <button type="button" className="jb jb--secondary jb--sm jicon-trigger" onClick={surprise}>
            <Icon name="retry" size={16} />
            Surprise me
          </button>
          <button type="button" className="jb jb--ghost jb--sm" onClick={undo} disabled={!history.length}>
            Undo
          </button>
        </div>
      </div>

      <div className="jce__panel">
        <div className="jseg jce__tabs" role="tablist" aria-label="Customize">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="jseg__opt" aria-selected={tab === t.id} aria-controls={`jce-${t.id}`} onClick={() => setTab(t.id)}>
              <span className="jseg__label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="jce__body" role="tabpanel" id={`jce-${tab}`} key={tab}>
          {tab === "shape" && <ShapeTab cfg={cfg} set={set} />}
          {tab === "colour" && <ColourTab cfg={cfg} set={set} />}
          {tab === "material" && <MaterialTab cfg={cfg} set={set} />}
          {tab === "eyes" && <EyesTab cfg={cfg} set={set} />}
          {tab === "accessories" && (
            <AccessoriesTab
              cfg={cfg}
              worn={slotsWorn}
              wear={(id) => commit({ ...cfg, accessories: wearAccessory(cfg.accessories, id) }, "wear")}
              takeOff={(id) => commit({ ...cfg, accessories: removeAccessory(cfg.accessories, id) }, "take-off")}
              colour={(id, c) => commit({ ...cfg, accessories: cfg.accessories.map((a) => (a.id === id ? (c ? { id, color: c } : { id }) : a)) }, "colour")}
            />
          )}
        </div>

        {bare ? null : (
          <footer className="jce__foot">
            {onCancel ? (
              <button type="button" className="jb jb--ghost" onClick={onCancel}>
                Cancel
              </button>
            ) : null}
            <button type="button" className="jb jb--primary" onClick={() => onSave?.(cfg, name)}>
              Save
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

/* ——————————————————————————— Pieces ——————————————————————————— */

type Setter = (patch: Partial<AvatarConfig>, change: Change, push?: boolean) => void;

function Thumb({ cfg, label, selected, onPick, size = 60, sub }: { cfg: AvatarConfig; label: string; selected: boolean; onPick: () => void; size?: number; sub?: string }) {
  return (
    <button type="button" className="jce-opt" aria-pressed={selected} onClick={onPick}>
      <span className="jce-opt__pic">
        <CrewFace member={{ id: "t", name: label, seed: cfg.seed, avatar: cfg }} size={size} live={false} facing="front" />
      </span>
      <span className="jce-opt__label">{label}</span>
      {sub ? <span className="jce-opt__sub">{sub}</span> : null}
    </button>
  );
}

function Slider({ label, value, min = 0, max = 1, step = 0.01, left, right, onChange, onCommit }: { label: string; value: number; min?: number; max?: number; step?: number; left: string; right: string; onChange: (v: number) => void; onCommit: () => void }) {
  return (
    <label className="jce-slider">
      <span className="jce-slider__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onCommit}
        onKeyDown={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key.startsWith("Page")) onCommit();
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--v": `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
      <span className="jce-slider__ends">
        <span>{left}</span>
        <span>{right}</span>
      </span>
    </label>
  );
}

/** Sliders push one undo step when a drag starts, then update without pushing. */
function useSliderCommit(set: Setter) {
  const started = React.useRef(false);
  return {
    start: (patch: Partial<AvatarConfig>) => {
      if (!started.current) {
        started.current = true;
        set(patch, "shape", true);
        const end = () => {
          started.current = false;
          window.removeEventListener("pointerup", end);
          window.removeEventListener("keyup", end);
        };
        window.addEventListener("pointerup", end);
        window.addEventListener("keyup", end);
      }
    },
  };
}

function Group({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="jce-group">
      <header className="jce-group__head">
        <h3 className="jce-group__title">{title}</h3>
        {aside ? <span className="jce-group__aside">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

function ShapeTab({ cfg, set }: { cfg: AvatarConfig; set: Setter }) {
  const s = useSliderCommit(set);
  return (
    <>
      <Group title="Body">
        <div className="jce-grid jce-grid--5">
          {BODY_SHAPES.map((shape) => (
            <Thumb key={shape} cfg={{ ...cfg, shape, accessories: [] }} label={SHAPE_LABEL[shape]} selected={cfg.shape === shape} onPick={() => set({ shape }, "shape")} />
          ))}
        </div>
      </Group>
      <Group title="Proportions">
        <Slider label="Height" value={cfg.stretch} min={-1} max={1} left="Rounder" right="Taller" onCommit={() => s.start({})} onChange={(v) => set({ stretch: Math.round(v * 100) / 100 }, "shape", false)} />
      </Group>
    </>
  );
}

function Swatch({ color, selected, label, onPick, size = 28 }: { color: string; selected: boolean; label: string; onPick: () => void; size?: number }) {
  return (
    <button type="button" className="jce-swatch" aria-pressed={selected} aria-label={label} title={label} onClick={onPick} style={{ "--sw": color, width: size + 8, height: size + 8 } as React.CSSProperties}>
      <span style={{ width: size, height: size }} />
    </button>
  );
}

const PATTERNS: PatternKind[] = ["none", "dip", "belly", "spots", "stripes", "image"];

function ColourTab({ cfg, set }: { cfg: AvatarConfig; set: Setter }) {
  const custom = isHex(cfg.color) ? cfg.color : null;
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const patColor = cfg.pattern.kind !== "none" && cfg.pattern.kind !== "image" ? cfg.pattern.color : null;
  const pickPattern = (kind: PatternKind) => {
    if (kind === "image") {
      fileRef.current?.click();
      return;
    }
    const p: AvatarPattern = kind === "none" ? { kind: "none" } : { kind, color: patColor ?? defaultPatternColor(cfg.color), scale: cfg.pattern.kind !== "none" && cfg.pattern.kind !== "image" ? cfg.pattern.scale : 0.5 };
    set({ pattern: p }, "colour");
  };
  const onFile = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setError("Use a PNG, JPEG or WebP image.");
    if (f.size > 8 * 1024 * 1024) return setError("That image is over 8 MB.");
    try {
      const url = await downscale(f, 512);
      set({ pattern: { kind: "image", assetUrl: url, tint: 0.25 } }, "colour");
    } catch {
      setError("That image could not be read.");
    }
  };
  return (
    <>
      <Group title="Colour" aside={colorLabel(cfg.color)}>
        <div className="jce-swatches">
          {PALETTE_IDS.map((id) => (
            <Swatch key={id} color={PALETTE[id].hex} label={PALETTE[id].label} selected={cfg.color === id} onPick={() => set({ color: id }, "colour")} />
          ))}
          <label className="jce-swatch jce-swatch--custom" aria-pressed={!!custom} title="Custom colour" style={{ "--sw": custom ?? "transparent" } as React.CSSProperties}>
            <span>{custom ? null : <Icon name="plus" size={16} />}</span>
            <input type="color" aria-label="Custom colour" value={custom ?? colorHex(cfg.color)} onChange={(e) => set({ color: e.target.value.toLowerCase() as ColorValue }, "colour")} />
          </label>
        </div>
      </Group>
      <Group title="Pattern" aside={PATTERN_LABEL[cfg.pattern.kind]}>
        <div className="jce-grid jce-grid--6">
          {PATTERNS.map((kind) => {
            const preview: AvatarPattern =
              kind === "none" ? { kind: "none" } : kind === "image" ? (cfg.pattern.kind === "image" ? cfg.pattern : { kind: "none" }) : { kind, color: patColor ?? defaultPatternColor(cfg.color), scale: 0.5 };
            return <Thumb key={kind} cfg={{ ...cfg, pattern: preview, accessories: [] }} label={PATTERN_LABEL[kind]} selected={cfg.pattern.kind === kind} onPick={() => pickPattern(kind)} size={52} />;
          })}
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        {error ? (
          <p className="jce-error" role="alert">
            {error}
          </p>
        ) : null}
        {patColor ? (
          <div className="jce-swatches jce-swatches--sm">
            {[defaultPatternColor(cfg.color), ...PALETTE_IDS.filter((p) => p !== cfg.color)].slice(0, 11).map((c) => (
              <Swatch key={c} color={colorHex(c)} label={c.startsWith("#") ? "Cream" : PALETTE[c as keyof typeof PALETTE].label} size={22} selected={patColor === c} onPick={() => cfg.pattern.kind !== "none" && cfg.pattern.kind !== "image" && set({ pattern: { ...cfg.pattern, color: c } }, "colour")} />
            ))}
          </div>
        ) : null}
        {cfg.pattern.kind === "image" ? (
          <Slider label="Blend with colour" value={cfg.pattern.tint} left="Image" right="Colour" onCommit={() => undefined} onChange={(v) => cfg.pattern.kind === "image" && set({ pattern: { ...cfg.pattern, tint: v } }, "colour", false)} />
        ) : null}
      </Group>
    </>
  );
}

function MaterialTab({ cfg, set }: { cfg: AvatarConfig; set: Setter }) {
  const s = useSliderCommit(set);
  return (
    <>
      <Group title="Material">
        <div className="jce-grid jce-grid--3">
          {MATERIAL_KINDS.map((kind) => (
            <Thumb key={kind} cfg={{ ...cfg, material: { ...cfg.material, kind }, accessories: [] }} label={MATERIAL_LABEL[kind]} selected={cfg.material.kind === kind} onPick={() => set({ material: { ...cfg.material, kind } }, "material")} size={72} />
          ))}
        </div>
      </Group>
      {cfg.material.kind === "plush" ? (
        <Group title="Fur">
          <Slider label="Length" value={cfg.material.furLength} left="Short" right="Fluffy" onCommit={() => s.start({})} onChange={(v) => set({ material: { ...cfg.material, furLength: v } }, "material", false)} />
          <Slider label="Density" value={cfg.material.furDensity} left="Airy" right="Dense" onCommit={() => s.start({})} onChange={(v) => set({ material: { ...cfg.material, furDensity: v } }, "material", false)} />
        </Group>
      ) : null}
    </>
  );
}

function Seg<T extends string>({ label, value, options, render, onPick }: { label: string; value: T; options: readonly T[]; render: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <div className="jce-segrow">
      <span className="jce-slider__label">{label}</span>
      <div className="jseg jseg--sm" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" className="jseg__opt" aria-checked={value === o} onClick={() => onPick(o)}>
            {value === o ? <span className="jseg__thumb" aria-hidden="true" /> : null}
            <span className="jseg__label">{render(o)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EyesTab({ cfg, set }: { cfg: AvatarConfig; set: Setter }) {
  const s = useSliderCommit(set);
  return (
    <>
      <Group title="Eyes" aside={EYE_LABEL[cfg.eyes.style]}>
        <div className="jce-grid jce-grid--4">
          {EYE_STYLES.map((style) => (
            <Thumb key={style} cfg={{ ...cfg, eyes: { ...cfg.eyes, style }, accessories: cfg.accessories.filter((a) => ACCESSORIES[a.id].slot !== "eyes") }} label={EYE_LABEL[style]} selected={cfg.eyes.style === style} onPick={() => set({ eyes: { ...cfg.eyes, style } }, "eyes")} size={64} />
          ))}
        </div>
      </Group>
      <Group title="Placement">
        <Slider label="Size" value={cfg.eyes.size} left="Small" right="Large" onCommit={() => s.start({})} onChange={(v) => set({ eyes: { ...cfg.eyes, size: v } }, "eyes", false)} />
        <Slider label="Spacing" value={cfg.eyes.gap} left="Close" right="Apart" onCommit={() => s.start({})} onChange={(v) => set({ eyes: { ...cfg.eyes, gap: v } }, "eyes", false)} />
        <Slider label="Height" value={cfg.eyes.y} left="Low" right="High" onCommit={() => s.start({})} onChange={(v) => set({ eyes: { ...cfg.eyes, y: v } }, "eyes", false)} />
      </Group>
      <Group title="Expression">
        <Seg label="Brows" value={cfg.brows} options={BROWS} render={(v) => BROW_LABEL[v].replace("No brows", "None")} onPick={(brows) => set({ brows }, "eyes")} />
        <Seg label="Mouth" value={cfg.mouth} options={MOUTHS} render={(v) => MOUTH_LABEL[v].replace("No mouth", "None")} onPick={(mouth) => set({ mouth }, "eyes")} />
        <div className="jce-segrow">
          <span className="jce-slider__label">Cheeks</span>
          <button type="button" role="switch" className="jswitch" aria-checked={cfg.cheeks} aria-label="Cheeks" onClick={() => set({ cheeks: !cfg.cheeks }, "eyes")} />
        </div>
      </Group>
    </>
  );
}

const SLOT_TITLE: Record<AccessorySlot, string> = { head: "On the head", pin: "Pinned", eyes: "Eyewear", ears: "Ears", neck: "Round the neck" };
const SLOT_ORDER: AccessorySlot[] = ["head", "eyes", "ears", "neck", "pin"];
const ACC_COLOURS: ColorValue[] = ["graphite", "cloud", "oat", "coral", "raspberry", "marigold", "moss", "lagoon", "cobalt", "lilac", "cocoa"];

function AccessoriesTab({ cfg, worn, wear, takeOff, colour }: { cfg: AvatarConfig; worn: number; wear: (id: AccessoryId) => void; takeOff: (id: AccessoryId) => void; colour: (id: AccessoryId, c: ColorValue | null) => void }) {
  const wornIds = new Set(cfg.accessories.map((a) => a.id));
  const last = cfg.accessories[cfg.accessories.length - 1];
  return (
    <>
      <p className="jce-note">
        {worn === 0 ? `Up to ${MAX_ACCESSORIES}, one per place.` : `Wearing ${worn} of ${MAX_ACCESSORIES}. A new one replaces whatever is in its place.`}
      </p>
      {SLOT_ORDER.map((slot) => {
        const ids = ACCESSORY_IDS.filter((id) => ACCESSORIES[id].slot === slot);
        return (
          <Group key={slot} title={SLOT_TITLE[slot]}>
            <div className="jce-grid jce-grid--4">
              {ids.map((id) => {
                const on = wornIds.has(id);
                const preview = on ? cfg.accessories : wearAccessory(cfg.accessories, id);
                return <Thumb key={id} cfg={{ ...cfg, accessories: preview }} label={ACCESSORIES[id].label} selected={on} onPick={() => (on ? takeOff(id) : wear(id))} size={60} />;
              })}
            </div>
          </Group>
        );
      })}
      {last ? (
        <Group title={`${ACCESSORIES[last.id].label} colour`}>
          <div className="jce-swatches jce-swatches--sm">
            <button type="button" className="jce-chip" aria-pressed={!last.color} onClick={() => colour(last.id, null)}>
              Matched
            </button>
            {ACC_COLOURS.map((c) => (
              <Swatch key={c} color={colorHex(c)} size={22} label={PALETTE[c as keyof typeof PALETTE].label} selected={last.color === c} onPick={() => colour(last.id, c)} />
            ))}
          </div>
        </Group>
      ) : null}
    </>
  );
}

/** Downscale an uploaded image to fit `max` px and return it as a data URL (JPEG, or PNG when it has transparency). */
async function downscale(file: File, max: number): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return file.type === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.86);
}
