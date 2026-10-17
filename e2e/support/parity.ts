/**
 * Bubble and composer geometry parity (spec D6, §3.7, §9 "Bubble and composer
 * parity", P0 (5)).
 *
 * Six contexts (web chat, web Code, macOS chat, macOS Code, iOS chat, iOS
 * Code) share one bubble, radii 12/12/12/8 with the 8 tuck on the logical
 * end-end corner and the `--user-bubble` fill, and one composer, radius 22
 * with a radius-12 disc. Web contexts are measured from computed style;
 * native contexts are read from the JSON the native snapshot support writes
 * (Wave2GeometryExport.swift) into ALEVR_NATIVE_GEOMETRY_DIR.
 *
 * The selectors prefer the wave-2 data hooks (`data-alevr-bubble`,
 * `data-alevr-composer`, `data-alevr-disc`) and fall back to today's classes,
 * so the gate reports before and after the owners add them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { BUDGETS } from "./budgets";

export const PARITY_SELECTORS = {
  // Chat's bubble carries the token in its class; Code v2's is .cv2-you.
  bubble: '[data-alevr-bubble], [class*="var(--user-bubble))"], .cv2-you',
  composer: "[data-alevr-composer], .composer-surface, .cv2-composer",
  // ComposerPrimaryAction marks its face (send, stop, voice) with data-face.
  disc: "[data-alevr-disc], .composer-surface button[data-face], .cv2-composer .cv2-send",
} as const;

export interface LogicalRadii {
  startStart: number;
  startEnd: number;
  endEnd: number;
  endStart: number;
}

export interface GeometryRecord {
  context: string;
  platform: "web" | "macos" | "ios";
  bubble?: { radii: LogicalRadii; fill?: string; tokenFill?: string };
  composer?: { radius: number };
  disc?: { radius: number; size?: number };
  /** Where it came from: a URL or a snapshot export file. */
  source?: string;
}

export const EXPECTED_BUBBLE: LogicalRadii = {
  startStart: BUDGETS.bubbleRadii[0],
  startEnd: BUDGETS.bubbleRadii[1],
  endStart: BUDGETS.bubbleRadii[2],
  endEnd: BUDGETS.bubbleRadii[3],
};

const close = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

/** Every way a record differs from the spec. Empty means it conforms. */
export function parityMismatches(record: GeometryRecord): string[] {
  const out: string[] = [];
  const at = `${record.context}`;
  if (record.bubble) {
    for (const corner of ["startStart", "startEnd", "endEnd", "endStart"] as const) {
      if (!close(record.bubble.radii[corner], EXPECTED_BUBBLE[corner])) {
        out.push(`${at}: bubble ${corner} radius ${record.bubble.radii[corner]} (expected ${EXPECTED_BUBBLE[corner]})`);
      }
    }
    if (record.bubble.fill && record.bubble.tokenFill && record.bubble.fill !== record.bubble.tokenFill) {
      out.push(`${at}: bubble fill ${record.bubble.fill} is not the user-bubble token ${record.bubble.tokenFill}`);
    }
  } else {
    out.push(`${at}: no bubble found`);
  }
  if (record.composer) {
    if (!close(record.composer.radius, BUDGETS.composerRadius)) out.push(`${at}: composer radius ${record.composer.radius} (expected ${BUDGETS.composerRadius})`);
  } else {
    out.push(`${at}: no composer found`);
  }
  if (record.disc) {
    if (!close(record.disc.radius, BUDGETS.discRadius)) out.push(`${at}: disc radius ${record.disc.radius} (expected ${BUDGETS.discRadius})`);
  } else {
    out.push(`${at}: no disc found`);
  }
  return out;
}

/** Checks the contexts against the spec and against each other's bubble fill per platform. */
export function evaluateParity(records: readonly GeometryRecord[]): { pass: boolean; mismatches: string[]; contexts: string[] } {
  const mismatches = records.flatMap(parityMismatches);
  return { pass: records.length > 0 && mismatches.length === 0, mismatches, contexts: records.map((r) => r.context) };
}

/** Reads the native snapshot exports; a missing directory is simply no records. */
export function readNativeGeometry(dir: string | undefined): GeometryRecord[] {
  if (!dir || !existsSync(dir)) return [];
  const out: GeometryRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as GeometryRecord;
    if (typeof parsed.context !== "string" || (parsed.platform !== "macos" && parsed.platform !== "ios")) {
      throw new Error(`${name} is not a native geometry export (needs context and platform macos or ios).`);
    }
    out.push({ ...parsed, source: name });
  }
  return out;
}

/** Reads every geometry record (web or native) in a directory. */
export function readGeometryRecords(dir: string): GeometryRecord[] {
  if (!existsSync(dir)) return [];
  const out: GeometryRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as GeometryRecord;
    if (typeof parsed.context !== "string" || !["web", "macos", "ios"].includes(parsed.platform)) {
      throw new Error(`${name} is not a geometry record (needs context and platform web, macos or ios).`);
    }
    out.push({ ...parsed, source: parsed.source ?? name });
  }
  return out;
}

/** Writes one record as <dir>/<context>.json, for the CI job that combines web and native. */
export function writeGeometryRecord(dir: string, record: GeometryRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.context.replace(/[^a-zA-Z0-9-]+/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/** Measures one web context on the current page. */
export async function measureWebGeometry(page: Page, context: string): Promise<GeometryRecord> {
  const raw = await page.evaluate((selectors) => {
    const px = (v: string) => parseFloat(v) || 0;
    const bubble = document.querySelector<HTMLElement>(selectors.bubble);
    const composer = document.querySelector<HTMLElement>(selectors.composer);
    const disc = document.querySelector<HTMLElement>(selectors.disc);
    let bubbleOut: null | { tl: number; tr: number; br: number; bl: number; rtl: boolean; fill: string; tokenFill: string } = null;
    if (bubble) {
      const s = getComputedStyle(bubble);
      const probe = document.createElement("div");
      probe.style.background = "hsl(var(--user-bubble))";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      bubble.parentElement?.appendChild(probe);
      const tokenFill = getComputedStyle(probe).backgroundColor;
      probe.remove();
      bubbleOut = {
        tl: px(s.borderTopLeftRadius),
        tr: px(s.borderTopRightRadius),
        br: px(s.borderBottomRightRadius),
        bl: px(s.borderBottomLeftRadius),
        rtl: s.direction === "rtl",
        fill: s.backgroundColor,
        tokenFill,
      };
    }
    return {
      bubble: bubbleOut,
      composer: composer ? px(getComputedStyle(composer).borderTopLeftRadius) : null,
      disc: disc ? { radius: px(getComputedStyle(disc).borderTopLeftRadius), size: disc.getBoundingClientRect().width } : null,
    };
  }, PARITY_SELECTORS);
  const record: GeometryRecord = { context, platform: "web", source: page.url() };
  if (raw.bubble) {
    const b = raw.bubble;
    record.bubble = {
      radii: b.rtl
        ? { startStart: b.tr, startEnd: b.tl, endEnd: b.bl, endStart: b.br }
        : { startStart: b.tl, startEnd: b.tr, endEnd: b.br, endStart: b.bl },
      fill: b.fill,
      tokenFill: b.tokenFill,
    };
  }
  if (raw.composer !== null) record.composer = { radius: raw.composer };
  if (raw.disc) record.disc = raw.disc;
  return record;
}
