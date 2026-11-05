import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PACER } from "../src/lib/chat/stream-pacer";
import { TIMING_TOKENS } from "../src/lib/design/tokens.generated";
import { fixture, run, STREAM_PACER_FIXTURE_PATH, type Trace } from "../scripts/generate-stream-pacer-fixture";

/*
 * The stream pacer contract (contracts/chat/stream-pacer.v1.json) is the one
 * spec the web pacer and the native `JunoStreamPacer` are both held to. This
 * half proves the file still says what the web does; the Swift half
 * (JunoStreamPacerContractTests) proves the Mac and iPhone do the same.
 */

type FixtureTrace = Omit<Trace, "arrivals"> & {
  arrivals: [number, number][];
  expected: { shown: number[]; cut: number[] };
};
const file = JSON.parse(readFileSync(resolve(process.cwd(), STREAM_PACER_FIXTURE_PATH), "utf8")) as {
  tickMs: number;
  pacer: Record<string, number>;
  ink: { bands: number; bandMs: number; opacity: number[] };
  traces: FixtureTrace[];
};

test("the contract's constants are the web pacer's", () => {
  assert.deepEqual(file.pacer, { ...PACER });
});

test("the contract is current: regenerating it changes nothing", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(fixture())), file);
});

test("every recorded trace replays to the same shown length and cut", () => {
  for (const trace of file.traces) {
    const replay = run({ ...trace, arrivals: trace.arrivals.map(([at, length]) => ({ at, length })) });
    assert.deepEqual(replay.shown, trace.expected.shown, trace.name);
    assert.deepEqual(replay.cut, trace.expected.cut, trace.name);
  }
});

test("the traces exercise what the pacer promises", () => {
  const byName = Object.fromEntries(file.traces.map((t) => [t.name, t]));
  // A burst never lands in one frame.
  const single = byName["single-burst"].expected.shown;
  assert.ok((single.find((n) => n > 0) ?? 0) < 120);
  // A flood jumps to within jumpKeep of the end.
  const flood = byName["stall-then-flood"];
  const landed = flood.expected.shown[Math.ceil(9_000 / file.tickMs) + 1];
  assert.ok(landed >= 3_900 - PACER.jumpKeep - 20, `after the flood: ${landed}`);
  // Every trace ends fully shown.
  for (const t of file.traces) assert.equal(t.expected.shown.at(-1), t.text.length, t.name);
});

test("the ink bands are the ones globals.css paints", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
  const band = /--stream-band:\s*(\d+)ms/.exec(css);
  assert.ok(band, "--stream-band is declared");
  assert.equal(Number(band![1]), file.ink.bands * file.ink.bandMs);
  for (let b = 0; b < file.ink.bands; b++) {
    const rule = new RegExp(`::highlight\\(stream-f${b}\\)\\s*\\{\\s*color:\\s*hsl\\(var\\(--foreground\\)\\s*/\\s*([\\d.]+)\\)`).exec(css);
    assert.ok(rule, `stream-f${b} is painted`);
    assert.equal(Number(rule![1]), file.ink.opacity[b], `stream-f${b}`);
  }
  // The component's own band constants agree.
  const component = readFileSync(resolve(process.cwd(), "src/components/chat/stream-text.tsx"), "utf8");
  assert.match(component, new RegExp(`const BANDS = ${file.ink.bands};`));
  // The band length is read from --stream-band, not typed again; the token
  // over the bands is the contract's band length.
  assert.match(component, /const BAND_MS = TIMING_TOKENS\.stream\.band \/ BANDS;/);
  assert.equal(TIMING_TOKENS.stream.band / file.ink.bands, file.ink.bandMs);
});
