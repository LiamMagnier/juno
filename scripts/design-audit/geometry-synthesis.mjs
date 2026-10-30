#!/usr/bin/env node
/**
 * Geometry synthesis: reads several geometry-audit runs of one product (light
 * and dark at desktop width, light at phone width...) and writes one report
 * across them: the scales actually in use, the offenders ranked by impact with
 * a cropped screenshot of each, the nested-radius and alignment problems, and
 * a per-page score table.
 *
 *   node scripts/design-audit/geometry-synthesis.mjs \
 *     --runs /tmp/geometry/light-1440,/tmp/geometry/dark-1440,/tmp/geometry/light-390 \
 *     --out /tmp/geometry/synthesis [--top 30] [--crops 60]
 *
 * Every run is re-scored from its raw records with the current rules (as
 * --reanalyze does), so the runs are judged alike. Writes synthesis.md,
 * synthesis.json and crops/<n>-<route>.png into --out. No app server needed.
 *
 * An offender is one problem on one component (same check, component, element
 * kind and values), wherever it appears. Its impact is its badness (the
 * severity weight times its size in px, as the per-route ranking uses) times
 * the number of pages it shows on, a page being a route at a viewport: dark
 * and light at one width are one page, so a scheme does not count twice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { KIND_COLORS, VIOLATION_KINDS, VIOLATION_LABELS, analyzeRoute, badness, describe, fmt, makeContext, mergeHistograms, parseViewport, refOf, round2 } from "./geometry-lib.mjs";

const require = createRequire(import.meta.url);

/** Spacing-like properties, then the rest, in the order the report shows them. */
export const SCALE_PROPERTIES = [
  ["padding", "Padding"],
  ["gap", "Gap"],
  ["margin", "Margin"],
  ["sibling-distance", "Distance between siblings"],
  ["icon-text-gap", "Icon-to-text gap"],
  ["radius", "Corner radius"],
  ["border-width", "Border width"],
  ["control-height", "Control height"],
  ["icon-size", "Icon box"],
  ["font-size", "Font size"],
  ["line-height", "Line height"],
];

const STRUCTURE_KINDS = new Set(["nested-radius", "corner-poke-out", "clipped-corner"]);
const ALIGNMENT_KINDS = new Set(["text-misalignment", "row-height", "icon-gap", "asymmetric-padding", "sibling-padding", "sibling-radius"]);

/**
 * How a value set is used: the values that cover `core` (90%) of all uses,
 * most used first, and the long tail beyond them. Pairs are [value, count].
 */
export function scaleUsage(pairs, core = 0.9) {
  const total = pairs.reduce((s, [, c]) => s + c, 0);
  const sorted = pairs.slice().sort((a, b) => b[1] - a[1] || (typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]))));
  const head = [];
  let covered = 0;
  for (const p of sorted) {
    if (total && covered / total >= core) break;
    head.push(p);
    covered += p[1];
  }
  const tail = sorted.slice(head.length);
  return {
    total,
    distinct: pairs.length,
    head,
    tail,
    tailUses: tail.reduce((s, [, c]) => s + c, 0),
    once: sorted.filter(([, c]) => c === 1).length,
  };
}

/** The values that make an issue the same issue on another page: no coordinates. */
export function issueSignature(f) {
  if (f.kind === "off-scale") return `${f.values.property} ${fmt(f.values.value)} → ${fmt(f.values.nearest)}`;
  if (f.kind === "text-misalignment") return f.message.replace(/ \([^)]*\)$/, "");
  if (f.kind === "target-size") return f.message.replace(/^(\S+ )?target /, "target ");
  return f.message;
}

/** One key per problem on one component, wherever it appears. */
export function issueKey(f, ref) {
  const who = ref.comp || `<${ref.tag}>`;
  return [f.kind, who, ref.tag, ref.role || "", issueSignature(f)].join("|");
}

/**
 * Group findings from many pages into offenders and rank them by impact.
 * `items` are { page, finding, ref, related, origin }: page is "route @ viewport".
 */
