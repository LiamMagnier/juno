import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { AGENT_EYES, AGENT_MARKS, AGENT_SHAPES, type AgentShape } from "../src/lib/agents/avatar";
import { AGENT_STATES, type AgentState } from "../src/lib/agents/domain";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BALL_LEAD,
  BLENDED,
  NO_EXTRAS,
  PARTS,
  RING_LOWEST,
  bodyOf,
  drawFace,
  eyeFrames,
  eyeNotchMargin,
  morphOutline,
  morphScale,
  orbitFrame,
  pxPerR,
  rimBallAngle,
  sizeClass,
  stadiumDistance,
  type FaceExtras,
  type FaceSpec,
  type Pose,
} from "../src/components/agents/face-geometry";
import { OUTLINES } from "../src/components/agents/face-outlines";
import { outlinesModule, traceBodies } from "../src/components/agents/face-shapes";
import {
  carryBlink,
  changeAt,
  faceCtx,
  faceIdentity,
  frontPose,
  gateAt,
  nextChange,
  noticeJoins,
  poseAt,
  rebaseSegment,
  restExtras,
  snapshot,
  spinHold,
  staggeredAt,
  staggers,
  stillPose,
  type Gate,
  type Segment,
} from "../src/components/agents/face-rig";

/**
 * The agent face (src/components/agents/agent-face.tsx, docs/design/AGENTS.md
 * §4): the traced body table is the construction, every state draws, every
 * still pose reads on its own, and the motion keeps its promises (no jumps,
 * no overshoot, done stays done, working shows at every size).
 */

const OUTLINES_FILE = new URL("../src/components/agents/face-outlines.ts", import.meta.url);
const outCubicRef = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const ids = { mask: "k", clip: "c", body: "b" };
const spec = (shape: AgentShape, px: number, eyes: (typeof AGENT_EYES)[number] = "soft"): FaceSpec => ({ shape, eyes, px, size: sizeClass(px) });
const numbers = (frame: ReturnType<typeof drawFace>) =>
  PARTS.flatMap((part) => Object.values(frame[part]).flatMap((v) => (v.match(/-?\d*\.?\d+(e-?\d+)?/g) ?? []).map(Number)));

test("the body table is what the constructions trace (UPDATE_FACE_OUTLINES=1 rewrites it)", () => {
  const traced = traceBodies();
  if (process.env.UPDATE_FACE_OUTLINES === "1") {
    writeFileSync(OUTLINES_FILE, outlinesModule(traced));
    return;
  }
  assert.equal(readFileSync(OUTLINES_FILE, "utf8"), outlinesModule(traced), "face-outlines.ts is stale: run with UPDATE_FACE_OUTLINES=1");
});

test("nine bodies, one visual weight, each centred", () => {
  for (const [shape, small] of AGENT_SHAPES.flatMap((s) => [[s, false], [s, true]] as const)) {
    const pts = bodyOf(shape, small).pts;
    const n = pts.length / 2;
    let area = 0;
    let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
    for (let i = 0; i < n; i++) {
      const [x, y] = [pts[i * 2], pts[i * 2 + 1]];
      area += x * pts[((i + 1) % n) * 2 + 1] - pts[((i + 1) % n) * 2] * y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const weight = area / 2 / Math.PI;
    assert.ok(area > 0, `${shape} runs clockwise (y down)`);
    assert.ok(weight > 0.72 && weight < 1.02, `${shape} weighs ${weight.toFixed(2)} orbs`);
    assert.ok(Math.abs(x0 + x1) < 0.01 && Math.abs(y0 + y1) < 0.01, `${shape} is centred`);
    assert.ok(Math.max(-x0, x1, -y0, y1) < 1.42, `${shape} fits its box`);
  }
  // One outline per size (bloom alone has a small-size construction of its
  // own): nothing cut out of it, nothing resting in it.
  for (const shape of AGENT_SHAPES) assert.deepEqual(Object.keys(OUTLINES[shape]), shape === "bloom" ? ["pts", "small"] : ["pts"], `${shape} is one outline: nothing cut out of it, nothing resting in it`);
});

/** A body's silhouette rasterised as a face of `px` draws it (its small outline below 48 px), 4× supersampled. */
function swatchMask(shape: AgentShape, px = 30) {
  const pts = bodyOf(shape, !sizeClass(px).ring).pts;
  const k = pxPerR(px, sizeClass(px));
  const ss = 4;
  const n = px * ss;
  const N = pts.length / 2;
  const m = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / ss - px / 2) / k;
      const y = ((j + 0.5) / ss - px / 2) / k;
      let inside = false;
      for (let a = 0, b = N - 1; a < N; b = a++) {
        const [ax, ay, bx, by] = [pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]];
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      }
      m[j * n + i] = inside ? 1 : 0;
    }
  }
  return m;
}

test("nine distinct silhouettes in the 30 px picker: no two swatches alike, and only orb is round", () => {
  const masks = AGENT_SHAPES.map((shape) => swatchMask(shape));
  for (let a = 0; a < AGENT_SHAPES.length; a++) {
    for (let b = a + 1; b < AGENT_SHAPES.length; b++) {
      let I = 0;
      let U = 0;
      for (let i = 0; i < masks[a].length; i++) {
        I += masks[a][i] & masks[b][i];
        U += masks[a][i] | masks[b][i];
      }
      // Corners and lobes tell bloom from tile and prism from orb at the
      // same area; a second circle never would (halo healed was 0.98).
      assert.ok(I / U < 0.97, `${AGENT_SHAPES[a]} and ${AGENT_SHAPES[b]} draw alike at 30 px (IoU ${(I / U).toFixed(3)})`);
    }
  }
  for (const [shape, small] of AGENT_SHAPES.flatMap((s) => [[s, false], [s, true]] as const)) {
    if (shape === "orb") continue;
    const pts = bodyOf(shape, small).pts;
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const r = Math.hypot(pts[i], pts[i + 1]);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    assert.ok(hi / lo >= 1.1, `${shape} is nearly a circle (radius ${lo.toFixed(2)} to ${hi.toFixed(2)} R): it would read as a second orb`);
  }
  // Halo was a disc with a bite that healed into a second orb below 48 px.
  const orb = masks[AGENT_SHAPES.indexOf("orb")];
  const halo = masks[AGENT_SHAPES.indexOf("halo")];
  let I = 0;
  let U = 0;
  for (let i = 0; i < orb.length; i++) {
    I += orb[i] & halo[i];
    U += orb[i] | halo[i];
  }
  assert.ok(I / U < 0.9, `halo is ${(I / U).toFixed(3)} orb at 30 px`);
});

test("at 20 and 28 px thinking's three dots stay a pixel inside the face's box", () => {
  for (const px of [20, 24, 28, 40]) {
    const s = spec("orb", px);
    const pxR = pxPerR(px, s.size);
    const ctx = faceCtx(s, "none", 7, false);
    for (let t = 0; t < 1.5; t += 0.05) {
      const P = poseAt({ state: "thinking", at: -60, snap: null }, t, ctx);
      const f = drawFace(s, P, NO_EXTRAS, ids);
      const left = Number(f.d0.cx) - Number(f.d0.r);
      const right = Number(f.d1.cx) + Number(f.d1.r);
      const span = (right - left) * pxR;
      assert.ok(span <= px - 2 + 1e-6, `${px}px: the dots span ${span.toFixed(1)} px`);
    }
  }
});

test("every agent thinks with the same ellipsis: the middle dot is round, whatever the body", () => {
  // Was the body at dot size: spark thought as ●◆●, tile as ●■●, prism as ●⬢●.
  for (const shape of AGENT_SHAPES) {
    for (const px of [20, 28, 48, 96, 160]) {
      const s = spec(shape, px);
      const frame = drawFace(s, stillPose("thinking", faceCtx(s, "none", 0, false)), NO_EXTRAS, ids);
      // Every on-curve and control point of the drawn path, from the dot's centre.
      const pts = (frame.body.d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
      const radii: number[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) radii.push(Math.hypot(pts[i], pts[i + 1]));
      const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
      const dev = (Math.max(...radii) - Math.min(...radii)) / mean;
      assert.ok(dev < 0.02, `${shape} at ${px}px: the middle dot's radius varies ${(dev * 100).toFixed(1)}%`);
      assert.ok(Math.abs(mean - morphScale(s.size)) < 0.01, `${shape} at ${px}px: the middle dot is the side dots' size`);
    }
  }
  // …and the wind-down starts from the body's own silhouette.
  const s = spec("spark", 96);
  const early = morphOutline(bodyOf("spark").pts, 0.05, morphScale(s.size));
  const rest = bodyOf("spark").pts;
  let moved = 0;
  for (let i = 0; i < rest.length; i++) moved = Math.max(moved, Math.abs(early[i] - rest[i] * (1 + (morphScale(s.size) - 1) * 0.05)));
  assert.ok(moved < 0.03, `5% into the wind-down the spark is still a spark (moved ${moved.toFixed(3)} R off it)`);
});

test("an agent rests the same way round in every copy: the side comes from the agent, never the mount", () => {
  const sides = new Set<number>();
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      const avatar = { shape, tone: "teal", eyes, mark: "none" } as const;
      const identity = faceIdentity(avatar);
      for (const px of [48, 88, 96, 120, 160]) {
        const s = spec(shape, px, eyes);
        const yaws = [0, 1, 2, 7, 12345, 4294967295].map((seed) => stillPose("idle", faceCtx(s, "none", seed, true, identity)).yaw);
        assert.ok(yaws.every((y) => Math.sign(y) === Math.sign(yaws[0])), `${shape}/${eyes} at ${px}px rests looking both ways (${yaws.join(", ")})`);
        sides.add(Math.sign(yaws[0]));
        // The live face arriving on a page glides off the server's frame without turning.
        const live = faceCtx(s, "none", 99, true, identity);
        const painted = stillPose("idle", faceCtx(s, "none", 0, false, identity));
        const seg: Segment = { state: "idle", at: 37, snap: null, from: { pose: painted, at: 100 } };
        assert.ok(Math.sign(poseAt(seg, 100.5, live).yaw) === Math.sign(painted.yaw), `${shape}/${eyes} at ${px}px turns after hydration`);
      }
    }
  }
  assert.equal(sides.size, 2, "some agents rest looking up-left and some up-right");
  // One agent's pace is its own everywhere; different agents differ.
  const a = faceCtx(spec("orb", 20), "none", 1, true, faceIdentity({ shape: "orb", tone: "coral", eyes: "soft", mark: "none" }));
  const b = faceCtx(spec("orb", 34), "none", 2, true, faceIdentity({ shape: "orb", tone: "coral", eyes: "soft", mark: "none" }));
  assert.equal(a.pace, b.pace, "the same agent turns its ball at the same pace in the sidebar and the thread header");
});

test("every state draws at every size, shape and cut, with finite numbers only", () => {
  for (const state of AGENT_STATES) {
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        for (const px of [20, 28, 48, 96, 160]) {
          const s = spec(shape, px, eyes);
          const frame = drawFace(s, stillPose(state, faceCtx(s, "none", 0, false)), NO_EXTRAS, ids);
          for (const v of numbers(frame)) assert.ok(Number.isFinite(v), `${state} ${shape} ${eyes} ${px}px drew ${v}`);
        }
      }
    }
  }
});

test("every still pose reads on its own (reduced motion)", () => {
  const still = (state: AgentState, px = 96, shape: AgentShape = "orb") => {
    const s = spec(shape, px);
    const pose = stillPose(state, faceCtx(s, "none", 0, false));
    return { pose, frame: drawFace(s, pose, NO_EXTRAS, ids) };
  };
  const r = (attrs: Record<string, string>) => Number(attrs.r ?? 0);

  const idle = still("idle");
  assert.equal(idle.frame.body.d, bodyOf("orb").d, "idle is the resting body");
  assert.equal(r(idle.frame.bFront) + r(idle.frame.badgeBall), 0, "idle carries no ball");

  const thinking = still("thinking");
  assert.equal(thinking.pose.morph, 1, "thinking is the body as the middle dot");
  assert.ok(r(thinking.frame.d0) > 0 && r(thinking.frame.d1) > 0, "with a dot either side");
  assert.ok(Number(thinking.frame.d0.cy) > thinking.pose.by - 0.16 * 1.01, "the side dots sit below the raised middle one");

  const working = still("working");
  assert.ok(working.frame.rBack.d || working.frame.rFront.d, "working at 96 px draws the orbit");
  assert.ok(r(working.frame.bFront) + r(working.frame.bBack) > 0, "with its ball");
  for (const px of [20, 28]) {
    const small = still("working", px);
    assert.equal(small.frame.rFront.d + small.frame.rBack.d, "", `no orbit at ${px} px`);
    assert.ok(r(small.frame.bFront) > 0, `the ball rides the rim at ${px} px, in front`);
  }

  const waiting = still("waiting");
  assert.ok(r(waiting.frame.badgeBall) > 0, "waiting shows the needs-you ball");
  const blocked = still("blocked");
  assert.equal(r(blocked.frame.badgeBall), 0, "blocked is not the waiting ball");
  assert.ok(blocked.pose.tilt >= 10 && blocked.pose.eH <= 0.8, "with worried eyes: the cut shortened and leaned, tops in");
  assert.equal(Number(blocked.frame.badgeBar.width ?? 0), 0, "from 48 px blocked wears no sticker");
  assert.ok(blocked.frame.rBack.d && blocked.frame.rFront.d, "its orbit stands still instead");
  assert.equal(blocked.frame.rFront["data-tone"], "stalled", "in the stalled paint");
  assert.ok(r(blocked.frame.bFront) + r(blocked.frame.bBack) > 0, "with its ball at rest");
  assert.notEqual(blocked.frame.rFront.d, working.frame.rFront.d, "not where the working ball parks");
  for (const px of [20, 28]) {
    const small = still("blocked", px);
    assert.ok(Number(small.frame.badgeBar.width) > 0, `at ${px} px blocked shows its bar`);
    assert.equal(small.frame.rFront.d + small.frame.rBack.d, "", `and no orbit at ${px} px`);
  }

  const done = still("done");
  assert.ok(done.pose.smile > 0.8, "done lifts its lower lids into happy capsules");
  assert.equal(done.frame.rFront.d + done.frame.rBack.d, "", "and no ring");
  const sleeping = still("sleeping");
  assert.equal(sleeping.pose.lid, 0, "sleeping closes the eyes to dashes");
});

/** Samples a face's life: rest, then `script`, at 60 fps. */
function run(script: Array<[number, AgentState]>, px: number, until: number, shape: AgentShape = "orb") {
  const s = spec(shape, px);
  const ctx = faceCtx(s, "none", 7, false);
  let seg: Segment = { state: "idle", at: -60, snap: null };
  const frames: Array<{ t: number; seg: Segment; pose: ReturnType<typeof poseAt> }> = [];
  let next = 0;
  for (let t = 0; t <= until; t += 1 / 60) {
    while (next < script.length && script[next][0] <= t) {
      seg = { state: script[next][1], at: t, snap: snapshot(seg, t, ctx) };
      next++;
    }
    frames.push({ t, seg, pose: poseAt(seg, t, ctx) });
  }
  return { s, frames };
}

test("state changes blend: no field jumps between frames, and the body never overshoots", () => {
  // Per-frame limits at 60 fps: ease-outs start fast, but nothing cuts.
  const limits: Partial<Record<(typeof BLENDED)[number], number>> = { morph: 0.2, bs: 0.02, badgeS: 0.3, smile: 0.3, tilt: 2, eS: 0.05, lid: 0.35, yaw: 26, pitch: 12 };
  // Yaw is an angle: a face that went round the back is the same face at ±360°.
  const delta = (field: string, a: number, b: number) => (field === "yaw" ? Math.abs(((((b - a) % 360) + 540) % 360) - 180) : Math.abs(b - a));
  for (const state of AGENT_STATES) {
    const { frames } = run([[0.5, state], [4.5, "idle"], [5.5, state === "blocked" ? "waiting" : "blocked"]], 96, 8, "halo");
    for (let i = 1; i < frames.length; i++) {
      for (const [field, limit] of Object.entries(limits) as Array<[(typeof BLENDED)[number], number]>) {
        const a = frames[i - 1].pose[field];
        const b = frames[i].pose[field];
        assert.ok(Number.isFinite(b), `${state}: ${field} is finite`);
        assert.ok(delta(field, a, b) <= limit, `${state}: ${field} jumped ${a.toFixed(3)} → ${b.toFixed(3)} at ${frames[i].t.toFixed(2)} s`);
      }
      assert.ok(frames[i].pose.bs <= 1.04, `${state}: the body never swells past its lean-in`);
      assert.ok(frames[i].pose.morph >= 0 && frames[i].pose.morph <= 1, `${state}: morph stays in range`);
    }
  }
});

test("done stays done: the crescent holds for as long as the state does", () => {
  const { frames } = run([[0.3, "working"], [3.5, "done"]], 96, 40);
  const late = frames.filter((f) => f.t > 8);
  assert.ok(late.every((f) => f.pose.smile > 0.75), "still content well after the beat");
  assert.ok(late.every((f) => f.pose.ringO < 0.01), "and the ring has let go");
});

test("working shows in every frame at 20 and 28 px: the ball rides the rim in front", () => {
  for (const px of [20, 28]) {
    const { s, frames } = run([[0.2, "working"]], px, 12);
    for (const f of frames.filter((x) => x.t > 1)) {
      const frame = drawFace(s, f.pose, NO_EXTRAS, ids);
      assert.ok(Number(frame.bFront.r) > 0, `${px}px at ${f.t.toFixed(2)} s: the ball is visible`);
      assert.equal(f.pose.spinYaw, 0, `${px}px: no face spin at roster sizes`);
    }
  }
});

