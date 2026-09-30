/**
 * Thumbnail sketches used to break out of the blob: twenty silhouette and
 * eye pairings drawn at the product sizes. Lab only.
 */
import * as React from "react";
import { superellipse } from "./identity";
import type { CrewFamily } from "./identity";

type Eye = "dot" | "stroke" | "pill" | "bar" | "knock" | "line";
interface Sketch {
  id: string;
  label: string;
  body: string;
  /** Eye centres. */
  eyes: [number, number][];
  eye: Eye;
  /** Optional second tone. */
  tone2?: string;
  /** Extra detail drawn in the deep colour. */
  extra?: string;
  hole?: string;
}

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

export const SKETCHES: Sketch[] = [
  { id: "s1", label: "Circle, dots", body: circle(32, 32, 26), eyes: [[25, 30], [39, 30]], eye: "dot" },
  { id: "s2", label: "Circle, strokes", body: circle(32, 32, 26), eyes: [[26, 29], [38, 29]], eye: "stroke" },
  { id: "s3", label: "Squircle, pills", body: superellipse(32, 32, 26, 26, 4), eyes: [[25, 30], [39, 30]], eye: "pill" },
  {
    id: "s4",
    label: "Diamond, strokes",
    body: `M32 4.5C34.2 4.5 36 5.6 38 7.6L56.4 26C58.4 28 59.5 29.8 59.5 32S58.4 36 56.4 38L38 56.4C36 58.4 34.2 59.5 32 59.5S28 58.4 26 56.4L7.6 38C5.6 36 4.5 34.2 4.5 32S5.6 28 7.6 26L26 7.6C28 5.6 29.8 4.5 32 4.5Z`,
    eyes: [[26, 29], [38, 29]],
    eye: "stroke",
  },
  { id: "s5", label: "Dome, strokes", body: `M6 56V34C6 19.6 17.6 8 32 8S58 19.6 58 34V56Z`, eyes: [[25.5, 30], [38.5, 30]], eye: "stroke" },
  { id: "s6", label: "Capsule, strokes", body: `M19 14H45C54.9 14 63 22.1 63 32S54.9 50 45 50H19C9.1 50 1 41.9 1 32S9.1 14 19 14Z`, eyes: [[26, 30], [38, 30]], eye: "stroke" },
  { id: "s7", label: "Leaf, strokes", body: `M58 6C58 36 44 58 14 58C9 58 6 55 6 50C6 20 28 6 58 6Z`, eyes: [[27, 31], [38, 25]], eye: "stroke" },
  {
    id: "s8",
    label: "Soft hexagon, strokes",
    body: `M27 5.5C30 3.8 34 3.8 37 5.5L53.5 15C56.5 16.7 58.5 20 58.5 23.5V40.5C58.5 44 56.5 47.3 53.5 49L37 58.5C34 60.2 30 60.2 27 58.5L10.5 49C7.5 47.3 5.5 44 5.5 40.5V23.5C5.5 20 7.5 16.7 10.5 15Z`,
    eyes: [[26, 30], [38, 30]],
    eye: "stroke",
  },
  { id: "s9", label: "Circle, joined eyes", body: circle(32, 32, 26), eyes: [[23, 30], [41, 30]], eye: "dot", extra: "M23 30H41" },
  { id: "s10", label: "Crescent, stroke", body: `M40 6.5A26 26 0 1 0 57.5 44A21 21 0 1 1 40 6.5Z`, eyes: [[18, 30], [27, 30]], eye: "stroke" },
  {
    id: "s11",
    label: "Split disc, strokes",
    body: circle(32, 32, 26),
    tone2: `M13.6 13.6A26 26 0 0 1 58 32L6 32A26 26 0 0 1 13.6 13.6Z`,
    eyes: [[26, 34], [38, 34]],
    eye: "stroke",
  },
  { id: "s12", label: "Ring, eyes in hole", body: circle(32, 32, 27), hole: circle(32, 32, 15), eyes: [[27.5, 32], [36.5, 32]], eye: "stroke" },
  { id: "s13", label: "Circle, bars", body: circle(32, 32, 26), eyes: [[25, 31], [39, 31]], eye: "bar" },
  { id: "s14", label: "Circle, low and close", body: circle(32, 32, 26), eyes: [[28, 37], [36, 37]], eye: "stroke" },
  { id: "s15", label: "Soft triangle, strokes", body: `M26.8 9C29.1 5 34.9 5 37.2 9L58 45C60.3 49 57.4 54 52.8 54H11.2C6.6 54 3.7 49 6 45Z`, eyes: [[27, 38], [37, 38]], eye: "stroke" },
  { id: "s16", label: "Wide stone, slits", body: superellipse(32, 34, 28, 22, 2.8), eyes: [[26, 32], [38, 32]], eye: "knock" },
  { id: "s17", label: "Standing oval, strokes", body: superellipse(32, 32, 21, 27, 2.4), eyes: [[27, 25], [37, 25]], eye: "stroke" },
  { id: "s18", label: "Quarter round, strokes", body: `M6 6H34C47.3 6 58 16.7 58 30V58H30C16.7 58 6 47.3 6 34Z`, eyes: [[27, 29], [39, 29]], eye: "stroke" },
  { id: "s19", label: "Circle, lines (icon weight)", body: circle(32, 32, 26), eyes: [[26, 30], [38, 30]], eye: "line" },
  { id: "s20", label: "Squircle, knock slits", body: superellipse(32, 32, 26, 26, 3.2), eyes: [[26, 30], [38, 30]], eye: "knock" },
];

