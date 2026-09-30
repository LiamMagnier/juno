"use client";

/**
 * CrewLab: the three-dimensional identity exploration. Every grammar in every
 * material, every grammar at every product size, the colour families, the
 * textures and the eyes, in light and dark side by side. The faces here are
 * stills (sprites of the one renderer): the lab judges objects, not motion.
 *
 *   ?scene=lab                       everything
 *   ?scene=lab&only=matrix|sizes|colors|textures|eyes|states
 */

import * as React from "react";
import {
  AVATAR_COLORS,
  AVATAR_MATERIALS,
  AVATAR_SHAPES,
  EYE_LABEL,
  EYE_STYLES,
  FAMILY,
  MATERIAL_LABEL,
  PROCEDURAL_TEXTURES,
  SHAPE_LABEL,
  TEXTURE_LABEL,
  avatarFromSeed,
  type AvatarConfig,
} from "./avatar";
import { CrewFace, CREW_STATE_LABEL } from "./face";
import { STATE_ORDER } from "./fixtures";

export type LabSection = "matrix" | "sizes" | "colors" | "textures" | "eyes" | "states";

const SIZES = [20, 32, 64, 128, 256];
const BASE_SEED = "lab-mira";

function still(cfg: AvatarConfig, id: string) {
  return { id, name: id, seed: id, avatar: cfg };
}

