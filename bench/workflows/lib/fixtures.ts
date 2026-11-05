/**
 * Frozen inputs. Every product in a comparison gets the same bytes, so the
 * runner refuses to start when a fixture's SHA-256 differs from MANIFEST.json.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./validators/util";

/** Repository root, resolved from this file (bench/workflows/lib). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const BENCH_DIR = path.join(REPO_ROOT, "bench", "workflows");
export const FIXTURES_DIR = path.join(BENCH_DIR, "fixtures");
export const HIDDEN_DIR = path.join(BENCH_DIR, "hidden");
export const MANIFEST_PATH = path.join(FIXTURES_DIR, "MANIFEST.json");

export interface FixtureManifest {
  note: string;
  files: Record<string, string>;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (full !== MANIFEST_PATH) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export function computeManifest(fixturesDir = FIXTURES_DIR, hiddenDir = HIDDEN_DIR): FixtureManifest {
  const files: Record<string, string> = {};
  for (const rel of walk(fixturesDir)) files[rel] = sha256(readFileSync(path.join(fixturesDir, rel)));
  for (const rel of walk(hiddenDir)) files[`hidden/${rel}`] = sha256(readFileSync(path.join(hiddenDir, rel)));
  return {
    note: "SHA-256 of every frozen benchmark input and held-out test. Regenerate only on purpose: `npm run bench:workflows -- manifest`.",
    files,
  };
}

export function writeManifest(): FixtureManifest {
  const manifest = computeManifest();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Problems with the frozen inputs; empty means every file matches. */
export function verifyFixtures(fixturesDir = FIXTURES_DIR, hiddenDir = HIDDEN_DIR, manifestPath = MANIFEST_PATH): string[] {
  if (!existsSync(manifestPath)) return [`missing ${path.relative(REPO_ROOT, manifestPath)}`];
  const expected = (JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest).files;
  const actual = computeManifest(fixturesDir, hiddenDir).files;
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) problems.push(`missing fixture ${file}`);
    else if (actual[file] !== hash) problems.push(`fixture changed: ${file}`);
  }
  for (const file of Object.keys(actual)) if (!(file in expected)) problems.push(`unlisted fixture ${file}`);
  return problems;
}

/** One digest over the manifest, recorded on every results file. */
export function fixturesDigest(): string {
  return existsSync(MANIFEST_PATH) ? sha256(readFileSync(MANIFEST_PATH)) : "missing";
}