test("halo is the same silhouette in every state at every size: nothing heals, opens or pops", () => {
  for (const px of [20, 28, 48, 96, 160]) {
    const { s, frames } = run([[0.3, "working"], [3, "blocked"], [5, "waiting"], [7, "idle"]], px, 8.5, "halo");
    for (const f of frames) {
      if (f.pose.morph > 0.0005) continue;
      assert.equal(drawFace(s, f.pose, NO_EXTRAS, ids).body.d, bodyOf("halo").d, `${px}px at ${f.t.toFixed(2)} s: halo's outline changed`);
    }
  }
});

test("the stored mark is never drawn, only felt", () => {
  const s = spec("orb", 96);
  const frames = AGENT_MARKS.filter((m) => m !== "visor").map((mark) => JSON.stringify(drawFace(s, stillPose("idle", faceCtx(s, mark, 0, false)), NO_EXTRAS, ids)));
  assert.equal(new Set(frames).size, 1, "every mark but the hooded visor rests identically");
});

/* ------------------------------------------------------------------------ */
/* Clearances                                                               */
/* ------------------------------------------------------------------------ */

const num = (v: string | undefined) => Number(v ?? 0);
const matrixOf = (t: string) => {
  const m = /matrix\(([^)]*)\)/.exec(t);
  return m ? m[1].trim().split(/\s+/).map(Number) : null;
};
const pairs = (d: string) => {
  const out: Array<[number, number]> = [];
  const re = /(-?\d*\.?\d+(?:e-?\d+)?)\s+(-?\d*\.?\d+(?:e-?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push([Number(m[1]), Number(m[2])]);
  return out;
};
/** Every drawn eye point, in the body's frame. */
function eyePointsOf(frame: ReturnType<typeof drawFace>) {
  const out: Array<[number, number]> = [];
  for (const key of ["e0", "e1"] as const) {
    const e = frame[key];
    if (!e.d || e.opacity === "0") continue;
    const a = matrixOf(e.transform ?? "");
    if (!a) continue;
    for (const [x, y] of pairs(e.d)) out.push([a[0] * x + a[2] * y + a[4], a[1] * x + a[3] * y + a[5]]);
  }
  return out;
}
/** How far the nearest eye point sits outside the drawn notch (its rect knockout), in R; Infinity without one. */
function notchClearance(frame: ReturnType<typeof drawFace>) {
  const k = frame.kBadge;
  const w = num(k.width);
  const h = num(k.height);
  if (w <= 0 || h <= 0) return Infinity;
  const cx = num(k.x) + w / 2;
  const cy = num(k.y) + h / 2;
  let min = Infinity;
  for (const [x, y] of eyePointsOf(frame)) min = Math.min(min, stadiumDistance(x, y, cx, cy, w / 2, h / 2));
  return min;
}

test("the needs-you notch never bites an eye: at the glance hold, every body, cut and roster size", () => {
  for (const px of [28, 40, 48, 96]) {
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        const pose = poseAt({ state: "waiting", at: 0, snap: null }, 2.4, faceCtx(s, "none", 7, false));
        const gap = notchClearance(drawFace(s, pose, NO_EXTRAS, ids));
        assert.ok(gap >= 0.04, `${shape}/${eyes} at ${px}px: an eye comes within ${gap.toFixed(3)} R of the notch`);
      }
    }
  }
});

test("…and at no moment of a wait or a block, at any size, keeps less than 0.75 px of page round it", () => {
  for (const px of [20, 28, 48, 96]) {
    const pxR = pxPerR(px, sizeClass(px));
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        const ctx = faceCtx(s, "none", 7, false);
        const check = (pose: ReturnType<typeof poseAt>, what: string) => {
          const gap = notchClearance(drawFace(s, pose, NO_EXTRAS, ids)) * pxR;
          assert.ok(gap >= 0.75, `${what} ${shape}/${eyes} at ${px}px: ${gap.toFixed(2)} px between an eye and the notch`);
        };
        for (const state of ["waiting", "blocked"] as const) {
          check(stillPose(state, faceCtx(s, "none", 0, false)), `${state} still`);
          for (let t = 0; t <= 8.001; t += 0.1) check(poseAt({ state, at: 0, snap: null }, t, ctx), `${state} at ${t.toFixed(1)} s`);
        }
        // The swap between the two.
        const blocked: Segment = { state: "blocked", at: -60, snap: null };
        const swap: Segment = { state: "waiting", at: 0, snap: snapshot(blocked, 0, ctx) };
        for (let t = 0; t <= 1.2; t += 0.05) check(poseAt(swap, t, ctx), `blocked→waiting at ${t.toFixed(2)} s`);
      }
    }
  }
});

