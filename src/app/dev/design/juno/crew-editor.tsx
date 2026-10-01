"use client";

/**
 * Add to crew / Customize (D-032): one sheet for making a character and for
 * changing one. The character stands large on its own plane (drag it to turn
 * it; it wobbles back); every choice is a picture of the member wearing it, or
 * a plain word; four quiet tabs keep the many choices in reach without a long
 * scroll. The colour the member brings to its thread is shown live.
 *
 * It speaks the character system's own vocabulary (juno/crew/avatar2.ts), so a
 * new shape, eye or accessory the crew designer adds appears here unasked.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ACCESSORIES,
  ACCESSORY_IDS,
  ACCESSORY_SLOTS,
  BODY_SHAPES,
  BROW_LABEL,
  BROWS,
  EYE_LABEL,
  EYE_STYLES,
  MATERIAL_KINDS,
  MATERIAL_LABEL,
  MAX_ACCESSORIES,
  MOUTH_LABEL,
  MOUTHS,
  PATTERN_LABEL,
  SHAPE_LABEL,
  avatarFromSeed,
  defaultPatternColor,
  isAcceptableAssetUrl,
  normalizeAvatar,
  removeAccessory,
  surpriseAvatar,
  wearAccessory,
  type AccessoryId,
  type AccessorySlot,
  type AvatarConfig,
  type AvatarPattern,
} from "./crew/avatar2";
import { colorHex, colorLabel, isHex, PALETTE_IDS, type ColorValue } from "./crew/palette";
import { CrewFace, type CrewMember, type LiveHandle } from "./crew/face";
import { threadColour } from "./crew-bridge";
import { Segmented } from "./composer";
import { Icon } from "./icons";
import { R, T, useReduced } from "./motion";

export type EditorSheet = { kind: "add" } | { kind: "customize"; member: CrewMember; role: string; does: string };

type Tab = "Body" | "Colour" | "Face" | "Wear";
const TABS: readonly Tab[] = ["Body", "Colour", "Face", "Wear"];

const SLOT_LABEL: Record<AccessorySlot, string> = { head: "On the head", eyes: "Over the eyes", ears: "On the ears", neck: "Round the neck", pin: "Pinned on" };
const PATTERNS = ["none", "dip", "belly", "spots", "stripes"] as const;
const SLOT_ORDER: AccessorySlot[] = ["head", "eyes", "ears", "neck", "pin"];

/* ———————————————————————————— Small parts ———————————————————————————— */