export function groupOffenders(items) {
  const groups = new Map();
  for (const it of items) {
    const key = issueKey(it.finding, it.ref);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind: it.finding.kind, severity: it.finding.severity, signature: issueSignature(it.finding), who: describe(it.ref), comp: it.ref.comp || null, pages: new Set(), elements: new Set(), worst: null };
      groups.set(key, g);
    }
    g.pages.add(it.page);
    g.elements.add(`${it.page}|${it.ref.path}`);
    const b = badness(it.finding);
    if (!g.worst || b > g.worst.badness || (b === g.worst.badness && it.origin.order < g.worst.origin.order)) g.worst = { badness: b, finding: it.finding, ref: it.ref, related: it.related, origin: it.origin, page: it.page };
  }
  const out = [...groups.values()].map((g) => ({
    key: g.key,
    kind: g.kind,
    severity: g.worst.finding.severity,
    signature: g.signature,
    who: g.who,
    comp: g.comp,
    pages: [...g.pages].sort(),
    elements: g.elements.size,
    badness: round2(g.worst.badness),
    impact: round2(g.worst.badness * g.pages.size),
    example: g.worst,
  }));
  out.sort((a, b) => b.impact - a.impact || b.elements - a.elements || a.key.localeCompare(b.key));
  return out;
}

function parseArgs(argv) {
  const args = { top: 30, crops: 60 };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--help") args.help = true;
    else if (["--runs", "--out", "--top", "--crops"].includes(a)) args[a.slice(2)] = argv[++k];
    else throw new Error(`Unknown argument ${a} (see --help)`);
  }
  args.top = Number(args.top) || 30;
  args.crops = Number(args.crops) || 0;
  return args;
}

function loadRun(dir, order) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, "geometry.json"), "utf8"));
  const vpDefault = `${run.meta.viewport.width}x${run.meta.viewport.height}`;
  const label = `${run.meta.scheme} ${run.meta.viewport.width}`;
  const routes = [];
  for (const r of run.routes) {
    const rawPath = path.join(dir, "raw", `${r.slug}.json`);
    if (!r.score || !fs.existsSync(rawPath)) {
      routes.push({ name: r.name, slug: r.slug, error: r.error || "not measured" });
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    const viewport = r.viewport || raw.viewportName || vpDefault;
    const ctx = makeContext({ scales: run.meta.scales, tolerances: run.meta.tolerances, viewport: parseViewport(viewport) });
    const analysis = analyzeRoute(raw.records, ctx);
    routes.push({ name: r.name, slug: r.slug, viewport, stillLoading: !!r.stillLoading, finalPath: r.finalPath, records: raw.records, analysis, clean: path.join(dir, "shots", `${r.slug}.clean.png`), shot: r.screenshot ? path.join(dir, r.screenshot) : null });
  }
  return { dir, order, label, meta: run.meta, routes };
}

function pct(n) {
  return `${fmt(round2(n))}%`;
}

function cell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function valueList(pairs, limit = 24) {
  const shown = pairs.slice(0, limit).map(([v, c]) => `\`${fmt(v)}\`×${c}`);
  return `${shown.join(" ")}${pairs.length > limit ? ` … +${pairs.length - limit}` : ""}`;
}

