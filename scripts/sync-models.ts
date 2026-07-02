/**
 * Model-registry sync — compares every configured provider's live model list
 * against the curated registry and maintains src/lib/models.generated.ts.
 *
 *   npm run sync:models          dry run: report adds / possibly-unavailable
 *   npm run sync:models:write    --write --prune: regenerate the file
 *
 * Safety rails: never edits models.ts; never prunes image/video models; never
 * prunes a provider whose fetch failed or returned an empty list; --write
 * without --prune only ADDS (UNAVAILABLE is left untouched).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROVIDER_LIST, isProviderConfigured, type Provider } from "../src/lib/providers";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, RETIRED_MODELS, prettifyModelName, type ModelInfo } from "../src/lib/models";
import { DISCOVERED, UNAVAILABLE, type DiscoveredModel } from "../src/lib/models.generated";
import { FAMILIES, curate, fetchProviderModelIds, stripPrefix } from "../src/lib/model-discovery-core";

// npm run always executes from the package root; everything is cwd-relative.
const ROOT = process.cwd();
const GENERATED_PATH = join(ROOT, "src/lib/models.generated.ts");
const CLI_TIMEOUT_MS = 10_000;

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const PRUNE = args.includes("--prune");

// —— Env loading (.env then .env.local; never override already-set keys) ——

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #"); // inline comment on unquoted values
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// —— Per-provider diff ——

type ProviderState = "ok" | "no-key" | "failed" | "empty" | "gen-only";

interface ProviderReport {
  provider: Provider;
  state: ProviderState;
  detail?: string;
  added: DiscoveredModel[];
  newlyUnavailable: string[]; // curated chat ids absent from the live list
  stillUnavailable: string[]; // already recorded, still absent
  recovered: string[]; // recorded UNAVAILABLE but live again
  unchanged: number; // curated chat models confirmed live
}

function emptyReport(provider: Provider, state: ProviderState, detail?: string): ProviderReport {
  return { provider, state, detail, added: [], newlyUnavailable: [], stillUnavailable: [], recovered: [], unchanged: 0 };
}

/** Fuzzy availability: a curated model counts as live when a live id matches
 *  exactly, is a dated snapshot of it, resolves its -latest alias, or shares
 *  its prettified name. Biased toward NOT pruning. */
function isLive(m: ModelInfo, liveBare: string[], liveSet: Set<string>): boolean {
  if (liveSet.has(m.providerModel)) return true;
  const snapshotPrefix = `${m.providerModel}-`;
  const latestStem = /-latest$/.test(m.providerModel) ? m.providerModel.replace(/-latest$/, "") : null;
  const prettyTargets = new Set([m.name.toLowerCase(), prettifyModelName(m.providerModel).toLowerCase()]);
  for (const live of liveBare) {
    if (live.startsWith(snapshotPrefix)) return true;
    if (latestStem && live.startsWith(latestStem)) return true;
    if (prettyTargets.has(prettifyModelName(live).toLowerCase())) return true;
  }
  return false;
}

/** A live id that is just a variant of a curated model — a dated snapshot
 *  (curated-id-YYYYMM…) or the snapshot behind a -latest alias — is not new.
 *  Mirrors the prune-side fuzzy rules so add/prune stay symmetric. */
function isCuratedVariant(bare: string, curatedChat: readonly ModelInfo[]): boolean {
  return curatedChat.some(
    (m) =>
      bare.startsWith(`${m.providerModel}-`) ||
      (/-latest$/.test(m.providerModel) && bare.startsWith(m.providerModel.replace(/-latest$/, "")))
  );
}