test("…and out of the dots into needs you the notch never bites an eye nor shoves the pair: every 240 fps frame, both sides, every body, the tall cut, several seeds", () => {
  // A head coming home from the dots is still turned ~70° 0.2 s in, its near
  // eye at the body's edge: a ball popping then bit that eye (the edge holds
  // the eyes' push at nothing) and, once the eye came clear, the whole push
  // landed in one frame (1.8 px at 48 px, 4.3 px at 160 px).
  // 240 fps: at 120 a one-frame shove at 96 px sits within 2.5 times the frames either side of it.
  const FPS = 240;
  const bites: string[] = [];
  const jumps: string[] = [];
  let changes = 0;
  let notched = 0;
  for (const px of [20, 28, 48, 96, 160]) {
    const pxR = pxPerR(px, sizeClass(px));
    for (const shape of AGENT_SHAPES) {
      const s = spec(shape, px, "tall");
      for (const id of [107, 101]) {
        for (const [n, seed] of [3, 11, 29].entries()) {
          const ctx = faceCtx(s, "none", seed, false, id);
          // In thinking for a beat, a while, or long enough to have settled into its dots.
          const thinking: Segment = { state: "thinking", at: 1, snap: snapshot({ state: "idle", at: -60, snap: null }, 1, ctx) };
          const Tc = 1 + [0.9, 1.6, 2.5][n];
          for (const to of ["waiting", "blocked"] as const) {
            const seg: Segment = { state: to, at: Tc, snap: snapshot(thinking, Tc, ctx) };
            const what = `${px}px ${shape}/tall side ${ctx.side} seed ${seed}, thinking→${to}`;
            changes++;
            const centres: Array<Array<[number, number] | null>> = [];
            // Until the ball has popped and settled (0.5 + 0.65 s).
            for (let i = 0; i <= 1.15 * FPS; i++) {
              const frame = drawFace(s, poseAt(seg, Tc + i / FPS, ctx), NO_EXTRAS, ids);
              const gap = notchClearance(frame);
              if (Number.isFinite(gap)) {
                notched++;
                if (gap * pxR < 0.75) bites.push(`${what} +${((1000 * i) / FPS).toFixed(0)} ms: ${(gap * pxR).toFixed(2)} px between an eye and the notch`);
              }
              centres.push(screenEyes(frame, px).map((e) => (e ? ([e.x, e.y] as [number, number]) : null)));
            }
            for (const k of [0, 1]) {
              const steps = centres.map((f, i) => (i && f[k] && centres[i - 1][k] ? Math.hypot(f[k]![0] - centres[i - 1][k]![0], f[k]![1] - centres[i - 1][k]![1]) : null));
              for (let i = 1; i < steps.length; i++) {
                const v = steps[i];
                if (v == null || v < Math.max(0.3, px / 300)) continue;
                const around = [i - 3, i - 2, i - 1, i + 1, i + 2, i + 3].map((j) => steps[j]).filter((x): x is number => x != null);
                const most = around.length ? Math.max(...around) : 0;
                if (v > 2.5 * most) jumps.push(`${what}: e${k} moves ${v.toFixed(2)} px in one frame at +${((1000 * i) / FPS).toFixed(0)} ms (${most.toFixed(2)} a frame either side)`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(changes >= 540 && notched > 40000, `${changes} changes, ${notched} frames with a notch`);
  assert.equal(bites.length, 0, `${bites.length} frames bite an eye:\n${bites.slice(0, 10).join("\n")}`);
  assert.equal(jumps.length, 0, `${jumps.length} one-frame shoves of the pair:\n${jumps.slice(0, 10).join("\n")}`);
});

test("halo's face sits in the broad lower half of its gumdrop, inside the body", () => {
  const halo = bodyOf("halo");
  assert.ok(halo.seat.oy > 0.05, "the eyes sit below the centre, where the gumdrop is wide");
  for (const px of [20, 48, 160]) {
    const s = spec("halo", px);
    const frame = drawFace(s, stillPose("idle", faceCtx(s, "none", 0, false)), NO_EXTRAS, ids);
    for (const [x, y] of eyePointsOf(frame)) assert.ok(polySd(halo.pts, x, y) < -0.02, `${px}px: an eye point at ${x.toFixed(2)}, ${y.toFixed(2)} leaves the body`);
  }
});

test("the parked orbit (reduced motion) leaves no stub of ring poking past a flank", () => {
  for (const px of [48, 88, 96, 160]) {
    for (const shape of AGENT_SHAPES) {
      const s = spec(shape, px);
      const frame = drawFace(s, stillPose("working", faceCtx(s, "none", 0, false)), NO_EXTRAS, ids);
      const pts = bodyOf(shape).pts;
      const n = pts.length / 2;
      // Signed distance to the outline polygon: negative inside.
      const sd = (x: number, y: number) => {
        let d = Infinity;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const [ax, ay, bx, by] = [pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]];
          const ex = bx - ax, ey = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
          d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
          if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        }
        return inside ? -d : d;
      };
      const ends: Array<[number, number]> = [];
      for (const sub of (frame.rBack.d ?? "").split("M").filter(Boolean)) {
        const nums = (sub.match(/-?\d*\.?\d+/g) ?? []).map(Number);
        ends.push([nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]);
      }
      for (const [x, y] of ends) {
        const d = sd(x, y);
        assert.ok(d <= 0 || d >= 0.15, `${shape} at ${px}px: the far half ends ${d.toFixed(3)} R outside the body`);
      }
    }
  }
});

test("the small working ball swings over the lower right: never under the eyes, never on the eye line", () => {
  for (const px of [20, 28]) {
    const { s, frames } = run([[0.2, "working"]], px, 14);
    for (const f of frames.filter((x) => x.t > 0.6)) {
      const ang = rimBallAngle(f.pose.ringPhase);
      assert.ok(ang >= 10 && ang <= 75, `${px}px: the ball at ${ang.toFixed(0)}°`);
      const frame = drawFace(s, f.pose, NO_EXTRAS, ids);
      const cx = num(frame.bFront.cx);
      const cy = num(frame.bFront.cy);
      assert.ok(cx > 0.3 && cy > 0.2, `${px}px: the ball sits lower right, at ${cx.toFixed(2)}, ${cy.toFixed(2)}`);
    }
  }
});

/* ------------------------------------------------------------------------ */
/* Motion                                                                   */
/* ------------------------------------------------------------------------ */

test("into thinking large faces turn away as the body winds down: the eyes are carried off, never flicked or faded on the spot", () => {
  for (const from of ["idle", "working", "waiting", "blocked", "done", "listening"] as const) {
    for (const px of [48, 96, 160]) {
      const { s, frames } = run([[0.3, from], [3, "thinking"]], px, 4.2, "orb");
      const pxR = pxPerR(px, s.size);
      let prev: Array<[number, number] | null> | null = null;
      for (const f of frames) {
        if (f.t < 3) continue;
        const P = f.pose;
        if (P.morph >= 0.6) {
          for (const F of eyeFrames(P.yaw + P.spinYaw, P.pitch, P.froll, P.split)) {
            assert.ok(F.z < 0.17, `${from}→thinking ${px}px at ${f.t.toFixed(2)} s: an eye is still facing out (z ${F.z.toFixed(2)}) with the body ${(P.morph * 100).toFixed(0)}% wound`);
          }
        }
        const frame = drawFace(s, P, NO_EXTRAS, ids);
        const at = (["e0", "e1"] as const).map((k) => {
          const m = matrixOf(frame[k].transform ?? "");
          return m && frame[k].opacity !== "0" ? ([m[4], m[5]] as [number, number]) : null;
        });
        if (prev) {
          for (let j = 0; j < 2; j++) {
            const a0 = prev[j];
            const a1 = at[j];
            if (!a0 || !a1) continue;
            // 0.17 R a frame: under 6 px at 96 px, never the 9 to 11 px flick of a turn with no ease-in.
            const step = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
            assert.ok(step <= 0.17, `${from}→thinking ${px}px at ${f.t.toFixed(2)} s: an eye moved ${(step * pxR).toFixed(1)} px in a frame`);
          }
        }
        prev = at;
      }
    }
  }
});

test("into thinking small faces close their eyes before the body winds down (a turn at 28 px is a jump)", () => {
  for (const px of [20, 28]) {
    const { frames } = run([[0.5, "thinking"]], px, 2);
    for (const f of frames) {
      if (f.pose.morph <= 0.01) continue;
      assert.ok(f.pose.lid <= 0.05, `${px}px at ${f.t.toFixed(2)} s: the eyes are open (lid ${f.pose.lid.toFixed(2)}) as the body winds`);
      assert.ok(Math.abs(f.pose.yaw - frames[0].pose.yaw) < 1, `${px}px: the face does not turn`);
    }
  }
});

test("out of thinking nothing pops: the dots merge in their wave, the body re-inflates gently, the face turns back the way it went", () => {
  for (const next of ["idle", "listening", "working"] as const) {
    const { s, frames } = run([[0.5, "thinking"], [3, next]], 160, 5);
    let path = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (b.t < 3) continue;
      const fa = drawFace(s, a.pose, NO_EXTRAS, ids);
      const fb = drawFace(s, b.pose, NO_EXTRAS, ids);
      for (const dot of ["d0", "d1"] as const) {
        assert.ok(Math.abs(num(fb[dot].r) - num(fa[dot].r)) < 0.04, `→${next} at ${b.t.toFixed(2)} s: a side dot's size jumped`);
        if (num(fa[dot].r) > 0 && num(fb[dot].r) > 0) assert.ok(Math.abs(num(fb[dot].cy) - num(fa[dot].cy)) < 0.04, `→${next} at ${b.t.toFixed(2)} s: a side dot jumped`);
      }
      assert.ok(a.pose.morph - b.pose.morph < 0.12, `→${next} at ${b.t.toFixed(2)} s: the body re-inflated ${(a.pose.morph - b.pose.morph).toFixed(2)} in a frame`);
      const turn = b.pose.yaw + b.pose.spinYaw - a.pose.yaw - a.pose.spinYaw;
      path += Math.abs(((((turn + 180) % 360) + 360) % 360) - 180);
    }
    assert.ok(path < 140, `→${next}: the face turned ${path.toFixed(0)}° to come home`);
  }
});

test("working is calm: one face spin as it kicks into gear, then only the orbit turns", () => {
  const { frames } = run([[0.2, "working"]], 96, 40);
  const spinning = frames.filter((f) => f.pose.spinYaw !== 0);
  assert.ok(spinning.length > 0, "it spins once");
  assert.ok(spinning.every((f) => f.t < 2.3), "and never again");
  const late = frames.filter((f) => f.t > 6);
  for (let i = 1; i < late.length; i++) {
    const speed = (late[i].pose.ringPhase - late[i - 1].pose.ringPhase) * 60;
    assert.ok(speed > 84 && speed < 108, `the orbit turns at ${speed.toFixed(0)}°/s`);
    assert.equal(late[i].pose.by, 0, "no beat");
  }
});

test("faces mounted together never move in lockstep: each orbits at its own pace", () => {
  const s = spec("orb", 96);
  const T0 = 100;
  const COUNT = 40;
  const phases: number[] = [];
  const paces: number[] = [];
  for (let seed = 1; seed <= COUNT; seed++) {
    const ctx = faceCtx(s, "none", seed * 7919, true);
    assert.ok(ctx.pace >= 0.9 && ctx.pace <= 1.1, `pace ${ctx.pace.toFixed(3)} stays within ±10%`);
    paces.push(ctx.pace);
    // Painted alike and mounted in the same frame, as a page load does.
    const seg: Segment = { state: "working", at: T0 - 63, snap: null, from: { pose: stillPose("working", faceCtx(s, "none", 0, false)), at: T0 } };
    phases.push(poseAt(seg, T0 + 10, ctx).ringPhase);
  }
  assert.ok(Math.max(...paces) - Math.min(...paces) > 0.15, "the paces spread over the range");
  let apart = 0;
  let pairs = 0;
  for (let a = 0; a < COUNT; a++) {
    for (let b = a + 1; b < COUNT; b++) {
      pairs++;
      const d = Math.abs(((((phases[a] - phases[b]) % 360) + 540) % 360) - 180);
      if (d > 8) apart++;
    }
  }
  // Uniform paces over ±10% leave about one pair in ten within 8° at 10 s, and they part later.
  assert.ok(apart / pairs >= 0.8, `after 10 s only ${apart} of ${pairs} pairs of balls are more than 8° apart`);
});

test("thinking faces mounted together never pulse as one, even at roster sizes on the chat's exact rhythm", () => {
  for (const px of [20, 28, 34, 96]) {
    const s = spec("orb", px);
    const T0 = 100;
    const phases = [11, 222, 3333, 44444, 555555].map((seed) => {
      const ctx = faceCtx(s, "none", seed, true);
      const painted = stillPose("thinking", faceCtx(s, "none", 0, false));
      const seg: Segment = { state: "thinking", at: T0 - 63, snap: null, from: { pose: painted, at: T0 } };
      // The arrival starts from the painted frame: no jump.
      assert.equal(poseAt(seg, T0, ctx).pulse, painted.pulse, `${px}px: the wave starts where it was painted`);
      return (((poseAt(seg, T0 + 3, ctx).pulse % 1.4) + 1.4) % 1.4);
    });
    // The circular spread of the five phases: the period less the widest gap between neighbours.
    const sorted = [...phases].sort((a, b) => a - b);
    const gaps = sorted.map((p, i) => (i ? p - sorted[i - 1] : p + 1.4 - sorted.at(-1)!));
    const spread = 1.4 - Math.max(...gaps);
    assert.ok(spread > 0.3, `${px}px: five thinking faces mounted together pulse within ${spread.toFixed(2)} s of each other`);
  }
});

test("rest is event driven: a settled face asks for no frames until its next blink or glance", () => {
  const s = spec("orb", 48);
  const still = faceCtx(s, "none", 7, false);
  const live = faceCtx(s, "none", 7, true);
  const seg: Segment = { state: "idle", at: 0, snap: null };
  assert.equal(nextChange(seg, 3, still, poseAt(seg, 3, still)), Infinity, "an idle face without rest life never wakes");
  let wakes = 0;
  for (let T = 2; T < 62; T += 0.25) {
    const n = nextChange(seg, T, live, poseAt(seg, T, live));
    if (n > T) wakes++;
    assert.ok(n >= T && Number.isFinite(n), "a live face always has a next blink or glance");
  }
  assert.ok(wakes > 200, `a live idle face is at rest most of the time (${wakes} of 240 samples)`);
  const waiting: Segment = { state: "waiting", at: 0, snap: null };
  const w = faceCtx(s, "none", 7, false);
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);
  // Each copy looks a beat of its own late (0 to 120 ms: needs you never runs in lockstep).
  const beat = nextChange(waiting, 3.6, w, poseAt(waiting, 3.6, w)) - 5.8;
  assert.ok(beat >= 0 && beat <= 0.12, `a wait wakes for its next look at the badge, ${beat.toFixed(3)} s after the house beat`);
  near(nextChange(waiting, 21, w, poseAt(waiting, 21, w)), 21, "and moves while it looks");
  near(nextChange(waiting, 30, w, poseAt(waiting, 30, w)), 36.4 + beat, "then every 16 s");
  const working: Segment = { state: "working", at: 0, snap: null };
  assert.equal(nextChange(working, 30, w, poseAt(working, 30, w)), 30, "working always moves");
});

test("a face arriving on a page glides off its painted still: no first-frame jump", () => {
  for (const state of AGENT_STATES) {
    for (const px of [20, 96]) {
      const s = spec("capsule", px);
      const ctx = faceCtx(s, "none", 7, true);
      const painted = stillPose(state, faceCtx(s, "none", 0, false));
      const seg: Segment = { state, at: 100 - 63.3, snap: null, from: { pose: painted, at: 100 } };
      const first = poseAt(seg, 100, ctx);
      for (const f of BLENDED) assert.ok(Math.abs(first[f] - painted[f]) < 1e-9, `${state} ${px}px: ${f} jumps on arrival`);
      assert.ok(Math.abs(first.ringPhase - painted.ringPhase) < 1e-9, `${state} ${px}px: the orbit's ball starts where it was painted`);
      const later = poseAt(seg, 100 + 1 / 60, ctx);
      assert.ok(Math.abs(later.ringPhase - first.ringPhase) < 2, `${state} ${px}px: and moves off it smoothly`);
    }
  }
});

/* ------------------------------------------------------------------------ */
/* The orbit fits every body                                                */
/* ------------------------------------------------------------------------ */

/** Signed distance from a point to a closed polygon (x,y interleaved): negative inside. */
function polySd(pts: ArrayLike<number>, x: number, y: number) {
  const n = pts.length / 2;
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay, bx, by] = [pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -d : d;
}

/** The body outline as drawn for a pose (drawFace's bodyT, without the thinking pulse), in the face's frame. */
function placedOutline(shape: AgentShape, P: Pose) {
  const B = bodyOf(shape);
  const rot = P.brot * B.seat.tilt * (Math.PI / 180);
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const out = new Float64Array(B.pts.length);
  for (let i = 0; i < B.pts.length; i += 2) {
    const x = B.pts[i] * P.bsx * P.bs;
    const y = ((B.pts[i + 1] - 1) * P.bsy + 1 - 1) * P.bs + P.bs; // translate(0 1) scale translate(0 -1), then scale
    out[i] = P.bx + x * c - y * sn;
    out[i + 1] = P.by + x * sn + y * c;
  }
  return out;
}

test("the orbit's near half passes under every body, never through it: at every phase, size and shape it keeps its cut-paper gap", () => {
  for (const shape of AGENT_SHAPES) {
    for (const px of [48, 96, 160]) {
      const s = spec(shape, px);
      const base = stillPose("working", faceCtx(s, "none", 0, false));
      for (let phase = 0; phase < 360; phase += 5) {
        const P: Pose = { ...base, ringPhase: phase };
        const O = orbitFrame(s, P);
        const outline = placedOutline(shape, P);
        const need = O.sw / 2 + O.gapK;
        for (let phi = O.start; phi <= O.end; phi += Math.PI / 180) {
          if (Math.sin(phi) <= 0) continue;
          const [x, y] = O.pt(phi);
          const d = polySd(outline, x, y);
          assert.ok(d >= need - 1e-6, `${shape} at ${px}px, phase ${phase}°: the near ring comes ${d.toFixed(3)} R from the body (needs ${need.toFixed(3)})`);
        }
      }
    }
  }
});

test("blocked's stalled orbit rests its ball at the bottom, clear of every body", () => {
  for (const shape of AGENT_SHAPES) {
    for (const px of [48, 96, 160]) {
      const s = spec(shape, px);
      const P = stillPose("blocked", faceCtx(s, "none", 0, false));
      const frame = drawFace(s, P, NO_EXTRAS, ids);
      const ball = Number(frame.bFront.r) > 0 ? frame.bFront : frame.bBack;
      const cx = num(ball.cx);
      const cy = num(ball.cy);
      assert.ok(cy > 0.9, `${shape} at ${px}px: the ball rests low (${cy.toFixed(2)})`);
      const knock = Number(frame.kBall.r) || Number(ball.r);
      const d = polySd(placedOutline(shape, P), cx, cy) - knock;
      assert.ok(d >= 0, `${shape} at ${px}px: the resting ball's notch cuts ${(-d).toFixed(3)} R into the body`);
    }
  }
});

test("working's small rim ball never bites an eye: every frame of 8 s, every body and cut, at 20 and 28 px", () => {
  for (const px of [20, 28]) {
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        const margin = eyeNotchMargin(s);
        const ctx = faceCtx(s, "none", 7, false);
        for (const from of ["idle", "thinking"] as const) {
          const enter: Segment = { state: "working", at: 0, snap: snapshot({ state: from, at: -60, snap: null }, 0, ctx) };
          for (let t = 0; t <= 8; t += 1 / 30) {
            const P: Pose = { ...poseAt(enter, t, ctx), blinkMul: 1 };
            const frame = drawFace(s, P, NO_EXTRAS, ids);
            const r = Number(frame.kBall.r ?? 0);
            if (!(r > 0)) continue;
            const cx = num(frame.kBall.cx);
            const cy = num(frame.kBall.cy);
            for (const [x, y] of eyePointsOf(frame)) {
              // Eyes are drawn in the body's frame: working stands upright, so it is a scale and a shift.
              const gx = P.bx + x * P.bs;
              const gy = P.by + y * P.bs;
              const gap = Math.hypot(gx - cx, gy - cy) - r;
              assert.ok(gap >= margin * P.bs - 1e-3, `${shape}/${eyes} at ${px}px from ${from}, ${t.toFixed(2)} s: an eye comes ${gap.toFixed(3)} R from the ball's notch (needs ${margin.toFixed(3)})`);
            }
          }
        }
      }
    }
  }
});

/** Whether a point lies inside a closed polygon (x,y interleaved). */
function insidePoly(pts: ArrayLike<number>, x: number, y: number) {
  let c = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi, xj, yj] = [pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

test("small faces never lose their eyes as working gives way to needs you or blocked: every body, cut and ring phase, every 4 ms", () => {
  // The rim ball still leaving at the lower right and the notch opening at
  // the upper left once pushed both eyes out of a 20 px body for up to 216 ms.
  for (const px of [20, 28, 34, 40]) {
    for (const shape of AGENT_SHAPES) {
      const B = bodyOf(shape, true);
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        const ctx = faceCtx(s, "none", 7, false);
        const working: Segment = { state: "working", at: 0, snap: snapshot({ state: "idle", at: -60, snap: null }, 0, ctx) };
        for (const to of ["waiting", "blocked"] as const) {
          for (const settle of [4, 4.31, 4.77, 5.23, 5.9, 6.6]) {
            const seg: Segment = { state: to, at: settle, snap: snapshot(working, settle, ctx) };
            for (let t = 0; t <= 0.8; t += 0.004) {
              const P = poseAt(seg, settle + t, ctx);
              if (P.morph > 0.3 || P.lid * P.blinkMul < 0.2) continue; // meant to be shut
              const frame = drawFace(s, P, NO_EXTRAS, ids);
              const outline = morphOutline(B.pts, Math.max(0, Math.min(1, P.morph)), morphScale(s.size));
              const seen = (["e0", "e1"] as const).some((k) => {
                const m = matrixOf(frame[k].transform ?? "");
                return !!m && Number(frame[k].opacity ?? 1) > 0.3 && insidePoly(outline, m[4], m[5]);
              });
              assert.ok(seen, `${shape}/${eyes} at ${px}px, working→${to} from ring phase ${settle} at +${Math.round(t * 1000)} ms: no eye inside the body`);
            }
          }
        }
      }
    }
  }
});

/* ------------------------------------------------------------------------ */
/* Smoothing: every transition that plays runs to its end                   */
/* ------------------------------------------------------------------------ */

/** Plays requests through the runtime's gate (gateAt) and the pose engine: the segments that reach the screen. */
function smoothed(requests: Array<[number, AgentState]>, px: number, until: number) {
  const s = spec("orb", px);
  const ctx = faceCtx(s, "none", 7, false);
  let seg: Segment = { state: "idle", at: -60, snap: null };
  let gate: Gate = { state: "idle", shownAt: -Infinity, spinUntil: 0 };
  const shown: Segment[] = [seg];
  let wanted: AgentState = "idle";
  let timer: number | null = null;
  const apply = (state: AgentState, t: number) => {
    seg = { state, at: t, snap: snapshot(seg, t, ctx) };
    gate = { state, shownAt: t * 1000, spinUntil: t * 1000 + spinHold(state, s.size, seg.snap) * 1000 };
    shown.push(seg);
  };
  const queue = [...requests];
  for (;;) {
    const nextReq = queue.length ? queue[0][0] : Infinity;
    if (timer !== null && timer <= nextReq) {
      const t = timer;
      timer = null;
      if (wanted !== seg.state) apply(wanted, t);
      continue;
    }
    if (!queue.length) break;
    const [t, next] = queue.shift()!;
    wanted = next;
    timer = null;
    if (next === seg.state) continue;
    const at = gateAt(gate, next, t * 1000) / 1000;
    if (at <= t) apply(next, t);
    else timer = at;
  }
  const frames: Array<{ t: number; seg: Segment; pose: Pose }> = [];
  for (let t = 0; t <= until; t += 1 / 60) {
    let cur = shown[0];
    for (const g of shown) if (g.at <= t) cur = g;
    frames.push({ t, seg: cur, pose: poseAt(cur, t, ctx) });
  }
  return { shown, frames };
}

test("an agent loop flipping between thinking and working: every working beat gets its ball out", () => {
  // Model turn, tool call, model turn, tool call, finished: each at the old 700 ms minimum.
  const script: Array<[number, AgentState]> = [[0, "thinking"], [0.7, "working"], [1.4, "thinking"], [2.1, "working"], [2.8, "done"]];
  for (const px of [34, 96]) {
    const { shown, frames } = smoothed(script, px, 6);
    const working = shown.filter((g) => g.state === "working");
    assert.ok(working.length >= 1, "working reaches the screen");
    for (const w of working) {
      const end = shown[shown.indexOf(w) + 1]?.at ?? Infinity;
      const peak = Math.max(...frames.filter((f) => f.seg === w && f.t < end).map((f) => f.pose.ballS));
      assert.ok(peak >= 0.999, `${px}px: the working beat at ${w.at.toFixed(2)} s ended with its ball at ${peak.toFixed(2)}`);
    }
    for (let i = 1; i < shown.length; i++) {
      const a = shown[i - 1];
      const b = shown[i];
      if ((a.state === "working" || a.state === "thinking") && (b.state === "working" || b.state === "thinking")) {
        assert.ok(b.at - a.at >= 1.4 - 1e-9, `${px}px: ${a.state} held only ${(b.at - a.at).toFixed(2)} s before ${b.state}`);
      }
    }
  }
});

test("an agent loop is calm: a model turn between two tool calls stays working, and a tool blip inside a model turn never throws a ring", () => {
  const base = (state: AgentState): Gate => ({ state, shownAt: 0, spinUntil: 0 });
  assert.equal(gateAt(base("working"), "thinking", 5000), 7500, "thinking is held 2.5 s out of working");
  assert.equal(gateAt(base("thinking"), "working", 5000), 5400, "working is held 400 ms out of thinking");
  assert.equal(gateAt(base("thinking"), "working", 100), 1400, "…and never before the busy minimum");
  // A seeded loop: reasoning 1 to 4 s, tools 0.4 to 3 s.
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const requests: Array<[number, AgentState]> = [];
  let t = 0.5;
  for (let i = 0; i < 40; i++) {
    requests.push([t, "thinking"]);
    t += 1 + 3 * rand();
    requests.push([t, "working"]);
    t += 0.4 + 2.6 * rand();
  }
  const { shown } = smoothed(requests, 20, t);
  const perMinute = ((shown.length - 1) / t) * 60;
  assert.ok(perMinute <= 18, `${perMinute.toFixed(1)} shown changes a minute`);
});

test("a preview a person drives (the studio, the hire flow) answers every click at once: no smoothing", () => {
  for (const from of AGENT_STATES) {
    for (const next of AGENT_STATES) {
      if (from === next) continue;
      // Just shown, mid-spin: the worst case for the loop smoothing.
      const g: Gate = { state: from, shownAt: 5000, spinUntil: 6450 };
      assert.equal(changeAt(g, next, 5016, true), 5016, `${from}→${next} is held in a preview`);
    }
  }
  // An agent's own face keeps the smoothing.
  assert.equal(changeAt({ state: "working", shownAt: 0, spinUntil: 0 }, "thinking", 5000), 7500);
});

test("a change never interrupts the working face spin, except one that needs you, which comes home without a whip", () => {
  for (const next of ["done", "thinking"] as const) {
    for (const at of [0.6, 1.0, 1.3]) {
      const { shown, frames } = smoothed([[0, "working"], [at, next]], 96, 4);
      const change = shown.find((g) => g.state === next);
      assert.ok(change, `${next} reaches the screen`);
      assert.ok(change.at >= 1.45 - 1e-9, `${next} requested at ${at} s went on at ${change.at.toFixed(2)} s, mid-spin`);
      assert.ok(Math.abs(change.snap!.yaw) < 60, `${next}: the come-home starts at yaw ${change.snap!.yaw.toFixed(0)}°, not mid-turn`);
      const spun = frames.filter((f) => f.seg.state === "working" && f.pose.spinYaw !== 0);
      assert.ok(spun.length > 0 && spun.every((f) => f.t < change.at), "the spin ran whole");
    }
  }
  // Needs you is never kept waiting behind the spin: the face comes home
  // from wherever the spin got to, the same way round, never faster than the
  // spin itself turns (18° a frame at its peak).
  const turn = (f: { pose: Pose }) => f.pose.yaw + f.pose.spinYaw;
  for (const next of ["waiting", "blocked"] as const) {
    for (const at of [0.6, 1.0, 1.3]) {
      const { shown, frames } = smoothed([[0, "working"], [at, next]], 96, 4);
      const change = shown.find((g) => g.state === next);
      assert.ok(change, `${next} reaches the screen`);
      assert.ok(Math.abs(change.at - Math.max(0.7, at)) < 1e-9, `${next} requested at ${at} s went on at ${change.at.toFixed(2)} s`);
      for (let i = 1; i < frames.length; i++) {
        const step = Math.abs(((((turn(frames[i]) - turn(frames[i - 1])) % 360) + 540) % 360) - 180);
        assert.ok(step <= 18.5, `${next} at ${at} s: the face turned ${step.toFixed(1)}° in one frame at ${frames[i].t.toFixed(2)} s`);
      }
      // …and faces you before its badge has popped: an eye is out front within 0.3 s.
      const back = frames.find((f) => f.t >= change.at + 0.3)!;
      const z = Math.max(...eyeFrames(turn(back), back.pose.pitch, back.pose.froll, back.pose.split).map((F) => F.z));
      assert.ok(z > 0.3, `${next} at ${at} s: 0.3 s in, the face is still turned away (z ${z.toFixed(2)})`);
    }
  }
  // Out of thinking there is no spin, so nothing is held for one.
  const s = spec("orb", 96);
  const ctx = faceCtx(s, "none", 7, false);
  const fromDots = snapshot({ state: "thinking", at: -60, snap: null }, 0, ctx);
  assert.equal(spinHold("working", s.size, fromDots), 0, "no spin out of thinking");
  assert.equal(spinHold("working", sizeClass(28), null), 0, "no spin at roster sizes");
});

test("the orbit leaves as it came: it reels into its ball in under half a second, never a cut, and the ball never hangs alone", () => {
  for (const next of ["idle", "waiting", "blocked", "listening", "sleeping"] as const) {
    const { frames } = run([[0.2, "working"], [4, next]], 96, 5.5);
    const out = frames.filter((f) => f.t >= 4);
    const at = (t: number) => out.find((f) => f.t >= 4 + t)!.pose;
    if (next === "blocked") continue; // the orbit stays, stalled
    assert.ok(at(0.1).ringO > 0.95 && at(0.1).ballS > 0.95, `→${next}: still whole 0.1 s in`);
    assert.ok(at(0.25).ringP < at(0.05).ringP, `→${next}: the ring reels in first`);
    assert.ok(at(0.62).ringO < 0.02, `→${next}: gone by 0.62 s`);
    for (const f of out.filter((x) => x.t < 4.33)) assert.ok(f.pose.ringO > 0.99, `→${next}: the ring stays opaque while it reels in (${f.pose.ringO.toFixed(2)} at ${(f.t - 4).toFixed(2)} s)`);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].pose.ringP <= out[i - 1].pose.ringP + 1e-9, `→${next}: the ring only reels in`);
    }
    // The ball sinks into nothing while the last of the ring reels in, opaque
    // throughout: never a lone dot shrinking and fading beside the body.
    for (const f of out) {
      if (f.pose.ballS > 0.002 && f.pose.ringO > 0.002) assert.ok(f.pose.ringO > 0.999, `→${next}: the ball fades (${f.pose.ringO.toFixed(2)}) at ${(f.t - 4).toFixed(2)} s`);
    }
    const lone = out.filter((f) => f.pose.ringP < 0.01 && f.pose.ballS > 0.05 && f.pose.ringO > 0.002).length / 60;
    assert.ok(lone <= 0.1, `→${next}: the ball hangs alone for ${lone.toFixed(2)} s once the ring is in`);
    assert.ok(at(0.15).ballS > 0.99, `→${next}: the ball waits for most of the ring to reel in`);
    // The reel shows in the first frames (an ease-out, never a held beat)…
    assert.ok(at(0.1).ringP < 0.6, `→${next}: only ${((1 - at(0.1).ringP) * 100).toFixed(0)}% reeled in 0.1 s after the change`);
  }
  // …and no stub of ring outlives its ball, out of working at any size.
  for (const px of [28, 48, 96, 160]) {
    for (const next of ["idle", "waiting", "listening", "sleeping", "thinking"] as const) {
      const { frames } = run([[0.2, "working"], [4, next]], px, 5.5);
      for (const f of frames.filter((x) => x.t >= 4)) {
        if (f.pose.ballS < 0.15 && f.pose.ringO > 0.002) assert.ok(f.pose.ringP < 0.002, `${px}px →${next} at ${(f.t - 4).toFixed(2)} s: ring ${f.pose.ringP.toFixed(3)} left with its ball at ${f.pose.ballS.toFixed(2)}`);
      }
    }
  }
});