async function cropOffender(sharp, o, file, maxWidth = 760) {
  const ex = o.example;
  const route = ex.origin.route;
  if (!fs.existsSync(route.clean)) return false;
  const img = sharp(route.clean);
  const meta = await img.metadata();
  const vp = parseViewport(route.viewport);
  const dpr = Math.max(1, meta.width / vp.width);
  const [x, y, w, h] = ex.ref.rect;
  // Frame the parent or row it is judged against too, when that stays small enough to read.
  let [fx, fy, fr, fb] = [x, y, x + w, y + h];
  for (const r of ex.related || []) {
    const [rx, ry, rw, rh] = r.rect;
    const u = [Math.min(fx, rx), Math.min(fy, ry), Math.max(fr, rx + rw), Math.max(fb, ry + rh)];
    if (u[2] - u[0] <= 720 && u[3] - u[1] <= 440) [fx, fy, fr, fb] = u;
  }
  const pad = 48;
  const minW = Math.min(vp.width, 420);
  const minH = 220;
  let left = fx - pad;
  let top = fy - pad;
  let right = fr + pad;
  let bottom = fb + pad;
  if (right - left < minW) {
    const grow = (minW - (right - left)) / 2;
    left -= grow;
    right += grow;
  }
  if (bottom - top < minH) {
    const grow = (minH - (bottom - top)) / 2;
    top -= grow;
    bottom += grow;
  }
  const W = meta.width / dpr;
  const H = meta.height / dpr;
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(W, right);
  bottom = Math.min(H, bottom);
  if (right - left < 4 || bottom - top < 4) return false;
  const px = (v) => Math.round(v * dpr);
  const region = { left: px(left), top: px(top), width: Math.min(meta.width - px(left), px(right - left)), height: Math.min(meta.height - px(top), px(bottom - top)) };
  const color = (KIND_COLORS[o.kind] || ["#111"])[0];
  const rel = (ex.related || [])
    .map((r) => r.rect)
    .map(([rx, ry, rw, rh]) => `<rect x="${px(rx - left)}" y="${px(ry - top)}" width="${px(rw)}" height="${px(rh)}" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-dasharray="${px(4)} ${px(3)}" stroke-width="${px(1)}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}">${rel}<rect x="${px(x - left) - px(1)}" y="${px(y - top) - px(1)}" width="${px(w) + px(2)}" height="${px(h) + px(2)}" fill="none" stroke="${color}" stroke-width="${px(2)}"/></svg>`;
  let out = sharp(route.clean).extract(region).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  if (region.width > maxWidth) out = sharp(await out.png().toBuffer()).resize({ width: maxWidth });
  await out.png().toFile(file);
  return true;
}

function render(runs, offenders, args, outDir, cropFiles) {
  const L = [];
  const relShot = (p) => (p ? path.relative(outDir, p) : null);
  L.push("# Geometry synthesis");
  L.push("");
  L.push(`Runs: ${runs.map((r) => `${r.label} (\`${r.dir}\`, ${r.routes.filter((x) => x.analysis).length}/${r.routes.length} measured)`).join(" · ")}.`);
  L.push("");
  L.push("Each run is re-scored from its raw records with the current rules. A *page* is a route at one viewport: light and dark at the same width are one page, so a problem seen in both schemes counts once.");
  L.push("");

  // Scales in use: counts from the first run at each viewport; distinct values across every run.
  const firstPerViewport = new Map();
  for (const run of runs) for (const r of run.routes) if (r.analysis && !firstPerViewport.has(`${r.viewport}|${r.name}`)) firstPerViewport.set(`${r.viewport}|${r.name}`, r);
  const merged = mergeHistograms([...firstPerViewport.values()].map((r) => r.analysis.histograms));
  const everywhere = mergeHistograms(runs.flatMap((run) => run.routes.filter((r) => r.analysis).map((r) => r.analysis.histograms)));
  L.push("## Scales in use");
  L.push("");
  L.push("Counts are uses (one per element and property) on every page; *core* is the smallest set of values covering 90% of uses, most used first; the *long tail* is everything else. Distinct values include every run.");
  L.push("");
  L.push("| Property | Uses | Distinct | Used once | Core (90% of uses) | Long tail |");
  L.push("|---|---:|---:|---:|---|---|");
  const usage = {};
  for (const [prop, label] of SCALE_PROPERTIES) {
    const pairs = merged[prop] || [];
    if (!pairs.length) continue;
    const u = scaleUsage(pairs);
    usage[prop] = { ...u, distinctEverywhere: (everywhere[prop] || []).length };
    L.push(`| ${label} | ${u.total} | ${u.distinct}${usage[prop].distinctEverywhere !== u.distinct ? ` (${usage[prop].distinctEverywhere} with dark)` : ""} | ${u.once} | ${valueList(u.head, 14)} | ${u.tail.length} values, ${u.tailUses} uses (${pct((100 * u.tailUses) / u.total)}): ${valueList(u.tail, 18)} |`);
  }
  L.push("");

  // Offenders.
  L.push(`## Top ${Math.min(args.top, offenders.length)} offenders by impact`);
  L.push("");
  L.push("Impact = badness × pages. Badness is the severity weight (1, 2.5 or 5) × (1 + px off / 4, capped at 24 px), the same ranking the per-route screenshots use. Crops show the worst instance outlined (dashed: the parent or row it is judged against).");
  L.push("");
  L.push("| # | Impact | Check | Where | Problem | Pages | Elements | Example |");
  L.push("|---:|---:|---|---|---|---:|---:|---|");
  offenders.slice(0, args.top).forEach((o, k) => {
    const crop = cropFiles.get(o.key);
    const ex = o.example;
    L.push(`| ${k + 1} | ${fmt(o.impact)} | ${VIOLATION_LABELS[o.kind]} | ${cell(o.who)} | ${cell(o.signature)} | ${o.pages.length} | ${o.elements} | ${crop ? `[crop](${crop})` : ""}${ex.origin.route.shot ? ` · [${cell(ex.origin.route.name)} @ ${ex.origin.route.viewport} ${ex.origin.run.meta.scheme}](${relShot(ex.origin.route.shot)})` : ""} |`);
  });
  L.push("");
  offenders.slice(0, args.top).forEach((o, k) => {
    const crop = cropFiles.get(o.key);
    L.push(`### ${k + 1}. ${VIOLATION_LABELS[o.kind]}: ${o.signature}`);
    L.push("");
    L.push(`${o.who} · \`${o.example.ref.path}\` · impact ${fmt(o.impact)} on ${o.pages.length} page(s): ${o.pages.slice(0, 8).join(", ")}${o.pages.length > 8 ? `, … ${o.pages.length - 8} more` : ""}.`);
    L.push("");
    if (crop) L.push(`![${cell(o.signature)}](${crop})`);
    L.push("");
  });

  const section = (title, kinds, intro) => {
    const list = offenders.filter((o) => kinds.has(o.kind));
    L.push(`## ${title}`);
    L.push("");
    L.push(intro);
    L.push("");
    if (!list.length) {
      L.push("None.");
      L.push("");
      return;
    }
    L.push("| Impact | Check | Where | Problem | Pages | Example |");
    L.push("|---:|---|---|---|---:|---|");
    for (const o of list) {
      const crop = cropFiles.get(o.key);
      L.push(`| ${fmt(o.impact)} | ${VIOLATION_LABELS[o.kind]} | ${cell(o.who)} | ${cell(o.signature)} | ${o.pages.length} | ${crop ? `[crop](${crop}) · ` : ""}${cell(o.example.page)} |`);
    }
    L.push("");
  };
  section("Nested radius, corners poking out, corners cut by a clip", STRUCTURE_KINDS, "Every corner problem across the runs (rose, crimson and wine outlines on the route screenshots).");
  section("Alignment, padding symmetry and sibling consistency", ALIGNMENT_KINDS, "Text edges that nearly line up, controls of different heights in one row, icon gaps that differ within a family, asymmetric control padding, and siblings drawn with a different padding or radius from their group.");
  section("Targets", new Set(["target-size"]), "Interactive elements under 24 px (44 px at phone width).");

  // Per-page scores.
  L.push("## Per-page scores");
  L.push("");
  L.push("Score / 100 = half values on scale + half checked elements with no violation; then the number of violations. (loading) = measured while placeholders still showed; FAILED = not measured.");
  L.push("");
  const names = [];
  for (const run of runs) for (const r of run.routes) if (!names.includes(r.name)) names.push(r.name);
  L.push(`| Route | ${runs.map((r) => r.label).join(" | ")} |`);
  L.push(`|---|${runs.map(() => "---:").join("|")}|`);
  for (const name of names) {
    const cells = runs.map((run) => {
      const r = run.routes.find((x) => x.name === name);
      if (!r) return "–";
      if (!r.analysis) return "FAILED";
      const a = r.analysis;
      return `${r.shot ? `[${fmt(a.score.score)}](${relShot(r.shot)})` : fmt(a.score.score)} · ${a.counts.violations}${r.stillLoading ? " (loading)" : ""}`;
    });
    L.push(`| ${cell(name)} | ${cells.join(" | ")} |`);
  }
  const siteRow = runs.map((run) => {
    const ok = run.routes.filter((r) => r.analysis);
    const c = ok.reduce((s, r) => ({ on: s.on + r.analysis.counts.scaleOn, total: s.total + r.analysis.counts.scaleTotal, checked: s.checked + r.analysis.counts.checked, flagged: s.flagged + r.analysis.counts.flagged, v: s.v + r.analysis.counts.violations }), { on: 0, total: 0, checked: 0, flagged: 0, v: 0 });
    const score = 50 * (c.total ? c.on / c.total : 1) + 50 * (c.checked ? 1 - c.flagged / c.checked : 1);
    return `**${fmt(round2(score))}** · ${c.v}`;
  });
  L.push(`| **Site** | ${siteRow.join(" | ")} |`);
  L.push("");
  return { markdown: L.join("\n"), usage };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runs || !args.out) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/")).replace(/^ \* ?/gm, ""));
    if (!args.help) process.exitCode = 1;
    return;
  }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(path.join(outDir, "crops"), { recursive: true });
  const runs = String(args.runs)
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d, k) => loadRun(path.resolve(d), k));
  const items = [];
  for (const run of runs) {
    for (const route of run.routes) {
      if (!route.analysis) continue;
      const page = `${route.name} @ ${route.viewport}`;
      const order = run.order * 1000 + run.routes.indexOf(route);
      for (const f of [...route.analysis.findings, ...route.analysis.offScaleFindings]) {
        const ref = refOf(route.records[f.el]);
        items.push({ page, finding: f, ref, related: (f.related || []).map((i) => refOf(route.records[i])), origin: { run, route, order } });
      }
    }
  }
  const offenders = groupOffenders(items);
  const cropFiles = new Map();
  let sharp = null;
  try {
    sharp = require("sharp");
  } catch {
    console.error("geometry-synthesis: sharp is not installed; no crops (the tables link the annotated route screenshots)");
  }
  if (sharp) {
    const wanted = [...offenders.slice(0, Math.max(args.top, 0)), ...offenders.filter((o) => STRUCTURE_KINDS.has(o.kind) || ALIGNMENT_KINDS.has(o.kind) || o.kind === "target-size")];
    let n = 0;
    for (const o of wanted) {
      if (cropFiles.has(o.key) || n >= args.crops) continue;
      n++;
      const name = `${String(n).padStart(2, "0")}-${o.kind}-${o.example.origin.route.slug}.png`.slice(0, 120);
      try {
        if (await cropOffender(sharp, o, path.join(outDir, "crops", name))) cropFiles.set(o.key, path.join("crops", name));
      } catch (err) {
        console.error(`geometry-synthesis: no crop for ${o.key}: ${err?.message || err}`);
      }
    }
  }
  const { markdown, usage } = render(runs, offenders, args, outDir, cropFiles);
  fs.writeFileSync(path.join(outDir, "synthesis.md"), markdown);
  const json = {
    runs: runs.map((r) => ({ dir: r.dir, label: r.label, measured: r.routes.filter((x) => x.analysis).length, routes: r.routes.length })),
    usage: Object.fromEntries(Object.entries(usage).map(([k, u]) => [k, { total: u.total, distinct: u.distinct, distinctEverywhere: u.distinctEverywhere, once: u.once, head: u.head, tail: u.tail }])),
    offenders: offenders.map((o) => ({ kind: o.kind, who: o.who, comp: o.comp, signature: o.signature, severity: o.severity, badness: o.badness, impact: o.impact, pages: o.pages, elements: o.elements, crop: cropFiles.get(o.key) || null, example: { page: o.example.page, run: o.example.origin.run.dir, ref: o.example.ref, related: o.example.related, message: o.example.finding.message, values: o.example.finding.values } })),
    pages: runs.map((run) => ({ run: run.label, routes: run.routes.map((r) => (r.analysis ? { name: r.name, viewport: r.viewport, score: r.analysis.score, counts: r.analysis.counts, stillLoading: r.stillLoading } : { name: r.name, error: r.error })) })),
  };
  fs.writeFileSync(path.join(outDir, "synthesis.json"), JSON.stringify(json, null, 1));
  const kinds = VIOLATION_KINDS.map((k) => `${k} ${offenders.filter((o) => o.kind === k).length}`).join(", ");
  console.error(`geometry-synthesis: ${offenders.length} offenders (${kinds}, off-scale ${offenders.filter((o) => o.kind === "off-scale").length}); ${cropFiles.size} crops; wrote ${path.join(outDir, "synthesis.md")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`geometry-synthesis: ${process.env.GEOMETRY_DEBUG ? err?.stack || err : err?.message || err}`);
    process.exit(1);
  });
}
