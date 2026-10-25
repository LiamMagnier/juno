/**
 * What this machine can do, recorded on every results file so a reader knows
 * why a check was or was not run.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fixturesDigest, REPO_ROOT } from "./fixtures";
import type { BenchEnvironment, ProductInfo } from "./types";
import { findSoffice, sofficeVersion } from "./validators/office";

export function gitState(): { commit: string | null; dirty: boolean | null } {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (rev.status !== 0) return { commit: null, dirty: null };
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO_ROOT, encoding: "utf8" });
  return { commit: rev.stdout.trim(), dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
}

export function alevrProduct(surface: string): ProductInfo {
  let version = "unknown";
  try {
    version = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    /* keep unknown */
  }
  const git = gitState();
  return {
    id: "alevr",
    name: "Alevr",
    version: `${version}${git.commit ? `+${git.commit.slice(0, 12)}${git.dirty ? "-dirty" : ""}` : ""}`,
    surface,
  };
}

/** Provider ids with a key configured — names only, never the keys. */
export async function configuredProviderIds(): Promise<string[]> {
  try {
    const { configuredProviders } = await import("@/lib/providers");
    return configuredProviders().map(String);
  } catch {
    return [];
  }
}

export async function detectEnvironment(options: { network: boolean }): Promise<BenchEnvironment> {
  const git = gitState();
  const soffice = findSoffice();
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    providersConfigured: await configuredProviderIds(),
    libreoffice: sofficeVersion(soffice),
    network: options.network,
    gitCommit: git.commit,
    gitDirty: git.dirty,
    fixturesDigest: fixturesDigest(),
  };
}
