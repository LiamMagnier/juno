// Renders Alevr web icons (src/components/ui/juno-icons) to inline SVG strings
// for the static mocks. Knockouts are approximated with a background-coloured
// stroke so the house "gap" survives in a flat SVG.
import { CATALOG_ICONS, CATALOG_ALIASES } from "../../../../src/components/ui/juno-icons/catalog.ts";

function attrs(a) {
  return Object.entries(a).map(([k, v]) => `${(k === "pathLength" ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()))}="${v}"`).join(" ");
}
function el(e) {
  if (e.tag === "g") return `<g>${(e.children || []).map(el).join("")}</g>`;
  if (e.knockout) {
    const a = { ...e.attrs, stroke: "var(--icon-ko, hsl(var(--bg)))", fill: e.attrs.fill && e.attrs.fill !== "none" ? "var(--icon-ko, hsl(var(--bg)))" : "none", "stroke-width": e.knockout === "tight" ? 1.5 : 4.5 };
    return `<${e.tag} ${attrs(a)}/>`;
  }
  return `<${e.tag} ${attrs(e.attrs)}/>`;
}
export function icon(name, size = 16, cls = "") {
  const key = CATALOG_ICONS[name] ? name : CATALOG_ALIASES[name];
  const d = key && CATALOG_ICONS[key];
  if (!d) throw new Error("missing icon " + name);
  const body = (size < 18 && d.small?.elements ? d.small.elements : d.elements).map(el).join("");
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${(1.25 * 24 / size).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
export const names = () => Object.keys(CATALOG_ICONS).concat(Object.keys(CATALOG_ALIASES));
