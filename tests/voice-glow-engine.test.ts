import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  GLOW_TIMING,
  HANDOFF_PASS,
  REST_AMP,
  createGlowState,
  frameVector,
  gateLevel,
  glowFrame,
  handoffBeams,
  isDark,
  sameFrame,
  simulateGlow,
  stepGlow,
  type GlowInput,
  type GlowMode,
} from "@/components/voice/voice-glow-engine";
import { GLOW_PALETTE, contrastRatio, resolveGlowPalette } from "@/components/voice/voice-glow-palette";

const DT = 1 / 60;

function run(seconds: number, input: Partial<GlowInput> & { mode: GlowMode }, state = createGlowState()) {
  const full: GlowInput = { you: 0, alevr: 0, reduced: false, ...input };
  for (let t = 0; t < seconds; t += DT) stepGlow(state, full, DT);
  return state;
}

const vec = (s: ReturnType<typeof createGlowState>, reduced = false) => frameVector(glowFrame(s, reduced));

test("silence is perfectly still: the rest pose settles and stops changing", () => {
  const s = run(1.5, { mode: "you", you: 0.07 }); // a quiet room, under the gate
  const a = vec(s);
  stepGlow(s, { mode: "you", you: 0.09, alevr: 0, reduced: false }, DT);
  const b = vec(s);
  assert.ok(sameFrame(a, b), "a silent frame must equal the next one, so nothing is redrawn");
  assert.equal(s.envYou, 0, "the envelope snaps to exactly zero");
  assert.ok(Math.abs(glowFrame(s, false).you.amp - REST_AMP) < 1e-6, "whose floor it is: a faint still light");
  assert.equal(glowFrame(s, false).alevr.amp, 0);
});

test("a room is not a voice: the gate holds below speech loudness", () => {
  assert.equal(gateLevel(0), 0);
  assert.equal(gateLevel(0.1), 0);
  assert.equal(gateLevel(0.16), 0);
  assert.ok(gateLevel(0.3) > 0 && gateLevel(0.3) < gateLevel(0.6));
  assert.equal(gateLevel(1), 1);
  assert.equal(gateLevel(Number.NaN), 0);
});

test("each voice follows its own audio, so talking over Alevr lights both", () => {
  const s = run(0.6, { mode: "alevr", you: 0.75, alevr: 0.7 });
  const f = glowFrame(s, false);
  assert.ok(f.alevr.amp > 0.7, `Alevr speaking: ${f.alevr.amp}`);
  assert.ok(f.you.amp > 0.6, `you talking over it: ${f.you.amp}`);
  assert.ok(f.you.lift > 0.5 && f.alevr.lift > 0.5);
});

test("muted hears nothing from your microphone and holds still", () => {
  const s = run(1, { mode: "muted", you: 0.9 });
  const f = glowFrame(s, false);
  assert.equal(f.you.amp, 0);
  assert.ok(f.muted > 0.5);
  const a = vec(s);
  stepGlow(s, { mode: "muted", you: 0.4, alevr: 0, reduced: false }, DT);
  assert.ok(sameFrame(a, vec(s)), "a muted light never moves");
});

test("off leaves on the exit rung and draws nothing", () => {
  const s = run(1, { mode: "you", you: 0.8 });
  run(0.3, { mode: "off", you: 0.8 }, s);
  assert.ok(isDark(vec(s)), "no light once off");
});

test("tone states cross over on the base rung (220 ms)", () => {
  const s = run(1, { mode: "you" });
  run(GLOW_TIMING.base, { mode: "alevr" }, s);
  assert.ok(s.wAlevr >= 0.94, `presence in by 220 ms: ${s.wAlevr}`);
  assert.ok(s.wYou <= 0.06, `ember out by 220 ms: ${s.wYou}`);
});

test("the light arrives on the slow rung when a call comes up", () => {
  const s = run(GLOW_TIMING.slow, { mode: "you" });
  assert.ok(s.on >= 0.94 && s.on <= 1, `${s.on}`);
});