test("working to thinking reels the orbit in while the head turns away: opaque, never a cut, gone before half a second", () => {
  for (const px of [28, 96]) {
    const { s, frames } = run([[0.2, "working"], [4, "thinking"]], px, 5);
    const out = frames.filter((f) => f.t >= 4);
    for (let i = 1; i < out.length; i++) {
      const P = out[i].pose;
      const ts = out[i].t - 4;
      const visible = P.ringP > 0.002 || P.ballS > 0.002;
      if (visible) assert.ok(P.ringO > 0.99, `${px}px at ${ts.toFixed(2)} s: the orbit fades (${P.ringO.toFixed(2)}) instead of reeling in`);
      assert.ok(P.ringP <= out[i - 1].pose.ringP + 1e-9, `${px}px: the ring only reels in`);
      assert.ok(out[i - 1].pose.ballS - P.ballS < 0.25, `${px}px at ${ts.toFixed(2)} s: the ball cut from ${out[i - 1].pose.ballS.toFixed(2)} to ${P.ballS.toFixed(2)}`);
      if (ts > 0.45) assert.ok(!visible, `${px}px: still drawn at ${ts.toFixed(2)} s`);
    }
    // At 28 px the rim ball sinks over frames, never in one.
    if (!s.size.ring) assert.ok(out.filter((f) => f.pose.ballS > 0.05 && f.pose.ballS < 0.95).length >= 4, "the rim ball sinks over several frames");
  }
});

test("blocked enters calmly: its stalled ball rises first and the ring is drawn out of it, in the stalled paint from the first frame", () => {
  for (const from of ["idle", "waiting", "thinking", "done"] as const) {
    const { s, frames } = run([[0.2, from], [3, "blocked"]], 96, 4.5, "halo");
    const into = frames.filter((f) => f.t >= 3);
    for (const f of into) {
      const P = f.pose;
      const ts = f.t - 3;
      if (P.ringP > 0.02) assert.ok(P.ballS > 0.3, `${from}→blocked at ${ts.toFixed(2)} s: ring ${P.ringP.toFixed(2)} with no ball to come from`);
      assert.ok(P.ringP <= outCubicRef((ts - 0.25) / 0.7) + 1e-9, `${from}→blocked at ${ts.toFixed(2)} s: the ring is there before it is drawn`);
      const frame = drawFace(s, P, NO_EXTRAS, ids);
      for (const part of ["rBack", "rFront", "bBack", "bFront"] as const) assert.equal(frame[part]["data-tone"], "stalled", `${from}→blocked at ${ts.toFixed(2)} s: ${part} is not in the stalled paint`);
    }
    assert.ok(into.at(-1)!.pose.ringP > 0.99 && into.at(-1)!.pose.ballS > 0.99, `${from}→blocked: the stalled orbit is whole`);
  }
  // Every hidden orbit part still carries its paint, marked off (no transition while hidden).
  const s = spec("orb", 96);
  const idle = drawFace(s, stillPose("idle", faceCtx(s, "none", 0, false)), NO_EXTRAS, ids);
  for (const part of ["rBack", "rFront", "bBack", "bFront"] as const) {
    assert.ok(idle[part]["data-tone"] && "data-off" in idle[part], `${part} drops its paint while hidden`);
  }
});

test("blocked leaves as one piece: the red ball goes with the grey ring, never left alone under the body", () => {
  for (const next of ["idle", "waiting", "listening", "sleeping", "thinking", "done"] as const) {
    const { frames } = run([[0.2, "blocked"], [3, next]], 96, 4.5);
    const out = frames.filter((f) => f.t >= 3);
    const s = spec("orb", 96);
    for (const f of out) {
      const P = f.pose;
      if (P.ringO < 0.01) continue;
      const ts = (f.t - 3).toFixed(2);
      assert.ok(P.ballS <= Math.min(1, P.ringP / 0.12 + 0.05), `blocked→${next} at ${ts} s: the ball (${P.ballS.toFixed(2)}) outlives its ring (${P.ringP.toFixed(2)})`);
      assert.ok(P.ballS > 0.5 || P.ringP <= P.ballS + 0.1, `blocked→${next} at ${ts} s: a stub of ring (${P.ringP.toFixed(2)}) outlives its ball (${P.ballS.toFixed(2)})`);
      // What little ring is left as the ball goes is drawn fading with it.
      if (P.ballS < 0.15 && P.ringP > 0.002) {
        const frame = drawFace(s, P, NO_EXTRAS, ids);
        const op = Number(frame.rFront.opacity ?? frame.rBack.opacity ?? 1);
        assert.ok(op <= 0.3 + 1e-9, `blocked→${next} at ${ts} s: a ring drawn at ${op} with its ball at ${P.ballS.toFixed(2)}`);
      }
    }
    assert.ok(out.filter((f) => f.t > 3.6).every((f) => f.pose.ringO < 0.01 || (f.pose.ringP < 0.002 && f.pose.ballS < 0.002)), `blocked→${next}: gone by 0.6 s`);
  }
});

test("done puts the orbit away: the ring closes, reels into its ball and the ball sinks, opaque, with no ghost ring thrown outward", () => {
  const { frames } = run([[0.2, "working"], [4, "done"]], 96, 6);
  const out = frames.filter((f) => f.t >= 4);
  let closed = false;
  for (const f of out) {
    const P = f.pose;
    assert.ok(P.ringA <= 1 + 1e-9, `done at ${(f.t - 4).toFixed(2)} s: the ring grows (${P.ringA.toFixed(2)})`);
    if (P.ringP > 0.002 || P.ballS > 0.002) assert.ok(P.ringO > 0.999, `done at ${(f.t - 4).toFixed(2)} s: the orbit fades (${P.ringO.toFixed(2)})`);
    if (P.ringGap < 0.5 && P.ringP > 0.99) closed = true;
  }
  assert.ok(closed, "the logo's ring is whole for a moment");
  assert.ok(out.filter((f) => f.t > 5).every((f) => f.pose.ringP < 0.002 && f.pose.ballS < 0.002), "and nothing is left after a second");
});

test("waking from paused opens the eyes slowly, with the colour, never a jolt", () => {
  const { frames } = run([[0.2, "sleeping"], [3, "idle"]], 96, 4.5);
  const at = (t: number) => frames.find((f) => f.t >= 3 + t)!.pose;
  assert.ok(at(0.15).lid < 0.2, `the eyes are ${(at(0.15).lid * 100).toFixed(0)}% open 0.15 s in`);
  assert.ok(at(0.4).lid > 0.3 && at(0.4).lid < 0.8, "half open midway");
  assert.ok(at(0.75).lid > 0.95, "and fully open by the time the colour is back");
});

/* ------------------------------------------------------------------------ */
/* Stills that must tell apart                                              */
/* ------------------------------------------------------------------------ */

/** The drawn height of the taller eye, in px. */
function eyeHeightPx(frame: ReturnType<typeof drawFace>, px: number, s: FaceSpec) {
  let best = 0;
  for (const key of ["e0", "e1"] as const) {
    const e = frame[key];
    const m = matrixOf(e.transform ?? "");
    if (!e.d || e.opacity === "0" || !m) continue;
    const ys = pairs(e.d).map(([x, y]) => m[1] * x + m[3] * y);
    best = Math.max(best, Math.max(...ys) - Math.min(...ys));
  }
  return best * pxPerR(px, s.size);
}

test("at 20 px listening reads apart from idle in the still: the eyes are taller by a pixel", () => {
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      const s = spec(shape, 20, eyes);
      const ctx = faceCtx(s, "none", 0, false);
      const idle = eyeHeightPx(drawFace(s, stillPose("idle", ctx), NO_EXTRAS, ids), 20, s);
      const listening = eyeHeightPx(drawFace(s, stillPose("listening", ctx), NO_EXTRAS, ids), 20, s);
      assert.ok(listening - idle >= 0.8, `${shape}/${eyes}: listening's eyes are ${(listening - idle).toFixed(2)} px taller than idle's`);
    }
  }
});

test("done's happy eyes are a squashed capsule, never a ^ caret, and never read as paused's dashes at 20 px", () => {
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      for (const px of [20, 28, 96, 160]) {
        const s = spec(shape, px, eyes);
        const ctx = faceCtx(s, "none", 0, false);
        const done = drawFace(s, stillPose("done", ctx), NO_EXTRAS, ids);
        const sleeping = drawFace(s, stillPose("sleeping", ctx), NO_EXTRAS, ids);
        const dh = eyeHeightPx(done, px, s);
        const sh = eyeHeightPx(sleeping, px, s);
        assert.ok(dh - sh >= 0.45, `${shape}/${eyes} at ${px}px: done's eyes are ${dh.toFixed(2)} px tall, paused's dashes ${sh.toFixed(2)} px`);
        // A capsule, not an arch: in its own frame its thickness at the middle
        // is most of its thickness anywhere (an arch is thin and bent).
        const pts = pairs(done.e0.d ?? "");
        const half = pts.length / 2;
        const top = pts.slice(0, half);
        const bottom = pts.slice(half).reverse();
        const thick = top.map(([, y], i) => bottom[i][1] - y);
        const mid = thick[Math.floor(thick.length / 2)];
        const xs = pts.map(([x]) => x);
        const width = Math.max(...xs) - Math.min(...xs);
        assert.ok(mid >= 0.45 * width, `${shape}/${eyes} at ${px}px: the happy eye is ${(mid / width).toFixed(2)} as thick as it is wide (a caret)`);
      }
    }
  }
});

test("rest life: no scheduled blink just after a change of state (the acknowledgement blink is the blink)", () => {
  const s = spec("orb", 96);
  const ctx = faceCtx(s, "none", 7, true);
  for (let k = 0; k < 40; k++) {
    const at = 3 + k * 0.37;
    for (const state of ["working", "waiting", "listening", "blocked"] as const) {
      const seg: Segment = { state, at, snap: snapshot({ state: "idle", at: -60, snap: null }, at, ctx) };
      for (let t = at; t < at + 1.2; t += 1 / 60) {
        assert.equal(restExtras(ctx, seg, t).blink, 1, `${state} entered at ${at.toFixed(2)} s blinked again at +${(t - at).toFixed(2)} s`);
      }
    }
  }
});

/**
 * How open the eyes are drawn (1 open, 0.06 shut): the lid times every blink
 * (the state's acknowledgement and any carried blink in blinkMul, the
 * scheduled ones in restExtras), as drawFace multiplies them, against the
 * mark's resting lid (a visor face rests at 0.86, and that is open).
 */
const openness = (ctx: ReturnType<typeof faceCtx>, seg: Segment, t: number) => {
  const P = poseAt(seg, t, ctx);
  return (P.lid / ctx.temper.lid) * P.blinkMul * restExtras(ctx, seg, t, P).blink;
};

/**
 * One change of state at Tc, sampled at 240 fps from 50 ms before it to
 * 0.6 s after: the worst rise in one frame (a natural blink reopens by at most
 * 0.1 a frame at 240 fps; a cut from shut to open is 0.94), and how many
 * times the eyes close again after they had started to reopen, from below 0.9
 * open (a blink restarted: the stutter of a double blink).
 */
function blinkTrace(ctx: ReturnType<typeof faceCtx>, before: Segment, after: (Tc: number) => Segment, Tc: number) {
  const next = after(Tc);
  let prev = openness(ctx, before, Tc - 0.05);
  let worst = 0;
  let worstAt = 0;
  let low = Infinity;
  let high = -Infinity;
  let recloses = 0;
  for (let i = -11; i <= 144; i++) {
    const t = Tc + i / 240;
    const v = openness(ctx, i < 0 ? before : next, t);
    if (v - prev > worst) {
      worst = v - prev;
      worstAt = i;
    }
    prev = v;
    if (i < 0) continue;
    if (v < low) {
      low = v;
      high = v;
    }
    high = Math.max(high, v);
    if (high > low + 0.1 && high < 0.9 && v < high - 0.1) {
      recloses++;
      low = v;
      high = v;
    }
  }
  return { worst, worstAt, recloses };
}

test("a change of state composes with a blink under way: never cut open in one frame, never restarted (every frame, many blink phases)", () => {
  const live = AGENT_STATES.filter((s) => s !== "thinking" && s !== "done" && s !== "sleeping");
  const fails: string[] = [];
  const note = (what: string, r: ReturnType<typeof blinkTrace>) => {
    if (r.worst > 0.12) fails.push(`${what}: the eyes opened ${r.worst.toFixed(2)} in one 240 fps frame (+${(r.worstAt / 0.24).toFixed(0)} ms)`);
    if (r.recloses > 0) fails.push(`${what}: the blink restarted after it began to reopen`);
  };
  let changes = 0;
  // More than one body, and the marks that rest their lid low (visor, 0.86) as well as open: an
  // acknowledgement judged on the lid once never came for a visor face.
  const looks = [
    { shape: "orb", mark: "none", seed: 5 },
    { shape: "capsule", mark: "visor", seed: 77 },
    { shape: "spark", mark: "spark", seed: 13 },
  ] as const;
  for (const px of [28, 96]) {
    for (const { shape, mark, seed } of looks) {
      const ctx = faceCtx(spec(shape, px), mark, seed, true);
      // A scheduled blink under way (every state that blinks at rest), the change landing at 14 points through it.
      for (const from of live) {
        const seg: Segment = from === "idle" ? { state: "idle", at: -60, snap: null } : { state: from, at: 1, snap: snapshot({ state: "idle", at: -60, snap: null }, 1, ctx) };
        let start = -1;
        for (let t = 3; t < 60 && start < 0; t += 1 / 240) if (restExtras(ctx, seg, t).blink < 0.999) start = t;
        assert.ok(start > 0, `${from} ${px}px ${shape}/${mark} blinks at rest`);
        for (let k = 0; k < 14; k++) {
          const Tc = start + (k / 13) * 0.26;
          for (const to of AGENT_STATES) {
            if (to === from) continue;
            changes++;
            note(`${px}px ${shape}/${mark}: ${from}→${to} at ${((Tc - start) * 1000).toFixed(0)} ms into a blink`, blinkTrace(ctx, seg, (T) => ({ state: to, at: T, snap: snapshot(seg, T, ctx) }), Tc));
          }
          // A look saved while the eyes are shut (rebaseSegment): the blink runs on.
          const other = faceCtx(spec(shape, px), mark, seed, true, ctx.side > 0 ? 101 : 107);
          changes++;
          note(`${px}px ${shape}/${mark}: ${from} rebased ${((Tc - start) * 1000).toFixed(0)} ms into a blink`, blinkTrace(ctx, seg, (T) => rebaseSegment(seg, T, ctx, other), Tc));
        }
      }
      // A state's own acknowledgement blink (or a blink it carried) under way: a direct preview changing again within 0 to 240 ms.
      for (const mid of AGENT_STATES) {
        const rest: Segment = { state: "idle", at: -60, snap: null };
        const T1 = 20;
        const seg: Segment = { state: mid, at: T1, snap: snapshot(rest, T1, ctx) };
        for (let k = 0; k < 13; k++) {
          const Tc = T1 + 0.005 + k * 0.019;
          for (const to of AGENT_STATES) {
            if (to === mid) continue;
            changes++;
            note(`${px}px ${shape}/${mark}: idle→${mid}, then ${to} ${((Tc - T1) * 1000).toFixed(0)} ms later`, blinkTrace(ctx, seg, (T) => ({ state: to, at: T, snap: snapshot(seg, T, ctx) }), Tc));
          }
        }
      }
    }
  }
  // The runtime's hover notice, folded into the snapshot (carryBlink) when it is the more shut: it runs on the same way.
  for (const c of [0.06, 0.3, 0.7]) {
    for (const dir of [-1, 1]) {
      const ctx = faceCtx(spec("orb", 96), "none", 5, true);
      const rest: Segment = { state: "idle", at: -60, snap: null };
      const Tc = 30;
      // Before the change, the notice on its own clock (drawn as min with the rest blinks): approximated by its value at Tc.
      const seg: Segment = { state: "working", at: Tc, snap: carryBlink(snapshot(rest, Tc, ctx), c, dir) };
      let prev = c;
      let low = c;
      let high = c;
      for (let t = Tc; t < Tc + 0.6; t += 1 / 240) {
        const v = openness(ctx, seg, t);
        const what = `a hover notice ${c} open (${dir > 0 ? "reopening" : "closing"}) carried into working`;
        assert.ok(v - prev <= 0.12, `${what}: opened ${(v - prev).toFixed(2)} in one frame`);
        if (v < low) [low, high] = [v, v];
        high = Math.max(high, v);
        assert.ok(!(high > low + 0.1 && high < 0.9 && v < high - 0.1), `${what}: closed again after it began to reopen`);
        prev = v;
      }
      changes++;
    }
  }
  assert.ok(changes > 3000, `${changes} changes sampled`);
  assert.equal(fails.length, 0, `${fails.length} of ${changes} changes cut or restart a blink:\n${fails.slice(0, 12).join("\n")}`);
});

