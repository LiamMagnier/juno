/**
 * Geometry audit: the markdown report. Pure: takes the run object the CLI
 * writes to geometry.json and returns markdown.
 */
import { VIOLATION_KINDS, VIOLATION_LABELS, describe, fmt } from "./geometry-lib.mjs";

const HIST_ORDER = [
  ["padding", "Padding (per element, distinct sides)"],
  ["gap", "Gap (flex and grid containers)"],
  ["margin", "Margin (non-auto)"],
  ["sibling-distance", "Measured distance between siblings"],
  ["icon-text-gap", "Icon-to-text gap"],
  ["radius", "Border radius (painted or clipping boxes)"],
  ["border-width", "Border width"],
  ["control-height", "Control height"],
  ["icon-size", "Icon box"],
  ["font-size", "Font size (text-bearing elements)"],
  ["line-height", "Line height"],
];

const SCALE_FOR = {
  padding: "spacing",
  gap: "spacing",
  margin: "spacing",
  "icon-text-gap": "spacing",
  radius: "radius",
  "control-height": "controlHeight",
  "icon-size": "iconSize",
};

export const KIND_HELP = {
  "nested-radius": "a painted child whose corner sits inside its rounded parent's curve, with a radius more than the tolerance away from parent radius minus inset (concentric corners). Circles (avatars, round icon buttons) may be rounder.",
  "corner-poke-out": "a painted child's corner reaches past the curve of a rounded parent that does not clip it, so a square or tighter corner shows outside the parent's shape.",
  "clipped-corner": "a child inset a few px into a rounded parent that clips (overflow hidden): the clip cuts its corner into a lopsided shape. Flush children (media filling a card) are fine.",
  "asymmetric-padding": "a button, tab, menu row, field or row link whose left/right or top/bottom paddings differ. A smaller padding beside a flow icon (optical trim) and a larger one under an overlaid glyph are allowed and listed as notes.",
  "sibling-padding": "siblings of one kind (same tag, role, component, variant, labelled or icon-only) in one menu, list, toolbar or grid that do not share the group's most common padding.",
  "row-height": "controls side by side in one row (outermost boxes: a field's painted shell, a segmented control's track) at different heights.",
  "text-misalignment": "in a column, the first text of a child starting 0.5-3 px from an edge its neighbours share: a near miss, not an indent. Display type pulled to align its ink is a note.",
  "icon-gap": "the gap between a flow icon and its text differs from the one most common in its component family.",
  "target-size": "an interactive element whose hit-tested area is under 24x24 px (44 px at phone width). On desktop a small target with nothing else within 12 px of its centre passes (WCAG 2.5.8 spacing) and is a note.",
};

function pct(n) {
  return `${fmt(n)}%`;
}

function cell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** "16 ×412 · 8 ×300 · 14* ×20" — off-scale values marked with an asterisk. */
export function histogramLine(pairs, scale, tol = 0.5, limit = 40) {
  const total = pairs.reduce((s, [, c]) => s + c, 0);
  const sorted = pairs.slice().sort((a, b) => b[1] - a[1] || (typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]))));
  const shown = sorted.slice(0, limit);
  const parts = shown.map(([v, c]) => {
    const off = scale && typeof v === "number" && !scale.some((r) => Math.abs(r - v) <= tol);
    return `\`${fmt(v)}${off ? "*" : ""}\` ×${c}`;
  });
  const rest = sorted.length - shown.length;
  return `${parts.join(" · ")}${rest > 0 ? ` · … ${rest} more values` : ""} (n=${total}, ${pairs.length} distinct)`;
}

function scaleOf(run, prop) {
  const key = SCALE_FOR[prop];
  if (!key) return null;
  if (prop === "padding") return null; // padding is judged with its border; the asterisk would mislead
  return run.meta.scales[key];
}

function violationTable(byKind) {
  const head = `| ${VIOLATION_KINDS.map((k) => VIOLATION_LABELS[k]).join(" | ")} |`;
  const sep = `|${VIOLATION_KINDS.map(() => "---:").join("|")}|`;
  const row = `| ${VIOLATION_KINDS.map((k) => byKind[k] || 0).join(" | ")} |`;
  return [head, sep, row].join("\n");
}