function EyeMark({ x, y, eye, sw }: { x: number; y: number; eye: Eye; sw: number }) {
  if (eye === "dot") return <circle cx={x} cy={y} r={3.2} />;
  if (eye === "pill") return <rect x={x - 3} y={y - 4.6} width={6} height={9.2} rx={3} />;
  if (eye === "bar") return <rect x={x - 4.2} y={y - 1.5} width={8.4} height={3} rx={1.5} />;
  if (eye === "line") return <line x1={x} y1={y - 3.4} x2={x} y2={y + 3.4} strokeWidth={sw} strokeLinecap="round" className="jc-sk-line" />;
  if (eye === "knock") return <rect x={x - 1.9} y={y - 4.4} width={3.8} height={8.8} rx={1.9} />;
  return <rect x={x - 2} y={y - 4.8} width={4} height={9.6} rx={2} />;
}

let n = 0;
export function SketchFace({ sketch, family, size }: { sketch: Sketch; family: CrewFamily; size: number }) {
  const id = `sk${React.useId().replace(/[^a-zA-Z0-9]/g, "")}${n++ % 1}`;
  const sw = Math.max(3.4, (1.5 * 64) / size);
  const knock = sketch.eye === "knock";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" data-family={family} className="jc-lab-face" aria-hidden>
      {knock || sketch.hole ? (
        <defs>
          <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
            <rect width="64" height="64" fill="#fff" />
            {sketch.hole ? <path d={sketch.hole} fill="#000" /> : null}
            {knock ? (
              <g fill="#000">
                {sketch.eyes.map(([x, y], i) => (
                  <EyeMark key={i} x={x} y={y} eye="knock" sw={sw} />
                ))}
              </g>
            ) : null}
          </mask>
        </defs>
      ) : null}
      <path d={sketch.body} className="jc-lab-body" mask={knock || sketch.hole ? `url(#${id})` : undefined} />
      {sketch.tone2 ? <path d={sketch.tone2} className="jc-lab-shade" /> : null}
      {sketch.extra ? <path d={sketch.extra} className="jc-sk-line" strokeWidth={sw * 0.6} fill="none" /> : null}
      {knock ? null : (
        <g className="jc-lab-deep">
          {sketch.eyes.map(([x, y], i) => (
            <EyeMark key={i} x={x} y={y} eye={sketch.eye} sw={sw} />
          ))}
        </g>
      )}
    </svg>
  );
}

const FAMS: CrewFamily[] = ["sage", "clay", "iris", "slate"];

function SketchColumn({ theme }: { theme: "light" | "dark" }) {
  return (
    <section className="jc jc-lab__col" data-theme={theme}>
      <div className="jc-sk-grid">
        {SKETCHES.map((s) => (
          <div key={s.id} className="jc-sk-cell">
            <div className="jc-sk-faces">
              <SketchFace sketch={s} family="sage" size={56} />
              {FAMS.map((f) => (
                <SketchFace key={f} sketch={s} family={f} size={20} />
              ))}
              <SketchFace sketch={s} family="clay" size={16} />
            </div>
            <div className="jc-sk-label">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SketchSheet() {
  return (
    <div className="jc-lab">
      <SketchColumn theme="light" />
      <SketchColumn theme="dark" />
    </div>
  );
}