test("every mark acknowledges a change with a blink: a lid that rests low (visor) is open, and only shut eyes opening need none", () => {
  const missing: string[] = [];
  for (const px of [28, 96]) {
    for (const mark of AGENT_MARKS) {
      for (const shape of ["orb", "tile"] as const) {
        const ctx = faceCtx(spec(shape, px), mark, 5, true);
        for (const from of AGENT_STATES) {
          // Settled in `from`, then changed at a moment with no blink under way.
          const seg: Segment = { state: from, at: 10, snap: snapshot({ state: "idle", at: -60, snap: null }, 10, ctx) };
          let Tc = 20;
          while (snapshot(seg, Tc, ctx).blinkC < 0.999) Tc += 0.01;
          const snap = snapshot(seg, Tc, ctx);
          // Eyes the old state's lid had shut (paused, a small face thinking) open as the acknowledgement.
          const shut = snap.lid < 0.5;
          for (const to of ["working", "waiting", "listening", "blocked"] as const) {
            if (to === from) continue;
            const next: Segment = { state: to, at: Tc, snap };
            let least = 1;
            for (let t = 0; t < 0.4; t += 1 / 240) least = Math.min(least, poseAt(next, Tc + t, ctx).blinkMul);
            if (!shut && least > 0.5) missing.push(`${px}px ${shape}/${mark}: ${from}→${to} (least ${least.toFixed(2)} open)`);
            if (shut) assert.ok(least > 0.999, `${px}px ${shape}/${mark}: ${from}→${to} opens shut eyes without closing them again`);
          }
        }
      }
    }
  }
  assert.equal(missing.length, 0, `${missing.length} entries without their acknowledgement blink:\n${missing.slice(0, 12).join("\n")}`);
});

/* ------------------------------------------------------------------------ */
/* Paint contrast, from the shipped tokens                                  */
/* ------------------------------------------------------------------------ */

type RGB = [number, number, number];
function hslToRgb([h, s, l]: RGB): RGB {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab(rgb: RGB): RGB {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, A, B]: RGB): RGB {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin: RGB = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((c) => Math.min(1, Math.max(0, toGamma(c)))) as RGB;
}
const luminance = (rgb: RGB) => {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("paint contrast holds in both themes: eyes on every tone, the paused body on the page, its dashes on it", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const faceCss = readFileSync(new URL("../src/components/agents/agent-face.css", import.meta.url), "utf8");
  const darkAt = css.indexOf("\n  .dark {");
  assert.ok(darkAt > 0, "globals.css has its dark block");
  const themes = { light: css.slice(0, darkAt), dark: css.slice(darkAt, css.indexOf(":root[data-accent", darkAt)) };
  const token = (block: string, name: string): RGB => {
    const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
    assert.ok(m, `--${name} is declared`);
    return hslToRgb([Number(m[1]), Number(m[2]), Number(m[3])]);
  };
  const dormantOf = (dark: boolean) => {
    const m = new RegExp(`${dark ? "\\.dark \\.agent-face" : "\\n\\.agent-face"} \\{[^}]*--agent-dormant:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%;\\s*--agent-dormant-ink:\\s*([\\d.]+)`).exec(faceCss);
    assert.ok(m, `agent-face.css declares the ${dark ? "dark" : "light"} dormant paint`);
    return { body: hslToRgb([Number(m[1]), Number(m[2]), Number(m[3])]), ink: Number(m[4]) };
  };
  for (const [theme, block] of Object.entries(themes)) {
    const ink = token(block, "agent-ink");
    const page = token(block, "background");
    const card = token(block, "card");
    const dormant = dormantOf(theme === "dark");
    for (const tone of ["coral", "juniper", "teal", "violet", "amber", "sage"]) {
      const body = token(block, `agent-${tone}`);
      assert.ok(ratio(ink, body) >= 5.4, `${theme} ${tone}: the eyes clear ${ratio(ink, body).toFixed(2)}:1`);
      // Paused: the dormant grey with a 14% trace of the tone, mixed in oklab (agent-face.css).
      const a = toOklab(body);
      const b = toOklab(dormant.body);
      const paused = fromOklab([0, 1, 2].map((i) => 0.14 * a[i] + 0.86 * b[i]) as RGB);
      const dash = paused.map((c, i) => dormant.ink * ink[i] + (1 - dormant.ink) * c) as RGB;
      assert.ok(ratio(dash, paused) >= 3, `${theme} ${tone} paused: the dashes clear ${ratio(dash, paused).toFixed(2)}:1`);
      for (const [where, surface] of [["page", page], ["card", card]] as const) {
        assert.ok(ratio(paused, surface) >= 1.75, `${theme} ${tone} paused: the body clears ${ratio(paused, surface).toFixed(2)}:1 on the ${where}`);
      }
    }
  }
});

/* ------------------------------------------------------------------------ */
/* Fix round 3: corners, glyphs, lockstep, look changes, paint swaps          */
/* ------------------------------------------------------------------------ */

/** Each drawn eye's outline in the face's frame, in px. */
function eyeOutlinesPx(frame: ReturnType<typeof drawFace>, px: number, s: FaceSpec) {
  const k = pxPerR(px, s.size);
  const out: Array<Array<[number, number]>> = [];
  for (const key of ["e0", "e1"] as const) {
    const e = frame[key];
    const m = matrixOf(e.transform ?? "");
    if (!e.d || e.opacity === "0" || !m) continue;
    out.push(pairs(e.d).map(([x, y]) => [(m[0] * x + m[2] * y + m[4]) * k, (m[1] * x + m[3] * y + m[5]) * k]));
  }
  return out;
}

/** The sharpest turn (degrees) between neighbouring segments of a closed outline, skipping points within `minSeg` of the last. */
function sharpestTurn(pts: Array<[number, number]>, minSeg = 1e-3) {
  const P: Array<[number, number]> = [];
  for (const p of pts) if (!P.length || Math.hypot(p[0] - P.at(-1)![0], p[1] - P.at(-1)![1]) > minSeg) P.push(p);
  if (P.length > 2 && Math.hypot(P[0][0] - P.at(-1)![0], P[0][1] - P.at(-1)![1]) <= minSeg) P.pop();
  let worst = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[(i - 1 + P.length) % P.length];
    const b = P[i];
    const c = P[(i + 1) % P.length];
    const t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    worst = Math.max(worst, Math.abs(((((t * 180) / Math.PI) % 360) + 540) % 360 - 180));
  }
  return worst;
}

test("no expression draws a corner: from 48 px every eye's outline turns under 40° between neighbouring segments", () => {
  const states: AgentState[] = ["idle", "blocked", "done", "sleeping", "listening"];
  const blinkBottom: FaceExtras = { ...NO_EXTRAS, blink: 0.06 };
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      for (const px of [48, 96, 160]) {
        const s = spec(shape, px, eyes);
        const ctx = faceCtx(s, "none", 0, false, 4242);
        for (const state of states) {
          const extras = state === "idle" ? [NO_EXTRAS, blinkBottom] : [NO_EXTRAS];
          for (const X of extras) {
            for (const outline of eyeOutlinesPx(drawFace(s, stillPose(state, ctx), X, ids), px, s)) {
              const turn = sharpestTurn(outline);
              assert.ok(turn < 40, `${shape}/${eyes} ${state}${X.blink < 1 ? " mid-blink" : ""} at ${px}px: an eye outline turns ${turn.toFixed(0)}° at one point`);
            }
          }
        }
      }
    }
  }
});

test("at 20 and 28 px no pair of eyes reads as a pause glyph: no cut is drawn taller than 1.8 its width, and the pair sits off centre", () => {
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      for (const px of [20, 28]) {
        for (const identity of [101, 202, 303, 404]) {
          const s = spec(shape, px, eyes);
          const ctx = faceCtx(s, "none", 0, false, identity);
          const outlines = eyeOutlinesPx(drawFace(s, stillPose("idle", ctx), NO_EXTRAS, ids), px, s);
          assert.equal(outlines.length, 2, `${shape}/${eyes} at ${px}px: both eyes show`);
          let mid = 0;
          for (const o of outlines) {
            const xs = o.map(([x]) => x);
            const ys = o.map(([, y]) => y);
            const w = Math.max(...xs) - Math.min(...xs);
            const h = Math.max(...ys) - Math.min(...ys);
            assert.ok(h / w <= 1.8, `${shape}/${eyes} at ${px}px: an eye is drawn ${w.toFixed(1)} × ${h.toFixed(1)} px (${(h / w).toFixed(2)})`);
            mid += (Math.max(...xs) + Math.min(...xs)) / 4;
          }
          const off = (mid / pxPerR(px, s.size) - bodyOf(shape).seat.ox) * ctx.side;
          assert.ok(off >= 0.05, `${shape}/${eyes} at ${px}px: the pair sits ${off.toFixed(3)} R toward the agent's side (a centred pair of bars is a glyph)`);
        }
      }
    }
  }
});

/** A transform list (matrix, translate, rotate, scale) as one affine map [a b c d e f]. */
function affine(t: string | undefined): number[] {
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|rotate|scale)\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while (t && (r = re.exec(t))) {
    const a = r[2].trim().split(/[\s,]+/).map(Number);
    const c = Math.cos((a[0] * Math.PI) / 180);
    const s = Math.sin((a[0] * Math.PI) / 180);
    const n =
      r[1] === "matrix" ? a : r[1] === "translate" ? [1, 0, 0, 1, a[0], a[1] ?? 0] : r[1] === "scale" ? [a[0], 0, 0, a[1] ?? a[0], 0, 0] : [c, s, -s, c, 0, 0];
    m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  return m;
}

/**
 * Each eye as it lands on screen (px): the lean of its own long axis off
 * upright (degrees, + is `\`), its extents along its long and short axes,
 * and its centre.
 */
function screenEyes(frame: ReturnType<typeof drawFace>, px: number) {
  const k = px / 64;
  const outer = affine(`scale(${k}) ${frame.g.transform} ${frame.bodyT.transform}`);
  return (["e0", "e1"] as const).map((key) => {
    const e = frame[key];
    if (!e.d || Number(e.opacity ?? 1) < 0.9) return null;
    const m = affine(`matrix(${outer.join(" ")}) ${e.transform}`);
    const L = Math.hypot(m[2], m[3]);
    const [ux, uy] = [m[2] / L, m[3] / L];
    let lo = Infinity;
    let hi = -Infinity;
    let so = Infinity;
    let sh = -Infinity;
    for (const [x, y] of pairs(e.d)) {
      const X = m[0] * x + m[2] * y + m[4];
      const Y = m[1] * x + m[3] * y + m[5];
      lo = Math.min(lo, X * ux + Y * uy);
      hi = Math.max(hi, X * ux + Y * uy);
      so = Math.min(so, -X * uy + Y * ux);
      sh = Math.max(sh, -X * uy + Y * ux);
    }
    return { lean: (Math.atan2(m[2], m[3]) * 180) / Math.PI, long: hi - lo, short: sh - so, x: m[4], y: m[5] };
  });
}

/** Each shown eye's outline as it lands on screen (px), the body's own scale and roll included. */
function screenOutlines(frame: ReturnType<typeof drawFace>, px: number) {
  const outer = affine(`scale(${px / 64}) ${frame.g.transform} ${frame.bodyT.transform}`);
  const out: Array<Array<[number, number]>> = [];
  for (const key of ["e0", "e1"] as const) {
    const e = frame[key];
    if (!e.d || e.opacity === "0") continue;
    const m = affine(`matrix(${outer.join(" ")}) ${e.transform}`);
    out.push(pairs(e.d).map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]));
  }
  return out;
}

/**
 * The least distance between two convex closed outlines that do not overlap
 * (vertex to edge, both ways), over the halves of each that face the other.
 */
function outlineGap(a: Array<[number, number]>, b: Array<[number, number]>) {
  const mid = (o: Array<[number, number]>) => [o.reduce((s, p) => s + p[0], 0) / o.length, o.reduce((s, p) => s + p[1], 0) / o.length];
  const [ax0, ay0] = mid(a);
  const [bx0, by0] = mid(b);
  const facing = (o: Array<[number, number]>, cx: number, cy: number, ux: number, uy: number) => o.map(([x, y]) => (x - cx) * ux + (y - cy) * uy > -0.2);
  const fa = facing(a, ax0, ay0, bx0 - ax0, by0 - ay0);
  const fb = facing(b, bx0, by0, ax0 - bx0, ay0 - by0);
  let d = Infinity;
  for (const [P, Q, fP, fQ] of [[a, b, fa, fb], [b, a, fb, fa]] as const) {
    for (let j = 0; j < P.length; j++) {
      if (!fP[j]) continue;
      const [x, y] = P[j];
      for (let i = 0; i < Q.length; i++) {
        const i2 = (i + 1) % Q.length;
        if (!fQ[i] && !fQ[i2]) continue;
        const [ax, ay] = Q[i];
        const [bx, by] = Q[i2];
        const ex = bx - ax;
        const ey = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
        d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
      }
    }
  }
  return d;
}

test("at 20 and 28 px the two eyes never fuse: a pixel of body between them in every still and live frame, every body and cut", () => {
  // Paused's widened dashes once drew 0.22 px apart on spark (a minus sign), and listening's round eyes 0.58 px (one blob).
  const close: string[] = [];
  let frames = 0;
  let least = Infinity;
  const check = (what: string, s: FaceSpec, P: Pose, X: FaceExtras = NO_EXTRAS) => {
    const o = screenOutlines(drawFace(s, P, X, ids), s.px);
    if (o.length < 2) return;
    frames++;
    const g = outlineGap(o[0], o[1]);
    least = Math.min(least, g);
    if (g < 1) close.push(`${what}: ${g.toFixed(2)} px apart`);
  };
  for (const px of [20, 28]) {
    for (const [n, shape] of AGENT_SHAPES.entries()) {
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        for (const id of [107, 101]) {
          const still = faceCtx(s, "none", 0, false, id);
          for (const state of AGENT_STATES) check(`${state} still ${shape}/${eyes} ${px}px`, s, stillPose(state, still));
        }
        // Live: every state entered from rest (its change included), 2.5 s at 10 fps (the first
        // half second at 30), with the scheduled blinks, resting one way or the other by body.
        const id = n % 2 ? 101 : 107;
        const ctx = faceCtx(s, "none", id, true, id);
        for (const state of AGENT_STATES) {
          const seg: Segment = { state, at: 1, snap: snapshot({ state: "idle", at: -60, snap: null }, 1, ctx) };
          for (const dt of [...Array.from({ length: 15 }, (_, i) => i / 30), ...Array.from({ length: 20 }, (_, i) => 0.5 + i / 10)]) {
            const t = 1 + dt;
            const P = poseAt(seg, t, ctx);
            check(`${state} live ${shape}/${eyes} ${px}px +${dt.toFixed(2)} s`, s, P, restExtras(ctx, seg, t, P));
          }
        }
      }
    }
  }
  assert.ok(frames > 15000, `${frames} frames checked`);
  assert.equal(close.length, 0, `${close.length} of ${frames} frames draw the eyes under a pixel apart (least ${least.toFixed(2)} px):\n${close.slice(0, 10).join("\n")}`);
});

/** The angle of an outline's long axis off horizontal (degrees, y down, so + drops its right end), and its centre x. */
function majorAxis(o: Array<[number, number]>) {
  const cx = o.reduce((s, p) => s + p[0], 0) / o.length;
  const cy = o.reduce((s, p) => s + p[1], 0) / o.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of o) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  return { angle: (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI, cx };
}

test("a worried face blinks level: shut, its two dashes never mirror into a scowl (`\\ /`), at every size and cut", () => {
  // The worry leans each eye's top in; a shut eye kept that lean drew `\ /`, the angry V, on every blink of a blocked face.
  const scowls: string[] = [];
  let shut = 0;
  const check = (what: string, s: FaceSpec, P: Pose, blink: number) => {
    const o = screenOutlines(drawFace(s, P, { ...NO_EXTRAS, blink }, ids), s.px);
    if (o.length < 2) return;
    shut++;
    const [l, r] = o.map(majorAxis).sort((a, b) => a.cx - b.cx);
    // Inner ends lower than outer ends, less the head's own lean (which turns both dashes alike).
    const scowl = (l.angle - r.angle) / 2;
    if (scowl > 3) scowls.push(`${what}: each dash's inner end ${scowl.toFixed(1)}° below its outer end`);
  };
  for (const px of [28, 48, 96, 160]) {
    for (const shape of ["orb", "capsule", "halo"] as const) {
      for (const eyes of AGENT_EYES) {
        for (const id of [107, 101]) {
          const s = spec(shape, px, eyes);
          for (const blink of [0.06, 0.08, 0.1]) check(`blocked still ${shape}/${eyes} ${px}px, blink ${blink}`, s, stillPose("blocked", faceCtx(s, "none", 0, false, id)), blink);
          // Live: the scheduled blinks of a block (and its entry), every frame shut to 0.1 or less.
          const ctx = faceCtx(s, "none", id, true, id);
          const seg: Segment = { state: "blocked", at: 1, snap: snapshot({ state: "idle", at: -60, snap: null }, 1, ctx) };
          for (let t = 1; t < 30; t += 1 / 120) {
            const P = poseAt(seg, t, ctx);
            const blink = restExtras(ctx, seg, t, P).blink;
            if (blink * P.blinkMul <= 0.1) check(`blocked live ${shape}/${eyes} ${px}px +${(t - 1).toFixed(2)} s`, s, P, blink);
          }
        }
      }
    }
  }
  assert.ok(shut > 1000, `${shut} shut frames checked`);
  assert.equal(scowls.length, 0, `${scowls.length} of ${shut} shut frames scowl:\n${scowls.slice(0, 10).join("\n")}`);
});