export function renderMarkdown(run, { compare = null, examplesPerKind = 6, offScaleRows = 12 } = {}) {
  const m = run.meta;
  const site = run.site;
  const L = [];
  L.push("# Geometry audit");
  L.push("");
  L.push(`Base \`${m.base}\` · viewport ${m.viewport.width}×${m.viewport.height}${m.phone ? " (phone: 44 px touch targets)" : ""} · ${m.scheme} · ${m.full ? "full document" : "first viewport"} · ${site.routes} routes (${site.measured} measured${site.failed ? `, ${site.failed} failed` : ""}) · ${site.elements} elements`);
  L.push("");
  L.push("Scales checked against:");
  L.push("");
  L.push(`- spacing (padding, gap, margin, icon-to-text gap): ${m.scales.spacing.join(", ")}. A padding passes when it, or it plus that side's border, lands on a rung.`);
  L.push(`- radius (tailwind.config.ts ladder${m.radiusSource ? `, ${m.radiusSource}` : ""}): ${m.scales.radius.join(", ")}, full${m.scales.radiusPercent?.length ? `, ${m.scales.radiusPercent.map((p) => `${p}%`).join(", ")}` : ""}`);
  L.push(`- control heights: ${m.scales.controlHeight.join(", ")} (controls up to ${m.tolerances.maxControlHeight} px tall)`);
  L.push(`- icon boxes: ${m.scales.iconSize.join(", ")}`);
  L.push(`- tolerance ±${m.tolerances.scale} px on every scale; nested radius ±${m.tolerances.nestedRadius} px; near-miss text edges ${m.tolerances.alignMin}–${m.tolerances.alignMax} px; targets ${m.phone ? m.tolerances.targetTouch : m.tolerances.targetPointer} px`);
  L.push("");

  L.push("What each check means:");
  L.push("");
  for (const kind of VIOLATION_KINDS) L.push(`- **${VIOLATION_LABELS[kind]}**: ${KIND_HELP[kind]}`);
  L.push("");

  L.push("## Score");
  L.push("");
  L.push(`**Site score ${fmt(site.score)}** / 100 = half values on scale (${pct(site.scaleShare)}) + half checked elements with no violation (${pct(site.cleanShare)}). Mean route score ${fmt(site.meanRouteScore)}. ${site.violations} violations on ${site.flagged} of ${site.checked} checked elements.`);
  L.push("");
  L.push("| Scale | On scale | Measured | Share |");
  L.push("|---|---:|---:|---:|");
  for (const [k, label] of [["spacing", "Spacing"], ["radius", "Radius"], ["controlHeight", "Control height"], ["iconSize", "Icon box"]]) {
    const g = site.scale[k];
    L.push(`| ${label} | ${g.on} | ${g.total} | ${g.total ? pct((100 * g.on) / g.total) : "-"} |`);
  }
  L.push("");
  L.push(violationTable(site.byKind));
  L.push("");

  if (compare) {
    L.push("## Before and after");
    L.push("");
    if (compare.site) L.push(`Site score ${fmt(compare.site.before)} → ${fmt(compare.site.after)} (${compare.site.delta >= 0 ? "+" : ""}${fmt(compare.site.delta)}).`);
    L.push("");
    L.push("| Route | Before | After | Δ | Violations before | after |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const r of compare.routes) L.push(`| ${cell(r.name)} | ${fmt(r.before)} | ${fmt(r.after)} | ${r.delta >= 0 ? "+" : ""}${fmt(r.delta)} | ${r.violationsBefore} | ${r.violationsAfter} |`);
    L.push("");
  }

  L.push("## Routes");
  L.push("");
  L.push(`| Route | Score | On scale | Clean | Elements | ${VIOLATION_KINDS.map((k) => VIOLATION_LABELS[k]).join(" | ")} |`);
  L.push(`|---|---:|---:|---:|---:|${VIOLATION_KINDS.map(() => "---:").join("|")}|`);
  for (const r of run.routes) {
    if (!r.score) {
      L.push(`| [${cell(r.name)}](#${r.slug}) | failed | | | | ${VIOLATION_KINDS.map(() => "").join(" | ")} |`);
      continue;
    }
    L.push(`| [${cell(r.name)}](#${r.slug}) | ${fmt(r.score.score)} | ${pct(r.score.scaleShare)} | ${pct(r.score.cleanShare)} | ${r.elements} | ${VIOLATION_KINDS.map((k) => r.counts.byKind[k] || 0).join(" | ")} |`);
  }
  L.push("");

  L.push("## Scales in use (whole site)");
  L.push("");
  L.push("Each value with its count, most common first. `*` marks a value off its scale.");
  L.push("");
  for (const [prop, label] of HIST_ORDER) {
    const pairs = site.histograms[prop];
    if (!pairs || !pairs.length) continue;
    L.push(`- **${label}**: ${histogramLine(pairs, scaleOf(run, prop), m.tolerances.scale)}`);
  }
  L.push("");

  L.push("## Off-scale values (whole site)");
  L.push("");
  L.push("| Property | Value | Nearest rung | Count | Routes |");
  L.push("|---|---:|---:|---:|---|");
  for (const o of site.offScale.slice(0, 40)) {
    const routes = [...new Set(o.routes)];
    L.push(`| ${o.property} | ${fmt(o.value)} | ${fmt(o.nearest)} | ${o.count} | ${cell(routes.slice(0, 6).join(", "))}${routes.length > 6 ? ` +${routes.length - 6}` : ""} |`);
  }
  if (site.offScale.length > 40) L.push(`\n… ${site.offScale.length - 40} more off-scale values in geometry.json.`);
  L.push("");

  for (const r of run.routes) {
    L.push(`<a id="${r.slug}"></a>`);
    L.push(`### ${r.name}`);
    L.push("");
    if (r.error) {
      L.push(`Failed: ${r.error}`);
      L.push("");
      continue;
    }
    const vpNote = r.viewport && r.viewport !== `${m.viewport.width}x${m.viewport.height}` ? ` · viewport ${r.viewport}` : "";
    L.push(`\`${r.finalPath || r.path}\`${vpNote} · score **${fmt(r.score.score)}** (on scale ${pct(r.score.scaleShare)}, clean ${pct(r.score.cleanShare)}) · ${r.elements} elements${r.truncated ? " (truncated)" : ""}${r.hydrated === false ? " · not hydrated: no component names" : ""}${r.stillLoading ? " · **still showing loading placeholders when measured**" : ""}`);
    L.push("");
    if (r.screenshot) {
      L.push(`![${r.name}](${r.screenshot})`);
      L.push("");
    }
    if (r.offenders?.length) {
      L.push("Worst offenders (numbers match the screenshot):");
      L.push("");
      for (const o of r.offenders) L.push(`${o.n}. **${VIOLATION_LABELS[o.kind] || o.kind}** · ${cell(describe(o.el))} at ${fmt(o.el.rect[0])},${fmt(o.el.rect[1])} (${fmt(o.el.rect[2])}×${fmt(o.el.rect[3])}) · ${cell(o.message)} · \`${cell(o.el.path)}\``);
      L.push("");
    }
    if (r.offScale?.length) {
      L.push("| Off-scale property | Value | Nearest | Count | Example |");
      L.push("|---|---:|---:|---:|---|");
      for (const o of r.offScale.slice(0, offScaleRows)) L.push(`| ${o.property} | ${fmt(o.value)} | ${fmt(o.nearest)} | ${o.count} | ${cell(o.examples[0] ? describe(o.examples[0]) : "")} |`);
      if (r.offScale.length > offScaleRows) L.push(`\n… ${r.offScale.length - offScaleRows} more.`);
      L.push("");
    }
    const byKind = new Map();
    for (const v of r.violations) {
      if (!byKind.has(v.kind)) byKind.set(v.kind, []);
      byKind.get(v.kind).push(v);
    }
    for (const kind of VIOLATION_KINDS) {
      const list = byKind.get(kind);
      if (!list) continue;
      L.push(`<details><summary>${VIOLATION_LABELS[kind]}: ${list.length}</summary>`);
      L.push("");
      for (const v of list.slice(0, examplesPerKind)) L.push(`- ${cell(describe(v.el))}: ${cell(v.message)} · \`${cell(v.el.path)}\``);
      if (list.length > examplesPerKind) L.push(`- … ${list.length - examplesPerKind} more in geometry.json`);
      L.push("");
      L.push("</details>");
      L.push("");
    }
  }
  return L.join("\n");
}
