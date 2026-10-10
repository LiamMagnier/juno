import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  WAVEFORM,
  appendWaveformSample,
  waveformBarHeight,
  waveformBars,
} from "@/components/ui/dictation-waveform";
import { dictationKeyAction } from "@/components/chat/composer-dictation";
import { demoDictationSeed, dictationStageFromParam } from "@/components/chat/composer-dictation-stage";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/*
 * DICTATION'S ROW: [✕] [waveform] [✓], the native design's web half
 * (JunoDictationWaveform.swift, ComposerDictation.swift). The waveform's
 * numbers are the native ones, so the three platforms listen the same way.
 */

test("the waveform keeps the native geometry", () => {
  assert.equal(WAVEFORM.historyCapacity, 72);
  assert.equal(WAVEFORM.barWidth, 2.5);
  assert.equal(WAVEFORM.gap, 2.5);
  assert.equal(WAVEFORM.minimumHeight, 2.5);
  assert.equal(WAVEFORM.maximumHeight, 24);
  assert.ok(Math.abs(WAVEFORM.tickMs - 1000 / 30) < 1e-9, "30 Hz, the native meter tick");
});

test("a quiet room is a dotted line; speech rises on a soft curve to the full bar", () => {
  for (const quiet of [0, 0.05, 0.12]) assert.equal(waveformBarHeight(quiet), WAVEFORM.minimumHeight, `${quiet} is a dot`);
  assert.equal(waveformBarHeight(0.8), WAVEFORM.maximumHeight);
  assert.equal(waveformBarHeight(1), WAVEFORM.maximumHeight);
  let previous = 0;
  for (let v = 0.13; v <= 0.8; v += 0.05) {
    const h = waveformBarHeight(v);
    assert.ok(h > previous, "louder is taller");
    previous = h;
  }
  assert.equal(waveformBarHeight(Number.NaN), WAVEFORM.minimumHeight);
});

test("the history scrolls left: newest last, capped at 72", () => {
  const history: number[] = [];
  for (let i = 0; i < 100; i++) appendWaveformSample(history, i / 100);
  assert.equal(history.length, 72);
  assert.equal(history[history.length - 1], 0.99, "the newest sample is last");
  assert.equal(history[0], 0.28, "the oldest fell off the front");
  appendWaveformSample(history, 4);
  assert.equal(history[history.length - 1], 1, "clamped to 0..1");
});

test("bars fill the row right-aligned, the newest against the ✓, the past fading at the leading edge", () => {
  const width = 300;
  const samples = Array.from({ length: 72 }, () => 0.6);
  const bars = waveformBars(samples, width, true);
  const pitch = WAVEFORM.barWidth + WAVEFORM.gap;
  assert.equal(bars.length, Math.floor((width + WAVEFORM.gap) / pitch));
  const last = bars[bars.length - 1];
  assert.ok(Math.abs(last.x + WAVEFORM.barWidth - width) < 1e-9, "the last bar ends at the row's edge");
  // 60 slots, 72 samples: every slot is a voice.
  assert.ok(bars.every((bar) => bar.height > WAVEFORM.minimumHeight));
  assert.ok(bars[0].opacity < bars[bars.length - 1].opacity, "the leading edge fades");
  assert.equal(bars[bars.length - 1].opacity, 1);

  // A wide row and a short history: the empty past is dots.
  const wide = waveformBars([0.6, 0.6], 600, true);
  assert.equal(wide[0].height, WAVEFORM.minimumHeight);
  assert.ok(wide[wide.length - 1].height > WAVEFORM.minimumHeight);
});

test("at rest (finishing, failed) and under reduced motion every bar is a dot", () => {
  const samples = demoDictationSeed();
  for (const bars of [waveformBars(samples, 400, false), waveformBars(samples, 400, true, true)]) {
    assert.ok(bars.every((bar) => bar.height === WAVEFORM.minimumHeight));
  }
  assert.ok(waveformBars(samples, 400, false).every((bar) => bar.opacity <= 0.55), "the quiet ink at rest");
});

test("keys: Esc cancels, Enter finishes, ⌘/Ctrl+Enter sends, IME and Shift+Enter pass through", () => {
  assert.equal(dictationKeyAction({ key: "Escape" }), "cancel");
  assert.equal(dictationKeyAction({ key: "Enter" }), "done");
  assert.equal(dictationKeyAction({ key: "Enter", metaKey: true }), "send");
  assert.equal(dictationKeyAction({ key: "Enter", ctrlKey: true }), "send");
  assert.equal(dictationKeyAction({ key: "Enter", shiftKey: true }), null);
  assert.equal(dictationKeyAction({ key: "Enter", isComposing: true }), null);
  assert.equal(dictationKeyAction({ key: "a" }), null);
});

test("the row is ✕ · waveform · ✓ in the card, with no status word, no meter and no second send disc", () => {
  const src = read("src/components/chat/composer-dictation.tsx");
  const row = src.slice(src.indexOf("export function DictationControls"), src.indexOf("export function ComposerDictation"));
  const cancel = row.indexOf('aria-label="Cancel dictation"');
  const wave = row.indexOf("<DictationWaveform");
  const done = row.indexOf('aria-label="Done dictating"');
  assert.ok(cancel > 0 && wave > cancel && done > wave, "✕, then the waveform, then ✓");
  assert.match(row, /rounded-full bg-primary text-primary-foreground/, "✓ is the send disc's ink circle");
  assert.doesNotMatch(src, /Send what you dictated|DictationMeter|BAR_GAIN|dictation-meter/);
  // The status is for assistive technology only.
  assert.match(src, /role="status" aria-live="polite" className="sr-only"/);
  // In the composer's own surface: no overlay, no portal, no panel.
  assert.match(src, /composer-surface relative flex w-full flex-col rounded-composer/);
  assert.doesNotMatch(src, /createPortal|fixed inset/);
});

test("the waveform and the edge light read one loudness", () => {
  const src = read("src/components/chat/composer-dictation.tsx");
  assert.match(src, /<JunoVoiceGlow\s+level=\{readLevel\}/, "the light follows the take's level");
  assert.match(src, /<DictationControls\s+level=\{readLevel\}/, "the row draws the same level");
  assert.match(src, /normalizedSpeechLoudness\(/, "the realtime -52..-12 dBFS scale, as native");
});

test("every composer dictates through the one row", () => {
  for (const file of [
    "src/components/chat/composer.tsx",
    "src/components/code/v2/composer.tsx",
    "src/components/code/code-composer.tsx",
  ]) {
    assert.match(read(file), /<DictationSwap\b/, `${file} swaps in ComposerDictation`);
  }
  assert.match(read("src/components/ui/dictation-swap.tsx"), /<ComposerDictation\b/);
});

test("galleries stage a take without a microphone", () => {
  const demo = dictationStageFromParam("demo");
  assert.ok(demo);
  assert.equal(demo.final, "Also");
  assert.equal(demo.seed?.length, 72);
  assert.equal(dictationStageFromParam(null), null);
  assert.equal(dictationStageFromParam("nope"), null);
});