/**
 * The pause glyph (⏸): two long bars (each 1.5 times as long as it is wide or
 * more), both within 6° of upright and of each other, alike in size (lengths
 * within 0.85, widths within 0.7: a far eye narrower than that is a head
 * plainly turned on a sphere).
 */
function pauseGlyph(eyes: ReturnType<typeof screenEyes>) {
  const [a, b] = eyes;
  if (!a || !b || a.long < 1.5 * a.short || b.long < 1.5 * b.short) return false;
  if (Math.abs(a.lean) >= 6 || Math.abs(b.lean) >= 6 || Math.abs(a.lean - b.lean) >= 6) return false;
  return Math.min(a.long, b.long) / Math.max(a.long, b.long) >= 0.85 && Math.min(a.short, b.short) / Math.max(a.short, b.short) >= 0.7;
}

/**
 * …and the same glyph rolled: a pair of parallel bars alike in width (the far
 * eye under 5% narrower: no turn on a sphere to read), standing square to the
 * line between them (shear under 2°) and leaning under 14°. Rolled to a lean
 * floor and nothing else, the tall cut read as ⏸ tipped over.
 */
function rolledPause(eyes: ReturnType<typeof screenEyes>) {
  const [a0, b0] = eyes;
  if (!a0 || !b0 || a0.long < 1.5 * a0.short || b0.long < 1.5 * b0.short || Math.abs(a0.lean - b0.lean) >= 6) return false;
  const [a, b] = a0.x < b0.x ? [a0, b0] : [b0, a0];
  const lean = (a.lean + b.lean) / 2;
  const shear = lean + (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const wide = Math.min(a.short, b.short) / Math.max(a.short, b.short);
  return Math.min(a.long, b.long) / Math.max(a.long, b.long) >= 0.85 && wide > 0.95 && Math.abs(shear) < 2 && Math.abs(lean) < 14;
}

test("no pair of eyes is ever the pause glyph (⏸): every long cut leans, at every size, in every still, swatch and live frame", () => {
  // Identities that rest each way round.
  const SIDES = [107, 101];
  assert.deepEqual(SIDES.map((id) => faceCtx(spec("orb", 96), "none", 0, false, id).side), [1, -1]);
  const seen: string[] = [];
  let frames = 0;
  let tall = 0;
  const check = (what: string, s: FaceSpec, P: Pose, X: FaceExtras = NO_EXTRAS) => {
    frames++;
    const E = screenEyes(drawFace(s, P, X, ids), s.px);
    if (pauseGlyph(E)) seen.push(what);
    // The tall cut from 44 px, where it is long enough to read as a bar: never ⏸ rolled either.
    if (s.eyes === "tall" && s.px >= 44) {
      tall++;
      if (rolledPause(E)) seen.push(`${what} (⏸ rolled)`);
    }
  };
  // Stills (the server's frame, reduced motion, roster copies) and the eye pickers' front swatch.
  for (const state of AGENT_STATES) {
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        for (const px of [20, 28, 44, 48, 88, 96, 160]) {
          for (const id of SIDES) {
            const s = spec(shape, px, eyes);
            const ctx = faceCtx(s, "none", 0, false, id);
            const P = stillPose(state, ctx);
            check(`${state} still ${shape}/${eyes} ${px}px`, s, P);
            if (px === 44) check(`${state} swatch ${shape}/${eyes}`, s, frontPose(P));
          }
        }
      }
    }
  }
  // Live: every state entered from rest, 8 s at 20 fps (the working spin and orbit, the waiting
  // glances, idle's drift), and every 0.4 s the pointer at the far corners of its look.
  const corners: FaceExtras[] = [-1, 1].flatMap((x) => [-1, 1].map((y) => ({ ...NO_EXTRAS, yaw: 22 * x, pitch: 17 * y, tilt: 4.2 * x })));
  for (const state of AGENT_STATES) {
    for (const eyes of ["soft", "tall", "wide"] as const) {
      for (const px of [20, 48, 96, 160]) {
        for (const id of SIDES) {
          const s = spec("capsule", px, eyes);
          const ctx = faceCtx(s, "none", id, true, id);
          const seg: Segment = { state, at: 1, snap: snapshot({ state: "idle", at: -60, snap: null }, 1, ctx) };
          for (let i = 0; i < 160; i++) {
            const t = 1 + i / 20;
            const P = poseAt(seg, t, ctx);
            if (restExtras(ctx, seg, t, P).blink < 0.999) continue;
            check(`${state} live ${eyes} ${px}px id ${id} +${(t - 1).toFixed(2)} s`, s, P);
            if (i % 8 === 0) for (const X of corners) check(`${state} live ${eyes} ${px}px id ${id} +${(t - 1).toFixed(2)} s, pointer ${X.yaw},${X.pitch}`, s, P, X);
          }
        }
      }
    }
  }
  assert.ok(frames > 20000 && tall > 5000, `${frames} frames checked, ${tall} of the tall cut from 44 px`);
  assert.equal(seen.length, 0, `${seen.length} of ${frames} frames draw ⏸:\n${seen.slice(0, 10).join("\n")}`);
});

test("the eye pickers draw each cut as eyes on a sphere, every swatch the same way round: leaning, the far eye narrower, off centre, and the four cuts apart", () => {
  for (const shape of AGENT_SHAPES) {
    // Whichever way the look a swatch stands for would rest, the row is drawn one way round (`\`).
    for (const id of [107, 101]) {
      const cuts = AGENT_EYES.map((eyes) => {
        const s = spec(shape, 44, eyes);
        const ctx = faceCtx(s, "none", 0, false, id);
        const [a, b] = screenEyes(drawFace(s, frontPose(stillPose("idle", ctx)), NO_EXTRAS, ids), 44);
        assert.ok(a && b, `${shape}/${eyes}: both eyes show`);
        const lean = (a.lean + b.lean) / 2;
        if (eyes !== "round") assert.ok(lean >= 7, `${shape}/${eyes}: the swatch leans ${lean.toFixed(1)}° (\\, 7° or more)`);
        // Turned to the right, the right eye is the far one.
        const [near, far] = a.x < b.x ? [a, b] : [b, a];
        assert.ok(far.short < 0.97 * near.short, `${shape}/${eyes}: the far eye is narrower (${far.short.toFixed(2)} against ${near.short.toFixed(2)} px)`);
        const off = (a.x + b.x) / 2 / pxPerR(44, sizeClass(44)) - bodyOf(shape).seat.ox;
        assert.ok(off > 0.04, `${shape}/${eyes}: the pair sits ${off.toFixed(3)} R off centre`);
        return { eyes, w: (a.short + b.short) / 2, h: (a.long + b.long) / 2, gap: Math.hypot(b.x - a.x, b.y - a.y) };
      });
      // Each cut differs from every other by more than a pixel in width, height or spacing, at the swatch's 44 px.
      for (let i = 0; i < cuts.length; i++) {
        for (let j = i + 1; j < cuts.length; j++) {
          const d = Math.max(Math.abs(cuts[i].w - cuts[j].w), Math.abs(cuts[i].h - cuts[j].h), Math.abs(cuts[i].gap - cuts[j].gap));
          assert.ok(d > 1, `${shape}: ${cuts[i].eyes} and ${cuts[j].eyes} differ by only ${d.toFixed(2)} px`);
        }
      }
    }
  }
});

test("at 20 px done reads from a still: the happy eye bows by 0.9 px or more, wider and thinner than the open eye, and never a stub", () => {
  for (const shape of AGENT_SHAPES) {
    for (const eyes of AGENT_EYES) {
      const s = spec(shape, 20, eyes);
      const ctx = faceCtx(s, "none", 0, false, 4242);
      const k = pxPerR(20, s.size);
      const idle = eyeOutlinesPx(drawFace(s, stillPose("idle", ctx), NO_EXTRAS, ids), 20, s)[0];
      const frame = drawFace(s, stillPose("done", ctx), NO_EXTRAS, ids);
      // In the eye's own frame: the centreline's ends against its middle.
      const pts = pairs(frame.e0.d ?? "");
      const half = pts.length / 2;
      const top = pts.slice(0, half);
      const bottom = pts.slice(half).reverse();
      const m = Math.floor(half / 2);
      const bow = (top[0][1] - (top[m][1] + bottom[m][1]) / 2) * k;
      const thick = (bottom[m][1] - top[m][1]) * k;
      const size = (o: Array<[number, number]>) => {
        const xs = o.map(([x]) => x);
        const ys = o.map(([, y]) => y);
        return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      };
      const open = size(idle);
      const happy = size(eyeOutlinesPx(frame, 20, s)[0]);
      assert.ok(bow >= 0.8, `${shape}/${eyes}: the happy eye bows ${bow.toFixed(2)} px`);
      assert.ok(happy.w >= open.w + 0.3, `${shape}/${eyes}: the happy eye is ${happy.w.toFixed(2)} px wide, the open one ${open.w.toFixed(2)}`);
      assert.ok(open.h - thick >= 0.65, `${shape}/${eyes}: the happy eye is ${thick.toFixed(2)} px thick, the open one ${open.h.toFixed(2)} px tall`);
      // Never a stub: at 1x a capsule under 1.6 times as long as it is thick fills a 3 × 2 pixel square (the
      // tall cut's drew 2.9 × 2.25 px, a blob), unless the pair has no more room (its eyes 1.25 px apart).
      const along = (Math.max(...top.map(([x]) => x)) - Math.min(...top.map(([x]) => x))) * k;
      const [o0, o1] = screenOutlines(frame, 20);
      const roomy = outlineGap(o0, o1) > 1.4;
      assert.ok(bow >= 0.89, `${shape}/${eyes}: the happy eye bows ${bow.toFixed(2)} px`);
      if (roomy) assert.ok(along >= 1.55 * thick, `${shape}/${eyes}: the happy eye is ${along.toFixed(2)} px long and ${thick.toFixed(2)} px thick`);
    }
  }
});

test("working faces mounted together part within seconds: each holds its painted ball for a beat of its own, then spins up at a rate of its own", () => {
  const avatars = AGENT_SHAPES.flatMap((shape, i) =>
    ["coral", "juniper", "teal", "violet", "amber", "sage"].map((tone, j) => ({ shape, tone, eyes: AGENT_EYES[(i + j) % 4], mark: AGENT_MARKS[(i * 6 + j) % 6] })),
  );
  const share = (phases: number[]) => {
    let close = 0;
    let all = 0;
    for (let a = 0; a < phases.length; a++) {
      for (let b = a + 1; b < phases.length; b++) {
        all++;
        if (Math.abs(((((phases[a] - phases[b]) % 360) + 540) % 360) - 180) < 15) close++;
      }
    }
    return close / all;
  };
  for (const px of [20, 96]) {
    const T0 = 100;
    // A page load: every copy painted at the same spot and mounted in one frame.
    const arrive = (t: number) =>
      avatars.map((a, i) => {
        const s = spec(a.shape, px, a.eyes);
        const id = faceIdentity(a);
        const ctx = faceCtx(s, a.mark, (i * 2654435761) >>> 0, true, id);
        const seg: Segment = { state: "working", at: T0 - 63, snap: null, from: { pose: stillPose("working", faceCtx(s, a.mark, 0, false, id)), at: T0 } };
        return poseAt(seg, T0 + t, ctx).ringPhase;
      });
    for (const t of [2, 3]) assert.ok(share(arrive(t)) < 0.25, `${px}px, ${t} s after a page load: ${(100 * share(arrive(t))).toFixed(0)}% of agent pairs orbit within 15° of each other`);
    // A team handed work in one frame: every orbit fresh at once.
    const start = (t: number) =>
      avatars.map((a, i) => {
        const s = spec(a.shape, px, a.eyes);
        const ctx = faceCtx(s, a.mark, (i * 2654435761) >>> 0, true, faceIdentity(a));
        const idle: Segment = { state: "idle", at: T0 - 60, snap: null };
        const seg: Segment = { state: "working", at: T0, snap: snapshot(idle, T0, ctx) };
        return poseAt(seg, T0 + t, ctx).ringPhase;
      });
    // Each fresh ball pops within ±12° of the same spot, then spins up at its own rate.
    for (const [t, most] of [[2, 0.6], [8, 0.2]] as const) {
      assert.ok(share(start(t)) < most, `${px}px, ${t} s after starting together: ${(100 * share(start(t))).toFixed(0)}% of agent pairs orbit within 15° of each other`);
    }
  }
});

test("a new look under a running state never jumps: the face carries on from where it is (rebaseSegment)", () => {
  const tones = ["coral", "juniper", "teal", "violet", "amber", "sage"];
  const states: AgentState[] = ["idle", "working", "thinking", "done", "waiting", "blocked"];
  let flips = 0;
  for (const px of [20, 48, 96, 160]) {
    const s = spec("petal", px, "soft");
    const q = 1 / (4 * pxPerR(px, s.size));
    for (const state of states) {
      for (const from of tones) {
        for (const to of tones) {
          if (from === to) continue;
          const a = faceCtx(s, "ring", 77, false, faceIdentity({ shape: "petal", tone: from, eyes: "soft", mark: "ring" }));
          const b = faceCtx(s, "ring", 77, false, faceIdentity({ shape: "petal", tone: to, eyes: "soft", mark: "ring" }));
          if (a.side !== b.side) flips++;
          // Long in its state (a fresh one too: one second in).
          for (const since of [1, 30]) {
            const T = 200;
            const prev: Segment = { state: "idle", at: T - since - 60, snap: null };
            const seg: Segment = { state, at: T - since, snap: snapshot(prev, T - since, a) };
            const dt = 1 / 60;
            const steady = numbers(drawFace(s, poseAt(seg, T + dt, a), NO_EXTRAS, ids));
            const next = rebaseSegment(seg, T, a, b);
            const moved = numbers(drawFace(s, poseAt(next, T + dt, b), NO_EXTRAS, ids));
            assert.equal(moved.length, steady.length, `${state} ${px}px ${from}→${to}: the same parts are drawn`);
            const before = numbers(drawFace(s, poseAt(seg, T, a), NO_EXTRAS, ids));
            for (let i = 0; i < moved.length; i++) {
              // No more than a frame of the state's own motion, and a quarter device pixel.
              const own = Math.abs(steady[i] - before[i]);
              assert.ok(Math.abs(moved[i] - steady[i]) <= own + q + 1e-9, `${state} ${px}px ${from}→${to} (${since} s in): a drawn number moves ${Math.abs(moved[i] - steady[i]).toFixed(4)} R past its own frame of motion`);
            }
          }
        }
      }
    }
  }
  assert.ok(flips > 0, "some of the tone changes flip the side the agent rests on");
});

test("an orbit changing kind (working ↔ blocked) swaps its ball's paint only while the ball is small: never a blend through magenta", () => {
  const css = readFileSync(new URL("../src/components/agents/agent-face.css", import.meta.url), "utf8");
  const ball = /\.agent-face__ball \{([^}]*)\}/.exec(css);
  assert.ok(ball && !/transition/.test(ball[1]), "the ball's paint has no transition");
  for (const px of [48, 96, 160]) {
    for (const [a, b] of [["working", "blocked"], ["blocked", "working"]] as const) {
      const { frames } = run([[0.3, a], [4, b]], px, 5.5);
      let swapped = false;
      for (let i = 1; i < frames.length; i++) {
        const p = frames[i - 1].pose;
        const n = frames[i].pose;
        if (p.ringKind !== n.ringKind && n.ringO > 0.5) {
          swapped = true;
          assert.ok(n.ballS <= 0.35, `${a}→${b} at ${px}px: the ball changes paint at ${n.ballS.toFixed(2)} of its size`);
        }
      }
      assert.ok(swapped, `${a}→${b} at ${px}px: the visible orbit changes paint`);
    }
  }
});

test("petal is Juno's own: a drop leaning to the upper right, never Grok's upright teardrop", () => {
  const B = bodyOf("petal");
  let tip = { d: 0, a: 0 };
  for (let i = 0; i < B.pts.length; i += 2) {
    const d = Math.hypot(B.pts[i] - B.seat.ox, B.pts[i + 1] - B.seat.oy);
    if (d > tip.d) tip = { d, a: (Math.atan2(B.pts[i + 1] - B.seat.oy, B.pts[i] - B.seat.ox) * 180) / Math.PI };
  }
  assert.ok(tip.a > -70 && tip.a < -35, `the tip points ${tip.a.toFixed(0)}° from the face (upright would be −90°)`);
  assert.ok(B.badge.x < 0 && B.badge.y < 0, "the needs-you notch sits on the other shoulder, upper left");
});

/* ------------------------------------------------------------------------ */
/* Fix round 4: the run-down, simultaneous starts, done's cuts, small stills  */
/* ------------------------------------------------------------------------ */

