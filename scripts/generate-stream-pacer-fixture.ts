/**
 * Emit the stream pacer contract: the web pacer's constants, the ink-in bands,
 * and the shown length the web pacer produces for a set of recorded arrival
 * traces, sampled on a fixed 16 ms tick.
 *
 * One file, two consumers:
 *
 *   - tests/stream-pacer-contract.test.ts re-runs the traces through
 *     src/lib/chat/stream-pacer.ts and requires the exact same numbers, and
 *     checks the ink bands against globals.css's `::highlight(stream-f*)`.
 *   - native JunoDesignSystemTests/JunoStreamPacerContractTests.swift runs the
 *     same traces through `JunoStreamPacer` and requires the shown length to
 *     match within one grapheme at every tick (REA chat UX design, test T4).
 *
 * The expected values are produced by the WEB implementation on purpose: the
 * Swift port is held to what the web actually does, not to a second copy of
 * the algorithm written down by hand.
 *
 *   npx tsx scripts/generate-stream-pacer-fixture.ts           # write
 *   npx tsx scripts/generate-stream-pacer-fixture.ts --check   # exit 1 on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { initPacer, pacerArrive, pacerStep, revealCut, PACER } from "../src/lib/chat/stream-pacer";

export const STREAM_PACER_FIXTURE_PATH = "contracts/chat/stream-pacer.v1.json";

/** The tick every trace is sampled on (ms). */
export const TICK_MS = 16;

/** The ink-in fade: five age bands over `--stream-band` (globals.css). */
export const INK = {
  bands: 5,
  bandMs: 56,
  /** Ink per band, newest first: `::highlight(stream-f0..4)` alpha. */
  opacity: [0.35, 0.52, 0.68, 0.82, 0.92],
} as const;

export type Arrival = { at: number; length: number };
export type Trace = {
  name: string;
  note: string;
  text: string;
  arrivals: Arrival[];
  until: number;
};
export type TraceResult = Trace & { expected: { shown: number[]; cut: number[] } };

/** mulberry32: a tiny seeded PRNG, so the traces are the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "the", "reader", "follows", "a", "steady", "line", "of", "ink", "while", "bursts", "arrive",
  "from", "the", "network", "and", "settle", "into", "words", "**bold**", "`code`", "internationalisation-friendly",
  "pacing", "never", "lags", "far", "behind", "🙂", "naïve", "café", "streamed", "text", "is", "smooth",
];

/** Deterministic prose with markdown, a long word, accents and surrogate pairs. */
function prose(seed: number, length: number): string {
  const next = rng(seed);
  let out = "";
  let sentence = 0;
  while (out.length < length) {
    const word = WORDS[Math.floor(next() * WORDS.length)];
    out += (out && !out.endsWith("\n") ? " " : "") + word;
    sentence += 1;
    if (sentence > 9 && next() < 0.2) {
      out += next() < 0.3 ? ".\n\n" : ".";
      sentence = 0;
    }
  }
  return out.slice(0, length);
}

function chunked(seed: number, text: string, opts: { gap: [number, number]; size: [number, number]; start?: number }): Arrival[] {
  const next = rng(seed);
  const out: Arrival[] = [];
  let at = opts.start ?? 0;
  let length = 0;
  while (length < text.length) {
    at += Math.round(opts.gap[0] + next() * (opts.gap[1] - opts.gap[0]));
    length = Math.min(text.length, length + Math.round(opts.size[0] + next() * (opts.size[1] - opts.size[0])));
    out.push({ at, length });
  }
  return out;
}