/** A labelled row of choices. Arrow keys move within it (a radio group). */
function Choice<V extends string>({
  label,
  value,
  options,
  onChange,
  render,
  shape = "chip",
  said,
  toggle,
}: {
  label: string;
  value: V | V[];
  options: readonly V[];
  onChange: (v: V) => void;
  render: (v: V, on: boolean) => React.ReactNode;
  shape?: "chip" | "tile" | "swatch";
  said?: string;
  /** Several may be on (accessories): checkboxes instead of radios. */
  toggle?: boolean;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const id = React.useId();
  const isOn = (o: V) => (Array.isArray(value) ? value.includes(o) : o === value);
  const firstOn = Math.max(0, options.findIndex(isOn));
  const move = (i: number) => {
    const n = (i + options.length) % options.length;
    if (!toggle) onChange(options[n]);
    refs.current[n]?.focus();
  };
  return (
    <div className="jn-choice">
      <p className="jn-choice__label" id={id}>
        {label}
        {said ? <span className="jn-choice__said">{said}</span> : null}
      </p>
      <div className="jn-choice__row" data-shape={shape} role={toggle ? "group" : "radiogroup"} aria-labelledby={id}>
        {options.map((o, i) => {
          const on = isOn(o);
          return (
            <button
              key={o}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role={toggle ? "checkbox" : "radio"}
              aria-checked={on}
              tabIndex={toggle ? 0 : i === firstOn ? 0 : -1}
              className="jn-choice__opt jicon-trigger"
              onClick={() => onChange(o)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i + 1);
                }
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i - 1);
                }
              }}
            >
              {render(o, on)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A slider with its two ends in words. */
function Range({ label, value, min = 0, max = 1, step = 0.05, ends, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; ends: [string, string]; onChange: (v: number) => void }) {
  const id = React.useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="jn-range">
      <label className="jn-choice__label" htmlFor={id}>
        {label}
      </label>
      <div className="jn-range__row">
        <span className="jn-range__end">{ends[0]}</span>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
          aria-valuetext={pct < 34 ? ends[0] : pct > 66 ? ends[1] : "In between"}
        />
        <span className="jn-range__end">{ends[1]}</span>
      </div>
    </div>
  );
}

/** The member wearing one variant of its look: a cached still, a picture of the choice. */
function Preview({ member, look, size = 52 }: { member: CrewMember; look: AvatarConfig; size?: number }) {
  return <CrewFace member={{ ...member, avatar: look }} state="available" size={size} facing="front" live={false} />;
}

function ThreadSample({ color, name }: { color: string; name: string }) {
  return (
    <div className="jn-tsample" style={threadColour(color)} data-member-theme={color}>
      <span className="jn-tsample__bubble">Thanks, {name}. That saves me a morning.</span>
      <span className="jn-tsample__disc" aria-hidden="true">
        <Icon name="send" size={16} />
      </span>
    </div>
  );
}

/** An uploaded picture, downscaled to 512 px in the browser before it becomes a texture (never stored full size). */
async function pictureToTexture(file: File): Promise<string | null> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) return null;
  const bitmap = await createImageBitmap(file);
  const side = 512;
  const scale = Math.max(side / bitmap.width, side / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(bitmap, (side - bitmap.width * scale) / 2, (side - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  const url = canvas.toDataURL("image/webp", 0.86);
  return isAcceptableAssetUrl(url) ? url : null;
}

/* ———————————————————————————— The sheet ———————————————————————————— */

export function CrewEditor({ sheet, onClose }: { sheet: EditorSheet; onClose: () => void }) {
  const reduced = useReduced();
  const editing = sheet.kind === "customize" ? sheet.member : null;
  const base: CrewMember = editing ?? { id: "new", name: "Nova", role: "Product analytics", seed: "nova-3c1d" };
  const original = React.useMemo(() => (editing?.avatar ? normalizeAvatar(editing.avatar, editing.seed) : avatarFromSeed(base.seed, editing ? undefined : "lagoon")), [editing, base.seed]);
  const [look, setLook] = React.useState<AvatarConfig>(original);
  const [name, setName] = React.useState(editing?.name ?? "Nova");
  const [does, setDoes] = React.useState(sheet.kind === "customize" ? sheet.does : "Reads the product analytics every Monday and writes the digest for #product.");
  const [tab, setTab] = React.useState<Tab>("Body");
  const [spin, setSpin] = React.useState(0);
  const [note, setNote] = React.useState<string | null>(null);
  const handle = React.useRef<LiveHandle | null>(null);
  const drag = React.useRef<{ x: number; y: number; t: number; yaw: number; v: number } | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const who = name.trim() || "Your teammate";
  const member: CrewMember = { ...base, name: name.trim() || "Unnamed", avatar: look };
  const set = (patch: Partial<AvatarConfig>) => setLook((l) => ({ ...l, ...patch }));
  const variant = (patch: Partial<AvatarConfig>): AvatarConfig => ({ ...look, ...patch });
  const worn = look.accessories.map((a) => a.id);

  React.useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 3200);
    return () => window.clearTimeout(t);
  }, [note]);

  const wear = (id: AccessoryId) => {
    if (worn.includes(id)) {
      set({ accessories: removeAccessory(look.accessories, id) });
      return;
    }
    const next = wearAccessory(look.accessories, id);
    const gone = look.accessories.filter((a) => !next.some((n) => n.id === a.id));
    const sameSlot = gone.find((a) => ACCESSORIES[a.id].slot === ACCESSORIES[id].slot);
    if (gone.length && !sameSlot) setNote(`Three at most, so the ${ACCESSORIES[gone[0].id].label.toLowerCase()} came off.`);
    set({ accessories: next });
  };

  const setPattern = (kind: (typeof PATTERNS)[number] | "image") => {
    if (kind === "image") {
      fileRef.current?.click();
      return;
    }
    const p: AvatarPattern = kind === "none" ? { kind: "none" } : { kind, color: look.pattern.kind !== "none" && look.pattern.kind !== "image" ? look.pattern.color : defaultPatternColor(look.color), scale: look.pattern.kind !== "none" && look.pattern.kind !== "image" ? look.pattern.scale : 0.5 };
    set({ pattern: p });
  };

  /* Drag the character to turn it; let go and it wobbles back (the rig's spring). */
  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now(), yaw: 0, v: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const yaw = Math.max(-1.3, Math.min(1.3, (e.clientX - d.x) / 120));
    const pitch = Math.max(-0.45, Math.min(0.45, (e.clientY - d.y) / 220));
    const now = performance.now();
    d.v = ((yaw - d.yaw) / Math.max(1, now - d.t)) * 1000;
    d.yaw = yaw;
    d.t = now;
    handle.current?.drag(yaw, pitch);
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    handle.current?.release(Math.max(-8, Math.min(8, d.v)), 0);
    drag.current = null;
  };

  const patternKind = look.pattern.kind;
  const patternColor = look.pattern.kind !== "none" && look.pattern.kind !== "image" ? look.pattern.color : null;
  const customColor = isHex(look.color);

  return (
    <>
      <motion.div className="jn-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fade} onClick={onClose} />
      <motion.div
        className="jn-editor"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? `Customize ${editing.name}` : "Add to crew"}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99 }}
        transition={reduced ? R : T.slow}
      >
        <div className="jn-editor__stage">
          <div
            className="jn-editor__char"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-hidden="true"
          >
            <CrewFace member={member} state="available" size={208} facing="front" focused morph arrive={!editing} onHandle={(h) => (handle.current = h)} />
          </div>
          <div className="jn-editor__who">
            <p className="jn-editor__name">{name.trim() || "Unnamed"}</p>
            <p className="jn-editor__role">{editing ? (editing.role ?? "") : "New to the crew"}</p>
            <div className="jn-editor__stagetools">
              <button
                type="button"
                className="jb jb--secondary jb--sm jicon-trigger"
                onClick={() => {
                  setSpin((s) => s + 1);
                  setLook(surpriseAvatar(`${base.seed}-${spin + 1}`));
                }}
              >
                <Icon name="retry" size={16} />
                Surprise me
              </button>
            </div>
          </div>
          <p className="jn-editor__drag">Drag to turn</p>
        </div>

        <div className="jn-editor__form">
          <header className="jn-editor__head">
            <h2 className="t-display">{editing ? `Customize ${editing.name}` : "Add to crew"}</h2>
            <button type="button" className="jib jicon-trigger" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          </header>

          <div className="jn-editor__fields">
            <label className="jn-flabel">
              <span>Name</span>
              <span className="jfield jn-flabel__field">
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </span>
            </label>
            <label className="jn-flabel">
              <span>What {editing ? editing.name : "they"} do{editing ? "es" : ""}</span>
              <span className="jfield jn-flabel__field">
                <input value={does} onChange={(e) => setDoes(e.target.value)} />
              </span>
            </label>
          </div>

          <div className="jn-editor__tabs">
            <Segmented options={TABS} value={tab} onChange={setTab} label="Customize" layoutKey="editor-tab" />
          </div>

          <div className="jn-editor__body" role="tabpanel" aria-label={tab}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                className="jn-editor__panel"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: reduced ? R : { duration: 0.1 } }}
                transition={reduced ? R : T.fast}
              >
                {tab === "Body" ? (
                  <>
                    <Choice
                      label="Shape"
                      said={SHAPE_LABEL[look.shape]}
                      value={look.shape}
                      options={BODY_SHAPES}
                      shape="tile"
                      onChange={(v) => set({ shape: v })}
                      render={(v) => (
                        <>
                          <Preview member={member} look={variant({ shape: v })} />
                          <span className="jn-choice__text">{SHAPE_LABEL[v]}</span>
                        </>
                      )}
                    />
                    <Range label="Proportions" value={look.stretch} min={-1} max={1} step={0.05} ends={["Rounder", "Taller"]} onChange={(v) => set({ stretch: v })} />
                    <Choice
                      label="Material"
                      value={look.material.kind}
                      options={MATERIAL_KINDS}
                      onChange={(v) => set({ material: { ...look.material, kind: v } })}
                      render={(v) => MATERIAL_LABEL[v]}
                    />
                    {look.material.kind === "plush" ? (
                      <Range label="Fur" value={look.material.furLength} ends={["Short pile", "Long and fluffy"]} onChange={(v) => set({ material: { ...look.material, furLength: v } })} />
                    ) : null}
                  </>
                ) : null}

                {tab === "Colour" ? (
                  <>
                    <div className="jn-choice">
                      <p className="jn-choice__label">
                        Colour <span className="jn-choice__said">{colorLabel(look.color)}</span>
                      </p>
                      <div className="jn-choice__row" data-shape="swatch" role="radiogroup" aria-label="Colour">
                        {PALETTE_IDS.map((c) => (
                          <button key={c} type="button" role="radio" aria-checked={look.color === c} className="jn-choice__opt" onClick={() => set({ color: c })}>
                            <span className="jn-swatch" style={{ background: colorHex(c) }}>
                              <span className="sr">{colorLabel(c)}</span>
                            </span>
                          </button>
                        ))}
                        <label className="jn-choice__opt jn-swatch-custom" aria-checked={customColor} role="radio" title="Any colour">
                          <span className="jn-swatch" style={customColor ? { background: colorHex(look.color) } : undefined}>
                            {customColor ? null : <Icon name="plus" size={16} />}
                          </span>
                          <input
                            type="color"
                            className="sr"
                            aria-label="Any colour"
                            value={colorHex(look.color)}
                            onChange={(e) => set({ color: e.target.value.toLowerCase() as ColorValue })}
                          />
                        </label>
                      </div>
                    </div>
                    <Choice
                      label="Pattern"
                      value={patternKind}
                      options={[...PATTERNS, "image"] as const}
                      shape="tile"
                      onChange={setPattern}
                      render={(v) => (
                        <>
                          {v === "image" ? (
                            <span className="jn-choice__upload">
                              <Icon name="image" size={20} />
                            </span>
                          ) : (
                            <Preview member={member} look={variant({ pattern: v === "none" ? { kind: "none" } : { kind: v, color: patternColor ?? defaultPatternColor(look.color), scale: 0.5 } })} />
                          )}
                          <span className="jn-choice__text">{v === "image" ? "Your picture" : PATTERN_LABEL[v]}</span>
                        </>
                      )}
                    />
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr"
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        const url = await pictureToTexture(f);
                        if (url) set({ pattern: { kind: "image", assetUrl: url, tint: 0.25 } });
                        else setNote("That picture could not be used. PNG, JPEG or WebP, up to 8 MB.");
                      }}
                    />
                    {patternColor ? (
                      <div className="jn-choice">
                        <p className="jn-choice__label">
                          Second colour <span className="jn-choice__said">{colorLabel(patternColor)}</span>
                        </p>
                        <div className="jn-choice__row" data-shape="swatch" role="radiogroup" aria-label="Second colour">
                          {PALETTE_IDS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              role="radio"
                              aria-checked={patternColor === c}
                              className="jn-choice__opt"
                              onClick={() => look.pattern.kind !== "none" && look.pattern.kind !== "image" && set({ pattern: { ...look.pattern, color: c } })}
                            >
                              <span className="jn-swatch" style={{ background: colorHex(c) }}>
                                <span className="sr">{colorLabel(c)}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {look.pattern.kind === "image" ? (
                      <Range
                        label="Picture"
                        value={look.pattern.tint}
                        ends={["As it is", "Tinted to the colour"]}
                        onChange={(v) => look.pattern.kind === "image" && set({ pattern: { ...look.pattern, tint: v } })}
                      />
                    ) : null}
                    <div className="jn-choice">
                      <p className="jn-choice__label">
                        Thread colour <span className="jn-choice__said">Follows {colorLabel(look.color).toLowerCase()}</span>
                      </p>
                      <p className="jn-editor__hint">Your messages to {editing ? editing.name : who} and the send button take this colour, so you always know whose thread you are in.</p>
                      <ThreadSample color={String(look.color)} name={name.trim() || "Nova"} />
                    </div>
                  </>
                ) : null}

                {tab === "Face" ? (
                  <>
                    <Choice
                      label="Eyes"
                      said={EYE_LABEL[look.eyes.style]}
                      value={look.eyes.style}
                      options={EYE_STYLES}
                      shape="tile"
                      onChange={(v) => set({ eyes: { ...look.eyes, style: v } })}
                      render={(v) => (
                        <>
                          <Preview member={member} look={variant({ eyes: { ...look.eyes, style: v } })} />
                          <span className="jn-choice__text">{EYE_LABEL[v]}</span>
                        </>
                      )}
                    />
                    <div className="jn-editor__pair">
                      <Range label="Eye size" value={look.eyes.size} ends={["Small", "Big"]} onChange={(v) => set({ eyes: { ...look.eyes, size: v } })} />
                      <Range label="Eye spacing" value={look.eyes.gap} ends={["Close", "Wide"]} onChange={(v) => set({ eyes: { ...look.eyes, gap: v } })} />
                    </div>
                    <Choice label="Brows" value={look.brows} options={BROWS} onChange={(v) => set({ brows: v })} render={(v) => BROW_LABEL[v]} />
                    <Choice label="Mouth" value={look.mouth} options={MOUTHS} onChange={(v) => set({ mouth: v })} render={(v) => MOUTH_LABEL[v]} />
                    <div className="jn-editor__switchrow">
                      <span>
                        <span className="jn-editor__switchlabel">Rosy cheeks</span>
                        <span className="t-meta">A little colour under the eyes</span>
                      </span>
                      <button type="button" role="switch" aria-checked={look.cheeks} aria-label="Rosy cheeks" className="jswitch" onClick={() => set({ cheeks: !look.cheeks })} />
                    </div>
                  </>
                ) : null}

                {tab === "Wear" ? (
                  <>
                    <p className="jn-editor__hint">
                      Up to {MAX_ACCESSORIES}, one in each place. {worn.length ? `${worn.length} on now.` : "Nothing on yet."}
                    </p>
                    {SLOT_ORDER.filter((slot) => ACCESSORY_SLOTS.includes(slot)).map((slot) => {
                      const ids = ACCESSORY_IDS.filter((id) => ACCESSORIES[id].slot === slot);
                      if (!ids.length) return null;
                      return (
                        <Choice
                          key={slot}
                          label={SLOT_LABEL[slot]}
                          value={worn.filter((w) => ACCESSORIES[w].slot === slot)}
                          options={ids}
                          shape="tile"
                          toggle
                          onChange={wear}
                          render={(id, on) => (
                            <>
                              <Preview member={member} look={variant({ accessories: on ? look.accessories : wearAccessory(look.accessories, id) })} />
                              <span className="jn-choice__text">{ACCESSORIES[id].label}</span>
                            </>
                          )}
                        />
                      );
                    })}
                  </>
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="jn-editor__foot">
            <AnimatePresence mode="wait" initial={false}>
              {note ? (
                <motion.p key="note" className="t-meta jn-editor__note" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
                  {note}
                </motion.p>
              ) : editing ? (
                <motion.button key="back" type="button" className="jb jb--link" onClick={() => setLook(original)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
                  Back to the original look
                </motion.button>
              ) : (
                <motion.p key="next" className="t-meta jn-editor__next" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
                  {who} starts with no apps. You choose them next.
                </motion.p>
              )}
            </AnimatePresence>
            <span className="jn-editor__actions">
              <button type="button" className="jb jb--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="jb jb--primary" aria-disabled={!name.trim()}>
                {editing ? "Save" : `Add ${name.trim() || "to crew"}`}
              </button>
            </span>
          </footer>
        </div>
      </motion.div>
    </>
  );
}