test("thinking is the Continuum handoff: 6 × 70 ms steps of a 220 ms tone, re-passing every 1.6 s", () => {
  assert.ok(Math.abs(HANDOFF_PASS - 0.57) < 1e-9);
  const [start] = handoffBeams(0);
  assert.equal(start.pos, 0, "leaves from your end");
  assert.equal(start.mix, 0, "in ember");
  const [arrived] = handoffBeams(HANDOFF_PASS);
  assert.equal(arrived.pos, 1, "arrives at Alevr's end");
  assert.ok(arrived.mix > 0.999, "in presence ink");
  const [handed] = handoffBeams(GLOW_TIMING.handoffStagger + GLOW_TIMING.handoffTone);
  assert.ok(handed.mix > 0.999, "the tone step completes one stagger plus one tone in");
  const [mid] = handoffBeams(1.0);
  assert.equal(mid.pos, 1, "between passes it rests at Alevr's end");
  const [again, previous] = handoffBeams(GLOW_TIMING.repass);
  assert.equal(again.pos, 0, "the next pass leaves from your end again");
  assert.ok(previous.amp > 0.4 && previous.pos === 1, "while the last one fades where it arrived");
  const [, gone] = handoffBeams(GLOW_TIMING.repass + GLOW_TIMING.handoffTone);
  assert.ok(gone.amp < 1e-6);
});

test("reduced motion: static tone states that ignore the audio", () => {
  const loud = vec(run(1, { mode: "you", you: 0.9, reduced: true }), true);
  const quiet = vec(run(1, { mode: "you", you: 0, reduced: true }), true);
  assert.deepEqual(loud, quiet);
  const t = glowFrame(run(2, { mode: "thinking", reduced: true }), true);
  assert.deepEqual(
    t.beams.map((b) => b.pos),
    [0, 1],
    "thinking holds ember at your end and presence at Alevr's"
  );
  const a = vec(run(2, { mode: "thinking", reduced: true }), true);
  const b = vec(run(2.5, { mode: "thinking", reduced: true }), true);
  assert.ok(sameFrame(a, b), "no travel");
});

test("a simulated moment is the same picture every time", () => {
  const at = (ms: number): GlowInput => ({ mode: ms < 800 ? "you" : "thinking", you: ms < 800 ? 0.6 : 0, alevr: 0, reduced: false });
  assert.deepEqual(vec(simulateGlow(1300, at)), vec(simulateGlow(1300, at)));
});

test("the palette: ember and presence hold their contrast on the grounds they light", () => {
  assert.ok(contrastRatio(GLOW_PALETTE.light.you.line, "#fcfcfd") >= 4.5);
  assert.ok(contrastRatio(GLOW_PALETTE.light.alevr.line, "#fcfcfd") >= 7);
  assert.ok(contrastRatio(GLOW_PALETTE.dark.you.line, "#18191b") >= 7);
  assert.ok(contrastRatio(GLOW_PALETTE.dark.alevr.line, "#18191b") >= 7);
  assert.equal(GLOW_PALETTE.light.alevr.line, "#2d49c9", "Alevr is presence ink");
  assert.equal(GLOW_PALETTE.dark.alevr.line, "#97a6e6");
});

test("the CSS tokens are the palette (globals.css and the fallback cannot drift)", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `${selector} block`);
    const body = css.slice(i, css.indexOf("}", i));
    return (token: string) => (new RegExp(`${token}:\\s*([^;]+);`).exec(body)?.[1] ?? "").trim();
  };
  for (const [selector, theme] of [
    [".voice-glow", "light"],
    [".dark .voice-glow", "dark"],
  ] as const) {
    const read = block(selector);
    const resolved = resolveGlowPalette(read);
    const expected = resolveGlowPalette(() => "", theme);
    assert.equal(resolved.dark, theme === "dark");
    assert.deepEqual(resolved, expected, `${selector} tokens match GLOW_PALETTE.${theme}`);
  }
});