export function traces(): Trace[] {
  const steadyText = prose(1, 3000);
  const burstyText = prose(2, 2600);
  const floodText = prose(3, 4200);
  const replaceText = prose(4, 900);
  const longText = prose(5, 6000);
  const steady = Array.from({ length: 200 }, (_, i) => ({ at: i * 50 + (i % 3) * 20, length: (i + 1) * 15 }));
  return [
    {
      name: "steady",
      note: "15 characters every ~50 ms with jitter: comes out steady, a beat behind.",
      text: steadyText,
      arrivals: steady,
      until: 10_600,
    },
    {
      name: "bursty",
      note: "80-300 character bursts on an irregular 100-600 ms clock.",
      text: burstyText,
      arrivals: chunked(22, burstyText, { gap: [100, 600], size: [80, 300] }),
      until: 9_000,
    },
    {
      name: "single-burst",
      note: "300 characters at once, then nothing: spread over frames, caught up within ~1 s.",
      text: burstyText.slice(0, 300),
      arrivals: [{ at: 100, length: 300 }],
      until: 2_000,
    },
    {
      name: "stall-then-flood",
      note: "A slow trickle, a stall, then a 3000-character backlog lands (a reconnect replay): it jumps to the last screenful.",
      text: floodText,
      arrivals: [
        ...chunked(33, floodText.slice(0, 600), { gap: [60, 140], size: [10, 30] }),
        { at: 9_000, length: 3_900 },
        { at: 9_400, length: floodText.length },
      ],
      until: 11_000,
    },
    {
      name: "replace",
      note: "The text grows, is replaced by a shorter one (a regenerate), then grows again.",
      text: replaceText,
      arrivals: [
        ...chunked(44, replaceText.slice(0, 400), { gap: [40, 90], size: [8, 24] }),
        { at: 2_400, length: 120 },
        ...chunked(45, replaceText.slice(0, 900), { gap: [40, 90], size: [8, 24], start: 2_400 }).filter((a) => a.length > 120),
      ],
      until: 6_500,
    },
    {
      name: "long-answer",
      note: "A long answer at a realistic model cadence with occasional proxy buffering.",
      text: longText,
      arrivals: chunked(55, longText, { gap: [16, 220], size: [4, 90] }),
      until: 30_000,
    },
  ];
}

/** Drive the web pacer over one trace on the fixed tick. */
export function run(trace: Trace): { shown: number[]; cut: number[] } {
  let s = initPacer(0, 0);
  let length = 0;
  let p = 0;
  const shown: number[] = [];
  const cut: number[] = [];
  for (let t = 0; t <= trace.until; t += TICK_MS) {
    while (p < trace.arrivals.length && trace.arrivals[p].at <= t) length = trace.arrivals[p++].length;
    s = pacerArrive(s, length, t);
    s = pacerStep(s, length, TICK_MS);
    shown.push(Math.floor(s.shown));
    cut.push(revealCut(trace.text.slice(0, length), s.shown));
  }
  return { shown, cut };
}

export function fixture() {
  return {
    $comment:
      "Generated by scripts/generate-stream-pacer-fixture.ts from src/lib/chat/stream-pacer.ts. DO NOT EDIT. " +
      "Consumed by tests/stream-pacer-contract.test.ts and JunoDesignSystemTests/JunoStreamPacerContractTests.swift.",
    version: 1,
    tickMs: TICK_MS,
    pacer: { ...PACER },
    ink: INK,
    // Arrivals as [atMs, receivedLength] pairs.
    traces: traces().map((trace) => ({
      ...trace,
      arrivals: trace.arrivals.map((a) => [a.at, a.length]),
      expected: run(trace),
    })),
  };
}

function serialise(value: unknown): string {
  // One trace array per line keeps the file reviewable without being enormous.
  const flat = (_: string, body: string) => `[${body.replace(/\s+/g, " ")}]`;
  return (
    JSON.stringify(value, null, 2)
      .replace(/\[\s+([-\d.,\s]+?)\s+\]/g, flat)
      // The arrival pairs: one array of pairs per line.
      .replace(/("arrivals": )\[\s+((?:\[[-\d., ]+\],?\s*)+)\]/g, (_, key: string, body: string) => `${key}[${body.replace(/\s+/g, " ").trim()}]`) + "\n"
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("generate-stream-pacer-fixture.ts");
if (isMain) {
  const path = resolve(process.cwd(), STREAM_PACER_FIXTURE_PATH);
  const next = serialise(fixture());
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current !== next) {
      console.error(`${STREAM_PACER_FIXTURE_PATH} is out of date: run npx tsx scripts/generate-stream-pacer-fixture.ts`);
      process.exit(1);
    }
    console.log(`${STREAM_PACER_FIXTURE_PATH} is up to date`);
  } else {
    writeFileSync(path, next);
    console.log(`wrote ${STREAM_PACER_FIXTURE_PATH}`);
  }
}