test("the stalled orbit runs down: it coasts on, never faster and never back, then settles the short way to the bottom", () => {
  const STALL = RING_LOWEST - BALL_LEAD;
  const wrap = (a: number) => ((((a % 360) + 540) % 360) - 180);
  for (const px of [48, 96, 160]) {
    const s = spec("orb", px);
    const ctx = faceCtx(s, "none", 7, false);
    const working: Segment = { state: "working", at: 0, snap: snapshot({ state: "idle", at: -60, snap: null }, 0, ctx) };
    const cruise = poseAt(working, 20, ctx).ringSpeed;
    // 144 entry phases, one every 2.5° of the cruising orbit.
    for (let k = 0; k < 144; k++) {
      const at = 20 + (k * 2.5) / cruise;
      const snap = snapshot(working, at, ctx);
      const seg: Segment = { state: "blocked", at, snap };
      const v0 = snap.ringSpeed;
      let prev = snap.ringPhase;
      let coasting = true;
      let settled = false;
      for (let t = 1 / 240; t <= 8; t += 1 / 240) {
        const P = poseAt(seg, at + t, ctx);
        const v = (P.ringPhase - prev) * 240;
        prev = P.ringPhase;
        const what = `${px}px, entry ${k} (phase ${wrap(snap.ringPhase).toFixed(0)}°) at +${t.toFixed(3)} s`;
        assert.ok(Math.abs(P.ringSpeed) <= v0 + 1e-6 && Math.abs(v) <= v0 + 0.5, `${what}: the ball speeds up to ${v.toFixed(0)}°/s (entered at ${v0.toFixed(0)}°/s)`);
        if (coasting && Math.abs(P.ringSpeed) < 10) coasting = false;
        if (coasting) assert.ok(P.ringSpeed > 0 && v > -1e-6, `${what}: the ball rolls back (${v.toFixed(1)}°/s) while it coasts`);
        else assert.ok(Math.abs(P.ringSpeed) <= 60 && Math.abs(v) <= 60.5, `${what}: the ball settles at ${v.toFixed(0)}°/s`);
        if (nextChange(seg, at + t, ctx, P) === Infinity) {
          const off = Math.abs(wrap(P.ringPhase - STALL));
          assert.ok(off < 1, `${what}: at rest ${off.toFixed(2)}° from the bottom of the ring`);
          settled = true;
          break;
        }
      }
      assert.ok(settled, `${px}px, entry ${k}: still moving 8 s into blocked`);
    }
  }
});

