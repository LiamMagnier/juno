/**
 * Panels, devices, machinery and version control.
 *
 * The gear is generated rather than hand-plotted: eight lobes placed by
 * trigonometry hit their angles exactly, which a hand-written `d` never quite
 * does, and the one-line change from eight teeth to six is what let the mark
 * survive 14px. `data-part="rotor"` turns it a twelfth of a turn on hover —
 * one tooth, so the gear lands back on itself.
 */
import { createIcon as icon, p, c, rect, dot, dashed, type IconElement } from "./create-icon";

/* — The gear ——————————————————————————————————————————————————————— */

const TAU = Math.PI * 2;
const at = (angle: number, radius: number) => [
  +(12 + radius * Math.cos(angle)).toFixed(2),
  +(12 - radius * Math.sin(angle)).toFixed(2),
];

/**
 * A cog as arcs: `teeth` lobes of half-width `tooth` radians at `outer`,
 * joined by valleys at `inner`. Angles increase counter-clockwise on screen
 * (y is down), so every arc is drawn with sweep-flag 0.
 */
function cog(teeth: number, outer: number, inner: number, tooth: number, gap: number): string {
  const step = TAU / teeth;
  const start = at(-tooth, outer);
  let d = `M${start[0]} ${start[1]}`;
  for (let i = 0; i < teeth; i += 1) {
    const base = i * step;
    const crestEnd = at(base + tooth, outer);
    d += `A${outer} ${outer} 0 0 0 ${crestEnd[0]} ${crestEnd[1]}`;
    const valleyStart = at(base + tooth + gap, inner);
    d += `L${valleyStart[0]} ${valleyStart[1]}`;
    const valleyEnd = at(base + step - tooth - gap, inner);
    d += `A${inner} ${inner} 0 0 0 ${valleyEnd[0]} ${valleyEnd[1]}`;
    const nextCrest = at(base + step - tooth, outer);
    d += `L${nextCrest[0]} ${nextCrest[1]}`;
  }
  return `${d}Z`;
}

const GEAR: IconElement = p(cog(8, 9.1, 6.9, 0.22, 0.12), "rotor");

export const Settings = icon("settings", [GEAR, c(12, 12, 2.9)]);
export const Settings2 = icon("settings-2", [
  p("M4.4 8h4"),
  p("M13.2 8h6.4"),
  p("M4.4 16h6.4"),
  p("M15.6 16h4"),
  c(10.8, 8, 2.6),
  c(13.2, 16, 2.6),
]);
export const SlidersHorizontal = icon("sliders-horizontal", [
  p("M4.4 7.4h3.2"),
  p("M12.4 7.4h7.2"),
  p("M4.4 16.6h7.2"),
  p("M16.4 16.6h3.2"),
  c(10, 7.4, 2.4),
  c(14, 16.6, 2.4),
]);

/* — Panels —————————————————————————————————————————————————————————— */

const SHELL = rect(3.4, 4.4, 17.2, 15.2, 3.2);
const RAIL_LEFT = p("M9.4 4.4v15.2");
const RAIL_RIGHT = p("M14.6 4.4v15.2");

export const PanelLeft = icon("panel-left", [SHELL, RAIL_LEFT]);
export const PanelLeftClose = icon("panel-left-close", [
  SHELL,
  RAIL_LEFT,
  p("M16 9.6 13.6 12l2.4 2.4", "arrow-left"),
]);
export const PanelLeftOpen = icon("panel-left-open", [
  SHELL,
  RAIL_LEFT,
  p("M13.6 9.6 16 12l-2.4 2.4", "arrow-right"),
]);
export const PanelRightClose = icon("panel-right-close", [
  SHELL,
  RAIL_RIGHT,
  p("M8 9.6 10.4 12 8 14.4", "arrow-right"),
]);
export const PanelRightOpen = icon("panel-right-open", [
  SHELL,
  RAIL_RIGHT,
  p("M10.4 9.6 8 12l2.4 2.4", "arrow-left"),
]);
export const SidebarOpen = PanelLeftOpen;
export const SidebarClose = PanelLeftClose;

/* — Devices ————————————————————————————————————————————————————————— */