async function syncProvider(provider: Provider, knownIds: Set<string>, knownNames: Set<string>): Promise<ProviderReport> {
  if (!isProviderConfigured(provider)) return emptyReport(provider, "no-key", "no API key — skipped");

  const curatedChat = CURATED_CHAT_MODELS.filter((m) => m.provider === provider);
  // Gen-only labs (e.g. Seedance) often don't list image/video models on
  // /models — nothing to add or prune, so don't even fetch.
  if (!curatedChat.length && !FAMILIES[provider]) {
    return emptyReport(provider, "gen-only", "image/video-only provider — skipped");
  }

  let rawIds: string[];
  try {
    rawIds = await fetchProviderModelIds(provider, CLI_TIMEOUT_MS);
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "request timed out" : e instanceof Error ? e.message : String(e);
    return emptyReport(provider, "failed", `fetch failed (${reason}) — no changes for this provider`);
  }
  if (!rawIds.length) return emptyReport(provider, "empty", "live list empty — treated as a failed fetch, no pruning");

  const report = emptyReport(provider, "ok");
  const liveBare = [...new Set(rawIds.map(stripPrefix))];
  const liveSet = new Set(liveBare);

  // NEW models: family-curated latest ids that nothing in the registry knows.
  const curatedNamesForProvider = new Set(curatedChat.map((m) => m.name.toLowerCase()));
  const seenNames = new Set<string>();
  for (const info of curate(provider, rawIds)) {
    const bare = stripPrefix(info.providerModel);
    const canonical = `${provider}:${bare}`;
    const nameKey = info.name.toLowerCase();
    if (knownIds.has(canonical) || isCuratedVariant(bare, curatedChat)) continue;
    if (curatedNamesForProvider.has(nameKey) || knownNames.has(`${provider}:${nameKey}`) || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    report.added.push({ provider, id: bare, name: info.name });
  }

  // UNAVAILABLE candidates: curated CHAT models only, exact id absent and no
  // fuzzy match (image/video models are never pruned — labs rarely list them).
  const prevUnavailable = new Set(UNAVAILABLE);
  for (const m of curatedChat) {
    if (isLive(m, liveBare, liveSet)) {
      if (prevUnavailable.has(m.id)) report.recovered.push(m.id);
      else report.unchanged++;
    } else if (prevUnavailable.has(m.id)) {
      report.stillUnavailable.push(m.id);
    } else {
      report.newlyUnavailable.push(m.id);
    }
  }
  return report;
}

// —— Generated-file rendering ——

const providerOrder = (id: string) => PROVIDER_LIST.indexOf(id.split(":")[0] as Provider);

function renderGenerated(stamp: string, discovered: DiscoveredModel[], unavailable: string[]): string {
  const sortedDiscovered = [...discovered].sort(
    (a, b) => PROVIDER_LIST.indexOf(a.provider) - PROVIDER_LIST.indexOf(b.provider) || a.id.localeCompare(b.id)
  );
  const sortedUnavailable = [...unavailable].sort((a, b) => providerOrder(a) - providerOrder(b) || a.localeCompare(b));
  const rows = sortedDiscovered.map(
    (d) => `  { provider: ${JSON.stringify(d.provider)}, id: ${JSON.stringify(d.id)}, name: ${JSON.stringify(d.name)} },`
  );
  return `// AUTO-GENERATED by scripts/sync-models.ts — do not edit by hand.
// Dry run: \`npm run sync:models\` · regenerate: \`npm run sync:models:write\`.
import type { Provider } from "@/lib/providers";

export interface DiscoveredModel {
  provider: Provider;
  /** Bare provider model id, exactly as the provider API expects it. */
  id: string;
  name: string;
}

/** ISO timestamp of the last successful \`--write\` sync (null = never synced). */
export const SYNC_STAMP: string | null = ${JSON.stringify(stamp)};

/** Genuinely new chat models found on providers' live model APIs. Dumb data —
 *  plan/vision/reasoning/cost/webSearch are derived in models.ts via the
 *  guess* helpers, pending hand-curation. */
export const DISCOVERED: DiscoveredModel[] = [${rows.length ? `\n${rows.join("\n")}\n` : ""}];

/** Canonical "provider:providerModel" ids of curated CHAT models the live API
 *  no longer serves — hidden from pickers; stored ids migrate in models.ts. */
export const UNAVAILABLE: string[] = [${sortedUnavailable.length ? `\n${sortedUnavailable.map((id) => `  ${JSON.stringify(id)},`).join("\n")}\n` : ""}];
`;
}

// —— Report ——

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function printReport(reports: ProviderReport[]): void {
  const stateLabel: Record<ProviderState, string> = {
    ok: "ok",
    "no-key": "skipped (no key)",
    failed: "FAILED",
    empty: "skipped (empty)",
    "gen-only": "skipped (gen-only)",
  };
  const nameW = Math.max(...reports.map((r) => r.provider.length), "provider".length) + 2;
  const stateW = Math.max(...Object.values(stateLabel).map((s) => s.length)) + 2;
  console.log(`\n${pad("provider", nameW)}${pad("status", stateW)}${pad("added", 8)}${pad("unavail", 9)}unchanged`);
  for (const r of reports) {
    const unavail = r.newlyUnavailable.length + r.stillUnavailable.length;
    const dash = r.state === "ok" ? undefined : "—";
    console.log(
      `${pad(r.provider, nameW)}${pad(stateLabel[r.state], stateW)}${pad(dash ?? String(r.added.length), 8)}${pad(dash ?? String(unavail), 9)}${dash ?? String(r.unchanged)}`
    );
  }
  console.log("");
  for (const r of reports) {
    const lines: string[] = [];
    if (r.detail) lines.push(`  note: ${r.detail}`);
    for (const d of r.added) lines.push(`  + ${d.id}  (${d.name})`);
    for (const id of r.newlyUnavailable) lines.push(`  - ${id}  (not served — ${PRUNE && WRITE ? "recording as UNAVAILABLE" : "would record with --write --prune"})`);
    for (const id of r.stillUnavailable) lines.push(`  - ${id}  (still unavailable)`);
    for (const id of r.recovered) lines.push(`  ~ ${id}  (served again — ${PRUNE && WRITE ? "removing from UNAVAILABLE" : "would restore with --write --prune"})`);
    if (lines.length) console.log(`${r.provider}\n${lines.join("\n")}`);
  }
}

// —— Main ——

async function main(): Promise<number> {
  loadEnvFile(join(ROOT, ".env"));
  loadEnvFile(join(ROOT, ".env.local"));

  if (PRUNE && !WRITE) console.warn("note: --prune only takes effect together with --write.");

  // Everything the registry already knows, by exact canonical id.
  const knownIds = new Set<string>([
    ...CURATED_CHAT_MODELS.map((m) => m.id),
    ...CURATED_GEN_MODELS.map((m) => m.id),
    ...Object.keys(RETIRED_MODELS),
    ...DISCOVERED.map((d) => `${d.provider}:${d.id}`),
  ]);
  // Previously discovered names, so renamed snapshots don't duplicate entries.
  const knownNames = new Set<string>(DISCOVERED.map((d) => `${d.provider}:${d.name.toLowerCase()}`));

  const reports = await Promise.all(PROVIDER_LIST.map((p) => syncProvider(p, knownIds, knownNames)));
  printReport(reports);

  const added = reports.flatMap((r) => r.added);
  const failures = reports.filter((r) => r.state === "failed");
  const pruneDelta = reports.reduce((n, r) => n + r.newlyUnavailable.length + r.recovered.length, 0);

  if (!WRITE) {
    const pending = added.length + (PRUNE ? pruneDelta : 0);
    console.log(
      pending || pruneDelta
        ? `dry run — no files written. Apply with: npm run sync:models:write`
        : `dry run — registry is in sync with the live provider APIs.`
    );
  } else {
    const okProviders = new Set(reports.filter((r) => r.state === "ok").map((r) => r.provider));
    let unavailable = [...UNAVAILABLE];
    if (PRUNE) {
      // Recompute for successfully-fetched providers; keep everyone else's
      // entries untouched (a failed fetch must never resurrect or prune).
      unavailable = UNAVAILABLE.filter((id) => !okProviders.has(id.split(":")[0] as Provider));
      for (const r of reports) if (r.state === "ok") unavailable.push(...r.stillUnavailable, ...r.newlyUnavailable);
    }
    writeFileSync(GENERATED_PATH, renderGenerated(new Date().toISOString(), [...DISCOVERED, ...added], unavailable));
    console.log(`wrote src/lib/models.generated.ts (+${added.length} discovered, ${unavailable.length} unavailable).`);

    console.log("\nrunning npm run validate:models …");
    const validate = spawnSync("npm", ["run", "validate:models"], { cwd: ROOT, stdio: "inherit" });
    if (validate.status !== 0) {
      console.error("validate:models FAILED — review src/lib/models.generated.ts before committing.");
      return validate.status ?? 1;
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} provider fetch(es) failed: ${failures.map((r) => r.provider).join(", ")}.`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("sync-models crashed:", err);
    process.exit(1);
  });