test("faces handed one change in one frame part: each acknowledges after a beat of its own, and their orbits never ride as one", () => {
  // Who is staggered: an agent's loop, never a state that needs you, a voice turn or a preview.
  assert.ok(staggers("idle", "working") && staggers("working", "done") && staggers("thinking", "working"));
  assert.ok(!staggers("working", "waiting") && !staggers("working", "blocked"), "needs you is never kept waiting");
  assert.ok(!staggers("idle", "listening") && !staggers("listening", "thinking"), "a voice turn answers at once");
  assert.ok(!staggers("idle", "working", true), "a preview answers at once");
  let rs = 2024;
  const rnd = () => ((rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296);
  const TONES = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;
  for (const px of [20, 96]) {
    let pairs = 0;
    let spins = 0;
    const lock = new Map<number, number>([[2, 0], [4, 0]]);
    for (let trial = 0; trial < 300; trial++) {
      const now = 100_000;
      const taken: number[] = [];
      const faces = Array.from({ length: 6 }, () => {
        const a = { shape: AGENT_SHAPES[Math.floor(rnd() * 9)], tone: TONES[Math.floor(rnd() * 6)], eyes: AGENT_EYES[Math.floor(rnd() * 4)], mark: AGENT_MARKS[Math.floor(rnd() * 6)] };
        const seed = Math.floor(rnd() * 4294967296) >>> 0;
        const s = spec(a.shape, px, a.eyes);
        const ctx = faceCtx(s, a.mark, seed, true, faceIdentity(a));
        const at = staggeredAt(seed, 1, now, now, taken);
        assert.ok(at >= now && at <= now + 450 + 6 * 90, `a change is held ${at - now} ms`);
        taken.push(at);
        const T0 = at / 1000;
        const seg: Segment = { state: "working", at: T0, snap: snapshot({ state: "idle", at: T0 - 60, snap: null }, T0, ctx) };
        // The acknowledgement blink, the ball's pop and the face spin all run on the entry's clock.
        return { ctx, seg, spin: T0 + (spinHold("working", s.size, seg.snap) > 0 ? 0.45 : 0) };
      });
      for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (Math.abs(faces[i].spin - faces[j].spin) < 0.08) spins++;
      for (const t of lock.keys()) {
        const P = faces.map((f) => poseAt(f.seg, now / 1000 + t, f.ctx));
        for (let i = 0; i < 6; i++) {
          for (let j = i + 1; j < 6; j++) {
            const d = Math.abs(((((P[i].ringPhase - P[j].ringPhase) % 360) + 540) % 360) - 180);
            const dv = Math.abs(P[i].ringSpeed - P[j].ringSpeed) / Math.max(1, P[i].ringSpeed, P[j].ringSpeed);
            if (d < 15 && dv < 0.15) lock.set(t, lock.get(t)! + 1);
          }
        }
      }
      pairs += 15;
    }
    assert.ok(spins / pairs <= 0.2, `${px}px: ${((100 * spins) / pairs).toFixed(0)}% of pairs begin their entry within 80 ms of each other`);
    // Six balls placed at random would still put 8% of pairs within 15°.
    for (const [t, most] of [[2, 0.15], [4, 0.16]] as const) {
      const share = lock.get(t)! / pairs;
      assert.ok(share <= most, `${px}px, ${t} s after one poll started six agents: ${(100 * share).toFixed(0)}% of pairs orbit within 15° at a like speed`);
    }
  }
});

test("into and out of done no eye draws a corner or jumps: every 240 fps frame of the change, every cut, from 48 px", () => {
  const others = AGENT_STATES.filter((x) => x !== "done");
  const size = (o: Array<[number, number]>) => {
    const xs = o.map(([x]) => x);
    const ys = o.map(([, y]) => y);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  for (const px of [48, 96, 160]) {
    for (const eyes of AGENT_EYES) {
      const s = spec("orb", px, eyes);
      const ctx = faceCtx(s, "none", 7, false);
      for (const other of others) {
        for (const [a, b] of [[other, "done"], [ "done", other]] as const) {
          const from: Segment = { state: a, at: -60, snap: null };
          const seg: Segment = { state: b, at: 3, snap: snapshot(from, 3, ctx) };
          const dims: Array<number[] | null> = [];
          const k = pxPerR(px, s.size);
          for (let i = 0; i <= 144; i++) {
            const t = 3 + i / 240;
            const frame = drawFace(s, poseAt(seg, t, ctx), NO_EXTRAS, ids);
            // The cut as the expression draws it, in the eye's own frame (in
            // px): the sphere's foreshortening of an eye going round the limb
            // is not the expression's, and squashes any outline to a point.
            for (const key of ["e0", "e1"] as const) {
              const d = frame[key].d;
              if (!d || frame[key].opacity === "0") continue;
              const turn = sharpestTurn(pairs(d).map(([x, y]) => [x * k, y * k] as [number, number]), 0.05);
              assert.ok(turn < 40, `${a}→${b} ${eyes} at ${px}px, +${(i / 240).toFixed(3)} s: an eye's cut turns ${turn.toFixed(0)}° at one point`);
            }
            const outlines = eyeOutlinesPx(frame, px, s);
            dims.push(outlines.length === 2 ? [...size(outlines[0]), ...size(outlines[1])] : null);
          }
          // A step over half a pixel is never much more than the steps either
          // side of it: a blink is fast but continuous, a floor that switches
          // on is a jump (it stepped 3.3 px in one frame).
          for (let i = 1; i + 1 < dims.length; i++) {
            const [p, c, n] = [dims[i - 1], dims[i], dims[i + 1]];
            if (!p || !c || !n || i < 2 || !dims[i - 2]) continue;
            const q = dims[i - 2]!;
            for (let k = 0; k < c.length; k++) {
              const step = Math.abs(c[k] - p[k]);
              const around = Math.max(Math.abs(p[k] - q[k]), Math.abs(n[k] - c[k]));
              assert.ok(step <= 0.5 + 1.5 * around, `${a}→${b} ${eyes} at ${px}px, +${(i / 240).toFixed(3)} s: an eye's ${k % 2 ? "height" : "width"} jumps ${step.toFixed(2)} px (${around.toFixed(2)} px either side)`);
            }
          }
        }
      }
    }
  }
});

test("no change of state snaps the pair of eyes or passes through ⏸: each eye's lean and centre move on the change's own ease, every 60 fps frame of every change", () => {
  // The lean floor once let go on pose thresholds the state eases cross in 8 to 30 ms: into done,
  // paused or (small) thinking the pair stood upright in a frame or two (11° at 160 px), and back.
  // And between two states that both let it go, the eyes once stood as two upright bars on the
  // way (a small face opening its eyes out of thinking before its happy capsules formed; done's
  // happy lean turning over into blocked's worry).
  const snaps: string[] = [];
  const glyphs: string[] = [];
  let changes = 0;
  const lean = (a: number, b: number) => Math.abs(((((a - b) % 180) + 270) % 180) - 90);
  for (const px of [20, 28, 96, 160]) {
    for (const eyes of ["soft", "tall", "wide"] as const) {
      for (const id of [107, 101]) {
        const s = spec("capsule", px, eyes);
        const ctx = faceCtx(s, "none", 5, false, id);
        const rest: Segment = { state: "idle", at: -60, snap: null };
        for (const from of AGENT_STATES) {
          const a: Segment = from === "idle" ? rest : { state: from, at: 0, snap: snapshot(rest, 0, ctx) };
          for (const to of AGENT_STATES) {
            if (to === from) continue;
            changes++;
            const Tc = 3;
            const b: Segment = { state: to, at: Tc, snap: snapshot(a, Tc, ctx) };
            // Each eye per frame, from 0.1 s before the change to 0.9 s after, while it is a cut (not a dot) in full view.
            const S = Array.from({ length: 61 }, (_, i) => {
              const t = Tc + (i - 6) / 60;
              const E = screenEyes(drawFace(s, poseAt(i < 6 ? a : b, t, ctx), NO_EXTRAS, ids), px);
              if (pauseGlyph(E)) glyphs.push(`${px}px ${eyes} side ${ctx.side}, ${from}→${to} +${((i - 6) / 0.06).toFixed(0)} ms`);
              return E.map((e) => (e && e.long > 1.05 * e.short ? e : null));
            });
            for (const k of [0, 1]) {
              for (const [what, limit, step] of [
                ["lean (°)", 3, (p: { lean: number }, q: { lean: number }) => lean(p.lean, q.lean)],
                ["centre (px)", 0.6 * Math.max(1, px / 96), (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)],
              ] as const) {
                const steps = S.map((f, i) => (i && f[k] && S[i - 1][k] ? step(f[k]!, S[i - 1][k]!) : null));
                // A snap over one frame or two (a floor let go in 25 ms straddles two), against the steps either side of it.
                for (const n of [1, 2]) {
                  for (let i = 1; i + n <= steps.length; i++) {
                    const run = steps.slice(i, i + n);
                    if (run.some((v) => v === null)) continue;
                    const moved = run.reduce<number>((sum, v) => sum + (v ?? 0), 0);
                    if (moved <= limit * n) continue;
                    const pre = [i - 3, i - 2, i - 1].map((j) => steps[j]).filter((v): v is number => v != null);
                    const post = [i + n, i + n + 1, i + n + 2].map((j) => steps[j]).filter((v): v is number => v != null);
                    if (!pre.length || !post.length) continue;
                    const around = Math.max(...pre, ...post);
                    if (moved > 2.5 * n * around) {
                      snaps.push(`${px}px ${eyes} side ${ctx.side}, ${from}→${to}: e${k}'s ${what} moves ${moved.toFixed(2)} in ${n} frame(s) at +${((i - 6) / 0.06).toFixed(0)} ms (${around.toFixed(2)} a frame either side)`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  // Live, with the blinks: every change landing 0, 50 and 100 ms into a scheduled blink, every 120 fps
  // frame with the rest blinks drawn. Blocked → done in a blink once stood the worried pair upright for
  // 67 ms: the capsules waited for the blink to reopen, and the worry's lean did not.
  let live = 0;
  for (const px of [20, 96, 160]) {
    for (const eyes of ["soft", "tall"] as const) {
      for (const id of [107, 101]) {
        const s = spec("capsule", px, eyes);
        const ctx = faceCtx(s, "none", id * 3 + 2, true, id);
        const rest: Segment = { state: "idle", at: -60, snap: null };
        for (const from of ["idle", "working", "waiting", "listening", "blocked"] as const) {
          const a: Segment = from === "idle" ? rest : { state: from, at: 1, snap: snapshot(rest, 1, ctx) };
          let start = -1;
          for (let t = 4; t < 80 && start < 0; t += 1 / 240) if (restExtras(ctx, a, t).blink < 0.999) start = t;
          assert.ok(start > 0, `${from} ${px}px blinks at rest`);
          for (const off of [0, 0.05, 0.1]) {
            const Tc = start + off;
            for (const to of AGENT_STATES) {
              if (to === from) continue;
              live++;
              const b: Segment = { state: to, at: Tc, snap: snapshot(a, Tc, ctx) };
              for (let i = 0; i <= 72; i++) {
                const t = Tc + i / 120;
                const P = poseAt(b, t, ctx);
                if (pauseGlyph(screenEyes(drawFace(s, P, restExtras(ctx, b, t, P), ids), px))) {
                  glyphs.push(`live ${px}px ${eyes} side ${ctx.side}, ${from}→${to} ${(off * 1000).toFixed(0)} ms into a blink, +${(i / 0.12).toFixed(0)} ms`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(changes > 1000 && live > 1000, `${changes} changes sampled, ${live} live`);
  assert.equal(snaps.length, 0, `${snaps.length} snaps:\n${snaps.slice(0, 12).join("\n")}`);
  assert.equal(glyphs.length, 0, `${glyphs.length} frames draw ⏸ on the way:\n${glyphs.slice(0, 12).join("\n")}`);
});

test("a small working still parks its rim ball at the upper right (the logo's ball terminal), never the lower right's status dot", () => {
  for (const px of [20, 28]) {
    for (const shape of AGENT_SHAPES) {
      for (const eyes of AGENT_EYES) {
        const s = spec(shape, px, eyes);
        const P = stillPose("working", faceCtx(s, "none", 0, false, 4242));
        const frame = drawFace(s, P, NO_EXTRAS, ids);
        const cx = num(frame.bFront.cx);
        const cy = num(frame.bFront.cy);
        const r = num(frame.kBall.r);
        assert.ok(num(frame.bFront.r) > 0, `${shape}/${eyes} at ${px}px: the still shows its ball`);
        assert.ok(cy < 0 && cx > 0, `${shape}/${eyes} at ${px}px: the parked ball sits at ${cx.toFixed(2)}, ${cy.toFixed(2)} (upper right)`);
        assert.ok(cx > 0 !== bodyOf(shape).badge.x > 0, `${shape}/${eyes} at ${px}px: on the other shoulder from the needs-you notch`);
        const margin = eyeNotchMargin(s);
        for (const [x, y] of eyePointsOf(frame)) {
          const gap = Math.hypot(x - cx, y - cy) - r;
          assert.ok(gap >= margin - 1e-3, `${shape}/${eyes} at ${px}px: an eye comes ${gap.toFixed(3)} R from the parked ball's notch`);
        }
      }
    }
    // The live face arriving off that still rolls its ball down into its swing: no jump.
    const s = spec("orb", px);
    const ctx = faceCtx(s, "none", 99, true);
    const painted = stillPose("working", faceCtx(s, "none", 0, false));
    const seg: Segment = { state: "working", at: 100 - 63, snap: null, from: { pose: painted, at: 100 } };
    let prev: [number, number] | null = null;
    for (let t = 0; t <= 4; t += 1 / 60) {
      const f = drawFace(s, poseAt(seg, 100 + t, ctx), NO_EXTRAS, ids);
      const at: [number, number] = [num(f.bFront.cx), num(f.bFront.cy)];
      if (prev) assert.ok(Math.hypot(at[0] - prev[0], at[1] - prev[1]) < 0.06, `${px}px at +${t.toFixed(2)} s: the arriving rim ball jumps ${Math.hypot(at[0] - prev[0], at[1] - prev[1]).toFixed(3)} R`);
      prev = at;
    }
    assert.ok(prev![1] > 0, `${px}px: and is riding its swing over the lower right 4 s later`);
  }
});

test("at 20 px @1x every pair of the nine silhouettes tells apart (soft IoU under 0.95): bloom's small clover is not tile", () => {
  const px = 20;
  const ss = 4;
  // Coverage per device pixel at 1x.
  const cover = (shape: AgentShape) => {
    const m = swatchMask(shape, px);
    const out = new Float64Array(px * px);
    for (let j = 0; j < px * ss; j++) for (let i = 0; i < px * ss; i++) out[Math.floor(j / ss) * px + Math.floor(i / ss)] += m[j * px * ss + i] / (ss * ss);
    return out;
  };
  const masks = AGENT_SHAPES.map(cover);
  for (let a = 0; a < masks.length; a++) {
    for (let b = a + 1; b < masks.length; b++) {
      let I = 0;
      let U = 0;
      for (let i = 0; i < masks[a].length; i++) {
        I += Math.min(masks[a][i], masks[b][i]);
        U += Math.max(masks[a][i], masks[b][i]);
      }
      assert.ok(I / U < 0.95, `${AGENT_SHAPES[a]} and ${AGENT_SHAPES[b]} draw alike at 20 px @1x (soft IoU ${(I / U).toFixed(3)})`);
    }
  }
  // Each of the small bloom's four waists is a device pixel deep at 20 px @1x.
  const pts = bodyOf("bloom", true).pts;
  const k = pxPerR(px, sizeClass(px));
  let waist = Infinity;
  let lobe = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const x = Math.abs(pts[i]);
    const y = Math.abs(pts[i + 1]);
    if (y < 0.02) waist = Math.min(waist, x);
    lobe = Math.max(lobe, x);
  }
  assert.ok((lobe - waist) * k >= 1, `bloom's waist is ${((lobe - waist) * k).toFixed(2)} px deep at 20 px`);
});

test("Orbit's Needs you card states each fact once: the server's sentence never repeats the task under it", async () => {
  (globalThis as { React?: typeof React }).React = React;
  const { Attention } = await import("../src/components/agents/agents-home");
  const card = (state: AgentState, status: string, stateSentence: string) =>
    renderToStaticMarkup(
      React.createElement(Attention, {
        agent: {
          id: "a1",
          name: "Atlas",
          conversationId: "c1",
          status: "active",
          state,
          stateSentence,
          nextRoutine: null,
          task: { sessionId: "s1", title: "Reply to the Acme renewal", status, needsAttention: state === "waiting", lastActivityAt: new Date(Date.now() - 42 * 60_000).toISOString(), conversationId: "c1" },
        } as unknown as Parameters<typeof Attention>[0]["agent"],
      }),
    );
  const count = (html: string, s: string) => html.split(s).length - 1;
  const asks: Array<[AgentState, string, string, string]> = [
    ["waiting", "waiting_input", "Has a question about Reply to the Acme renewal", "asked"],
    ["waiting", "waiting_approval", "Needs your approval on Reply to the Acme renewal", "needs your approval"],
    ["waiting", "host_offline", "Waiting for your Mac to finish Reply to the Acme renewal", "is waiting for your Mac"],
    ["blocked", "failed", "Blocked before finishing Reply to the Acme renewal", "is blocked"],
    ["blocked", "budget_exceeded", "Blocked: your usage window ran out during Reply to the Acme renewal", "ran out of usage"],
  ];
  for (const [state, status, sentence, lead] of asks) {
    const html = card(state, status, sentence);
    assert.equal(count(html, "Reply to the Acme renewal"), 1, `${status}: the task is named ${count(html, "Reply to the Acme renewal")} times`);
    assert.ok(html.includes(lead), `${status}: the lead says “${lead}”`);
    assert.ok(count(html.toLowerCase(), "blocked") <= 1, `${status}: says blocked twice`);
  }
  // The agent's own words, when they add something, still show.
  const own = card("blocked", "failed", "The bank's site asked for a code sent to your phone");
  assert.ok(own.includes("asked for a code"), "an agent's own reason is kept");
});

/** One curve of blinkCurve, as the runtime's hover notice runs it (0.24 s). */
const noticeCurve = (x: number) => (x < 0 || x >= 1 ? 1 : x < 0.36 ? 1 - 0.94 * (x / 0.36) ** 2 : x < 0.46 ? 0.06 : 0.06 + 0.94 * outCubicRef((x - 0.46) / 0.54));

test("a hover notice joins a blink under way: never a second curve on an acknowledgement, a carried or a scheduled blink, so the eyes never close twice", () => {
  // drawFace multiplies the state's blink (blinkMul) by the rest blinks (X.blink): a notice landing in an
  // acknowledgement multiplied the two curves and the eyes stuttered shut, half open, shut again.
  const rest: Segment = { state: "idle", at: -60, snap: null };
  let landed = 0;
  let joined = 0;
  const stutters: string[] = [];
  for (const px of [28, 34, 96]) {
    for (const to of ["working", "waiting", "listening", "blocked"] as const) {
      for (const seed of [5, 9]) {
        const s = spec("orb", px);
        const ctx = faceCtx(s, "none", seed, true, 107);
        const Tc = 20;
        const seg: Segment = { state: to, at: Tc, snap: snapshot(rest, Tc, ctx) };
        for (let k = 0; k <= 30; k++) {
          const Tn = Tc + k * 0.01;
          const P = poseAt(seg, Tn, ctx);
          // A blink under way, or the state's own still to come (a needs-you face's waits up to 120 ms).
          const under = restExtras(ctx, seg, Tn, P).blink < 0.999 || Array.from({ length: 7 }, (_, j) => poseAt(seg, Tn + j * 0.02, ctx).blinkMul).some((b) => b < 0.999);
          const joins = noticeJoins(seg, Tn, ctx);
          assert.equal(joins, under, `${px}px ${to} +${(k * 10).toFixed(0)} ms: a notice ${joins ? "joins" : "starts"} with ${under ? "a" : "no"} blink under way`);
          landed++;
          if (joins) joined++;
          // The runtime's draw: blinkMul × min(rest blinks, the notice), the notice running only when it starts.
          let low = Infinity;
          let high = -Infinity;
          for (let i = 0; i < 0.6 * 240; i++) {
            const t = Tc + i / 240;
            const Q = poseAt(seg, t, ctx);
            let blink = restExtras(ctx, seg, t, Q).blink;
            if (!joins && t >= Tn) blink = Math.min(blink, 1 + (noticeCurve((t - Tn) / 0.24) - 1) * Q.blinkW);
            assert.ok(!(Q.blinkMul < 0.999 && blink < 0.999), `${px}px ${to}: two blink curves multiplied at +${((t - Tc) * 1000).toFixed(0)} ms`);
            const v = Q.blinkMul * blink;
            if (v < low) [low, high] = [v, v];
            high = Math.max(high, v);
            if (high > low + 0.1 && high < 0.9 && v < high - 0.1) {
              stutters.push(`${px}px ${to} seed ${seed}: a notice ${(k * 10).toFixed(0)} ms in closes the eyes again at +${((t - Tc) * 1000).toFixed(0)} ms`);
              break;
            }
          }
        }
      }
    }
  }
  assert.ok(joined > 100 && joined < landed, `${joined} of ${landed} notices joined a blink`);
  assert.equal(stutters.length, 0, `${stutters.length} stutters:\n${stutters.slice(0, 8).join("\n")}`);
  // A notice still running is joined by a second pointer entry, never restarted (its eyes would jump open).
  const ctx = faceCtx(spec("orb", 96), "none", 5, true, 107);
  assert.ok(noticeJoins(rest, 30.1, ctx, 30), "a notice under way is joined");
  assert.ok(!noticeJoins(rest, 30.3, ctx, 30), "a notice that has ended is not");
});

test("needs you never runs in lockstep: copies handed it in one frame each blink and move a beat of their own apart (up to 120 ms), and the badge comes on at once on every one", () => {
  const rest: Segment = { state: "idle", at: -60, snap: null };
  for (const px of [20, 48, 96]) {
    for (const to of ["waiting", "blocked"] as const) {
      const s = spec("capsule", px, "tall");
      const Tc = 30;
      const runs = [3, 7, 11, 19, 23, 31, 47, 59, 61, 73].map((seed) => {
        const ctx = faceCtx(s, "none", seed, false, 101);
        const seg: Segment = { state: to, at: Tc, snap: snapshot(rest, Tc, ctx) };
        const P0 = poseAt(rest, Tc, ctx);
        let blinkAt = Infinity;
        let moveAt = Infinity;
        const signal: number[] = [];
        for (let i = 0; i <= 0.6 * 240; i++) {
          const P = poseAt(seg, Tc + i / 240, ctx);
          if (blinkAt === Infinity && P.blinkMul < 0.97) blinkAt = (1000 * i) / 240;
          if (moveAt === Infinity && Math.abs(P.yaw - P0.yaw) + Math.abs(P.pitch - P0.pitch) > 0.3) moveAt = (1000 * i) / 240;
          // The badge (and, from 48 px, blocked's stalled orbit) is the signal: it never waits.
          signal.push(P.badgeS + P.ringP + P.ballS + P.ringO);
        }
        return { blinkAt, moveAt, signal };
      });
      const spread = (k: "blinkAt" | "moveAt") => Math.max(...runs.map((r) => r[k])) - Math.min(...runs.map((r) => r[k]));
      assert.ok(runs.every((r) => r.blinkAt <= 160 && r.moveAt <= 160), `${px}px →${to}: every copy acknowledges within 160 ms`);
      assert.ok(spread("blinkAt") >= 50, `${px}px →${to}: blinks begin within ${spread("blinkAt").toFixed(0)} ms of each other`);
      assert.ok(spread("moveAt") >= 50, `${px}px →${to}: heads move within ${spread("moveAt").toFixed(0)} ms of each other`);
      assert.ok(new Set(runs.map((r) => Math.round(r.blinkAt))).size >= 6, `${px}px →${to}: blink onsets bunch`);
      for (const r of runs) r.signal.forEach((v, i) => assert.ok(Math.abs(v - runs[0].signal[i]) < 1e-9, `${px}px →${to}: the badge differs between copies at +${((1000 * i) / 240).toFixed(0)} ms`));
    }
  }
});

test("a preview switching between waiting and blocked at any moment never removes the badge in a frame nor jumps the eyes: the old glyph shrinks away before the new one grows", () => {
  // Switched before the badge was half grown, it went in one frame (the notch with it) and the eyes, no
  // longer pushed clear of it, jumped 0.75 px at 20 px.
  const fails: string[] = [];
  let switches = 0;
  for (const px of [20, 28]) {
    const pxR = pxPerR(px, sizeClass(px));
    for (const shape of AGENT_SHAPES) {
      for (const eyes of ["soft", "wide"] as const) {
        const s = spec(shape, px, eyes);
        const ctx = faceCtx(s, "none", 5, false, 107);
        for (const [a, b] of [["waiting", "blocked"], ["blocked", "waiting"]] as const) {
          for (let k = 1; k <= 9; k++) {
            const first: Segment = { state: a, at: 10, snap: snapshot({ state: "idle", at: -60, snap: null }, 10, ctx) };
            const Tb = 10 + k * 0.05;
            const second: Segment = { state: b, at: Tb, snap: snapshot(first, Tb, ctx) };
            switches++;
            const frames = [drawFace(s, poseAt(first, Tb - 1 / 240, ctx), NO_EXTRAS, ids)];
            for (let i = 0; i <= 0.7 * 240; i++) frames.push(drawFace(s, poseAt(second, Tb + i / 240, ctx), NO_EXTRAS, ids));
            const what = `${px}px ${shape}/${eyes} ${a}→${b} ${(k * 50).toFixed(0)} ms in`;
            for (let i = 1; i < frames.length; i++) {
              const narrows = (num(frames[i - 1].kBadge.width) - num(frames[i].kBadge.width)) * pxR;
              if (narrows > 0.6) fails.push(`${what}: the notch narrows ${narrows.toFixed(2)} px in one frame at +${((1000 * (i - 1)) / 240).toFixed(0)} ms`);
            }
            const E = frames.map((f) => screenEyes(f, px));
            for (const e of [0, 1]) {
              const st = E.map((f, i) => (i && f[e] && E[i - 1][e] ? Math.hypot(f[e]!.x - E[i - 1][e]!.x, f[e]!.y - E[i - 1][e]!.y) : null));
              for (let i = 1; i < st.length; i++) {
                const v = st[i];
                if (v == null || v < 0.3) continue;
                const around = [i - 3, i - 2, i - 1, i + 1, i + 2, i + 3].map((j) => st[j]).filter((x): x is number => x != null);
                if (v > 2.5 * Math.max(0, ...around)) fails.push(`${what}: e${e} jumps ${v.toFixed(2)} px in one frame`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(switches > 600, `${switches} switches`);
  assert.equal(fails.length, 0, `${fails.length} cuts:\n${fails.slice(0, 10).join("\n")}`);
});

test("into thinking mid-blink a large face never reopens its eyes on the way round: the blink under way is their ceiling until they are gone", () => {
  // The turn takes the eyes away; a blink carried on reopened them to full while the head turned (the eyes
  // came back open for a beat, then vanished round the limb).
  const rest: Segment = { state: "idle", at: -60, snap: null };
  const fails: string[] = [];
  let changes = 0;
  for (const px of [96, 160]) {
    for (const eyes of AGENT_EYES) {
      for (const id of [107, 101]) {
        const s = spec("tile", px, eyes);
        const ctx = faceCtx(s, "none", id + 4, true, id);
        let start = -1;
        for (let t = 3; t < 60 && start < 0; t += 1 / 240) if (restExtras(ctx, rest, t).blink < 0.999) start = t;
        for (let k = 0; k < 14; k++) {
          const Tc = start + (k / 13) * 0.24;
          const at = openness(ctx, rest, Tc);
          const seg: Segment = { state: "thinking", at: Tc, snap: snapshot(rest, Tc, ctx) };
          changes++;
          for (let i = 0; i < 0.7 * 240; i++) {
            const t = Tc + i / 240;
            const frame = drawFace(s, poseAt(seg, t, ctx), NO_EXTRAS, ids);
            const seen = (["e0", "e1"] as const).some((e) => frame[e].d && Number(frame[e].opacity ?? 1) > 0.05);
            const v = openness(ctx, seg, t);
            if (seen && v > at + 0.02) {
              fails.push(`${px}px ${eyes} side ${ctx.side}, ${(((Tc - start) * 1000) | 0).toString()} ms into a blink: ${at.toFixed(2)} open at the change, ${v.toFixed(2)} at +${((t - Tc) * 1000).toFixed(0)} ms`);
              break;
            }
          }
        }
      }
    }
  }
  assert.ok(changes > 200, `${changes} changes`);
  assert.equal(fails.length, 0, `${fails.length} changes reopen the eyes on the way round:\n${fails.slice(0, 8).join("\n")}`);
});

test("a face held still (a second copy while a larger one lives) eases into its still frame from where it is: a blink finishes, nothing cuts, then nothing moves; let go, it carries on from there", () => {
  const rest: Segment = { state: "idle", at: -60, snap: null };
  const fails: string[] = [];
  let holds = 0;
  for (const px of [34, 96]) {
    for (const id of [107, 101]) {
      const s = spec("pebble", px, "tall");
      const live = faceCtx(s, "none", id + 2, true, id);
      const held = { ...live, live: false };
      const still = drawFace(s, stillPose("idle", faceCtx(s, "none", 0, false, id)), NO_EXTRAS, ids);
      void still;
      for (const state of AGENT_STATES) {
        const seg: Segment = state === "idle" ? rest : { state, at: 1, snap: snapshot(rest, 1, live) };
        // A moment with a scheduled blink under way when the state blinks at rest, else one well settled.
        let start = 6;
        for (let t = 4; t < 60; t += 1 / 240) {
          if (restExtras(live, seg, t).blink < 0.999) {
            start = t;
            break;
          }
        }
        for (const off of [0, 0.05, 0.1]) {
          const Th = start + off;
          const hold: Segment = { state, at: Th, snap: snapshot(seg, Th, live), hold: true };
          holds++;
          const what = `${px}px side ${live.side} ${state}, held ${(off * 1000).toFixed(0)} ms into a blink`;
          // The live frame before, then every 240 fps frame of the hold.
          const P0 = poseAt(seg, Th - 1 / 240, live);
          const frames = [drawFace(s, P0, restExtras(live, seg, Th - 1 / 240, P0), ids)];
          const open = [P0.blinkMul * restExtras(live, seg, Th - 1 / 240, P0).blink];
          for (let i = 0; i <= 1.5 * 240; i++) {
            const P = poseAt(hold, Th + i / 240, held);
            frames.push(drawFace(s, P, NO_EXTRAS, ids));
            open.push(P.blinkMul);
          }
          for (let i = 1; i < open.length; i++) if (open[i] - open[i - 1] > 0.12) fails.push(`${what}: the eyes open ${(open[i] - open[i - 1]).toFixed(2)} in one frame`);
          const E = frames.map((f) => screenEyes(f, px));
          for (const e of [0, 1]) {
            const st = E.map((f, i) => (i && f[e] && E[i - 1][e] ? Math.hypot(f[e]!.x - E[i - 1][e]!.x, f[e]!.y - E[i - 1][e]!.y) : null));
            for (let i = 1; i < st.length; i++) {
              const v = st[i];
              if (v == null || v < 0.3) continue;
              const around = [i - 3, i - 2, i - 1, i + 1, i + 2, i + 3].map((j) => st[j]).filter((x): x is number => x != null);
              if (v > 2.5 * Math.max(0, ...around)) fails.push(`${what}: e${e} jumps ${v.toFixed(2)} px in one frame at +${((1000 * (i - 1)) / 240).toFixed(0)} ms`);
            }
          }
          // Settled on the state's still frame (the frame a still copy draws), and asking for no more frames.
          const end = Th + 1.5;
          const Pend = poseAt(hold, end, held);
          const want = drawFace(s, stillPose(state, faceCtx(s, "none", 0, false, id)), NO_EXTRAS, ids);
          const got = drawFace(s, Pend, NO_EXTRAS, ids);
          const [a, b] = [screenEyes(got, px), screenEyes(want, px)];
          for (const e of [0, 1]) {
            if (!a[e] !== !b[e] || (a[e] && b[e] && Math.hypot(a[e]!.x - b[e]!.x, a[e]!.y - b[e]!.y) + Math.abs(a[e]!.long - b[e]!.long) > 0.05)) fails.push(`${what}: settles off its still frame`);
          }
          if (nextChange(hold, end, held, Pend) !== Infinity) fails.push(`${what}: still asks for frames 1.5 s in`);
          // Let go: it carries on from the still, the first frame the last held one.
          const back = rebaseSegment(hold, end, held, live);
          const first = drawFace(s, poseAt(back, end, live), NO_EXTRAS, ids);
          if (JSON.stringify(first) !== JSON.stringify(got)) fails.push(`${what}: let go, the first frame is not the held one`);
        }
      }
    }
  }
  assert.ok(holds >= 90, `${holds} holds`);
  assert.equal(fails.length, 0, `${fails.length} cuts:\n${fails.slice(0, 10).join("\n")}`);
});

test("Orbit's routine times never pad a 12-hour hour: 9:00 AM, never 09:00 AM", async () => {
  const { formatLocalWhen } = await import("../src/components/agents/agent-bits");
  const now = new Date(2026, 9, 26, 12, 0);
  for (const [at, lead] of [
    [new Date(2026, 9, 26, 15, 5), "today at "],
    [new Date(2026, 9, 27, 9, 0), "tomorrow at "],
    [new Date(2026, 9, 28, 9, 0), " at "],
  ] as const) {
    const said = formatLocalWhen(at, now);
    assert.ok(said.includes(lead), `“${said}”`);
    assert.ok(!/\b0\d:\d\d\s?[AP]M/i.test(said.replace(/\u202f/g, " ")), `“${said}” pads the hour`);
    assert.ok(/\d{1,2}[:.]\d{2}/.test(said), `“${said}” says the time`);
  }
});