export const Monitor = icon("monitor", [
  rect(2.8, 4, 18.4, 12.4, 3),
  p("M12 16.4v3.6"),
  p("M8 20h8"),
]);
export const MonitorUp = icon("monitor-up", [
  rect(2.8, 4, 18.4, 12.4, 3),
  p("M12 16.4v3.6"),
  p("M8 20h8"),
  p("M12 12.6V7.4"),
  p("M9.8 9.6 12 7.4l2.2 2.2", "arrow-up"),
]);
export const MonitorX = icon("monitor-x", [
  rect(2.8, 4, 18.4, 12.4, 3),
  p("M12 16.4v3.6"),
  p("M8 20h8"),
  p("M9.8 8 14.2 12.4"),
  p("M14.2 8 9.8 12.4"),
]);
export const Laptop = icon("laptop", [
  p("M4.8 16V7.2a2 2 0 0 1 2-2h10.4a2 2 0 0 1 2 2V16"),
  p("M2.6 16h18.8a1.4 1.4 0 0 1-1.4 2.8H4a1.4 1.4 0 0 1-1.4-2.8"),
]);
export const Smartphone = icon("smartphone", [rect(6.4, 2.8, 11.2, 18.4, 3), p("M10.4 18.2h3.2")]);
export const Tablet = icon("tablet", [rect(4.6, 2.8, 14.8, 18.4, 3), p("M10.4 18.2h3.2")]);
export const Cpu = icon("cpu", [
  rect(6.4, 6.4, 11.2, 11.2, 2.6),
  rect(10, 10, 4, 4, 1.2, "pulse"),
  p("M9.4 2.8v3.6"),
  p("M14.6 2.8v3.6"),
  p("M9.4 17.6v3.6"),
  p("M14.6 17.6v3.6"),
  p("M2.8 9.4h3.6"),
  p("M2.8 14.6h3.6"),
  p("M17.6 9.4h3.6"),
  p("M17.6 14.6h3.6"),
]);
export const Database = icon("database", [
  p("M20 6.2c0 1.54-3.58 2.8-8 2.8S4 7.74 4 6.2 7.58 3.4 12 3.4s8 1.26 8 2.8"),
  p("M4 6.2V12c0 1.54 3.58 2.8 8 2.8s8-1.26 8-2.8V6.2"),
  p("M4 12v5.8c0 1.54 3.58 2.8 8 2.8s8-1.26 8-2.8V12"),
]);
export const Plug = icon("plug", [
  p("M9 3.4v5"),
  p("M15 3.4v5"),
  p("M6.6 8.4h10.8v2.8a5.4 5.4 0 0 1-5.4 5.4 5.4 5.4 0 0 1-5.4-5.4z"),
  p("M12 16.6v4"),
]);
export const WifiOff = icon("wifi-off", [
  p("M2.8 9.4a15 15 0 0 1 4.6-2.7"),
  p("M11.2 5.6a15 15 0 0 1 10 3.8"),
  p("M6.2 13a10 10 0 0 1 2.6-1.7"),
  p("M14.6 11.6a10 10 0 0 1 3.2 1.4"),
  p("M9.6 16.6a5 5 0 0 1 4.8 0"),
  dot(12, 20, 1.2),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Workflow = icon("workflow", [
  rect(3.4, 3.4, 7, 6.2, 2),
  rect(13.6, 14.4, 7, 6.2, 2),
  p("M6.9 9.6v4.6a2 2 0 0 0 2 2h4.7"),
]);

/* — Code ———————————————————————————————————————————————————————————— */

export const Code2 = icon("code-2", [
  p("M15.8 7.6 20.2 12l-4.4 4.4"),
  p("M8.2 7.6 3.8 12l4.4 4.4"),
  p("M13.4 4.6 10.6 19.4"),
]);
export const Terminal = icon("terminal", [
  rect(3, 4.4, 18, 15.2, 3.2),
  p("M7.6 10 10.2 12.6 7.6 15.2", "arrow-right"),
  p("M12.6 15.4h4"),
]);

/* — Version control ————————————————————————————————————————————————— */

export const GitBranch = icon("git-branch", [
  p("M7 7.6v9.6"),
  c(7, 5.2, 2.4),
  c(7, 19, 2.4),
  c(17, 5.2, 2.4),
  p("M17 7.6v1.8a4.4 4.4 0 0 1-4.4 4.4H9.4"),
]);
export const GitFork = icon("git-fork", [
  c(7, 5.2, 2.4),
  c(17, 5.2, 2.4),
  c(12, 18.8, 2.4),
  p("M7 7.6v1.6a2.6 2.6 0 0 0 2.6 2.6h4.8A2.6 2.6 0 0 0 17 9.2V7.6"),
  p("M12 11.8v4.6"),
]);
export const GitPullRequest = icon("git-pull-request", [
  c(6.6, 6, 2.4),
  c(6.6, 18, 2.4),
  c(17.4, 18, 2.4),
  p("M6.6 8.4v7.2"),
  p("M17.4 15.6V9.8a3 3 0 0 0-3-3h-2.6"),
  p("M13.6 4.6 11.4 6.8l2.2 2.2"),
]);
export const GitPullRequestDraft = icon("git-pull-request-draft", [
  c(6.6, 6, 2.4),
  c(6.6, 18, 2.4),
  c(17.4, 18, 2.4),
  p("M6.6 8.4v7.2"),
  dashed("M17.4 15.6V6.4", "2.6 2.8"),
]);
export const GitCompare = icon("git-compare", [
  c(6.2, 17.8, 2.4),
  c(17.8, 6.2, 2.4),
  p("M8.6 17.8h5.2a2.6 2.6 0 0 0 2.6-2.6V8.6"),
  p("M15.4 17.8h4.2"),
  p("M4.4 6.2h4.2"),
  p("M6.6 4 4.4 6.2l2.2 2.2"),
]);
export const SquareDashedMousePointer = icon("square-dashed-mouse-pointer", [
  dashed("M4.4 9V7.4a3 3 0 0 1 3-3H9M15 4.4h1.6a3 3 0 0 1 3 3V9", "2.8 3"),
  dashed("M4.4 15v1.6a3 3 0 0 0 3 3H9", "2.8 3"),
  p("M12.6 11.2 20 14l-3.4.8-1.4 3.2z"),
]);