function Matrix() {
  const base = avatarFromSeed(BASE_SEED, "sage");
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">Grammars in each material</h2>
      <p className="jcl-note">One member (sage, the same proportions) drawn in the five grammars and six materials, at 88 px.</p>
      <div className="jcl-matrix" style={{ gridTemplateColumns: `88px repeat(${AVATAR_MATERIALS.length}, 1fr)` }}>
        <span />
        {AVATAR_MATERIALS.map((m) => (
          <span key={m} className="jcl-colhead">
            {MATERIAL_LABEL[m]}
          </span>
        ))}
        {AVATAR_SHAPES.map((s) => (
          <React.Fragment key={s}>
            <span className="jcl-rowhead">{SHAPE_LABEL[s]}</span>
            {AVATAR_MATERIALS.map((m) => (
              <span key={m} className="jcl-cell">
                <CrewFace member={still({ ...base, shape: s, material: m }, `${s}-${m}`)} size={88} live={false} facing="right" />
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function Sizes() {
  const base = avatarFromSeed(BASE_SEED, "clay");
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">Every grammar at every size</h2>
      <p className="jcl-note">20 sidebar and tokens, 32 thread header, 64 roster, 128 and 256 profile and editor. Matte ceramic.</p>
      <div className="jcl-sizes">
        {AVATAR_SHAPES.map((s) => (
          <div key={s} className="jcl-sizerow">
            <span className="jcl-rowhead">{SHAPE_LABEL[s]}</span>
            {SIZES.map((z) => (
              <span key={z} className="jcl-sizecell">
                <CrewFace member={still({ ...base, shape: s }, `${s}-${z}`)} size={z} live={false} facing={z <= 28 ? "right" : "front"} />
                <span className="jcl-cap">{z}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Colors() {
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">Colour families</h2>
      <p className="jcl-note">Eight glazes tuned to sit on both grounds. Each member keeps its seed&rsquo;s proportions.</p>
      <div className="jcl-colors">
        {AVATAR_COLORS.map((c, i) => {
          const cfg = avatarFromSeed(`lab-${c}-${i}`, c);
          return (
            <span key={c} className="jcl-colorcell">
              <CrewFace member={still(cfg, `c-${c}`)} size={72} live={false} facing="front" />
              <span className="jcl-small-row">
                <CrewFace member={still(cfg, `c-${c}`)} size={20} live={false} />
                <span className="jcl-cap">{FAMILY[c].label}</span>
              </span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function textureDemo(base: AvatarConfig, t: (typeof PROCEDURAL_TEXTURES)[number]): AvatarConfig {
  const color = t === "grain" ? "ochre" : t === "knit" ? "rose" : t === "terrazzo" || t === "marble" ? "porcelain" : t === "linen" ? "iris" : "sage";
  const material = t === "grain" ? "wood" : t === "knit" || t === "linen" ? "felt" : "stone";
  return { ...base, color, material, texture: { kind: "procedural", id: t, seed: 2 } };
}

function Textures() {
  const base = avatarFromSeed(BASE_SEED, "porcelain");
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">Textures</h2>
      <p className="jcl-note">Generated in code, seamless, mapped triplanar so nothing smears on the curve.</p>
      <div className="jcl-colors">
        {PROCEDURAL_TEXTURES.map((t) => (
          <span key={t} className="jcl-colorcell">
            <CrewFace member={still(textureDemo(base, t), `t-${t}`)} size={112} live={false} facing="front" />
            <span className="jcl-cap">{TEXTURE_LABEL[t]}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function Eyes() {
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">Eyes</h2>
      <p className="jcl-note">Inlaid capsules by default, round inlays, or softly lit capsules for dark glazes.</p>
      <div className="jcl-colors">
        {EYE_STYLES.flatMap((e) =>
          (["porcelain", "graphite"] as const).map((c) => {
            const b = avatarFromSeed(BASE_SEED, c);
            const cfg: AvatarConfig = { ...b, eyes: { ...b.eyes, style: e } };
            return (
              <span key={`${e}-${c}`} className="jcl-colorcell">
                <CrewFace member={still(cfg, `e-${e}-${c}`)} size={96} live={false} facing="front" />
                <span className="jcl-small-row">
                  <CrewFace member={still(cfg, `e-${e}-${c}`)} size={20} live={false} />
                  <span className="jcl-cap">
                    {EYE_LABEL[e]}, {FAMILY[c].label.toLowerCase()}
                  </span>
                </span>
              </span>
            );
          }),
        )}
      </div>
    </section>
  );
}

function States() {
  const cfg = avatarFromSeed(BASE_SEED, "iris");
  return (
    <section className="jcl-sec">
      <h2 className="jcl-h">States</h2>
      <p className="jcl-note">Pose only: gaze, lids, posture, colour. The word always sits beside the face.</p>
      {[128, 64, 32].map((z) => (
        <div key={z} className="jcl-states">
          {STATE_ORDER.map((s) => (
            <span key={s} className="jcl-statecell">
              <CrewFace member={still(cfg, `s-${s}`)} size={z} state={s} live={false} facing="right" />
              {z === 32 ? <span className="jcl-cap">{CREW_STATE_LABEL[s]}</span> : null}
            </span>
          ))}
        </div>
      ))}
    </section>
  );
}

const ALL: LabSection[] = ["matrix", "sizes", "colors", "textures", "eyes", "states"];

export function CrewLab({ only, theme }: { only?: LabSection; theme?: "light" | "dark" }) {
  const sections = only ? [only] : ALL;
  const themes = theme ? [theme] : (["light", "dark"] as const);
  return (
    <div className="jcl" data-cols={themes.length}>
      {themes.map((t) => (
        <div key={t} className="jn jcl-pane" data-theme={t}>
          <header className="jcl-top">
            <h1 className="t-title">Crew, in three dimensions</h1>
            <p className="jcl-note">{t === "light" ? "Light" : "Dark"} ground. Sculpted forms in physically based materials, lit by one studio.</p>
          </header>
          {sections.includes("matrix") ? <Matrix /> : null}
          {sections.includes("sizes") ? <Sizes /> : null}
          {sections.includes("colors") ? <Colors /> : null}
          {sections.includes("textures") ? <Textures /> : null}
          {sections.includes("eyes") ? <Eyes /> : null}
          {sections.includes("states") ? <States /> : null}
        </div>
      ))}
    </div>
  );
}
