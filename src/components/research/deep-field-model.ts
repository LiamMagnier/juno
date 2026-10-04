/**
 * Deep Field's map, as data. The homepage drew the idea with six invented
 * sources; this places the run's REAL sources on the same three orbits:
 *
 *   outer orbit   found      a search returned it, nothing read it yet
 *   middle orbit  read       a researcher opened and read the page
 *   inner orbit   cited      the report cites it, with its number
 *
 * Distance from the question is how far a source got into the evidence, so a
 * source moving inward is the run making progress, and nothing on the map is
 * decoration: every point is a row in `run.sources`. The one presence line is
 * drawn to the source being read right now, when the server says which.
 *
 * Pure and deterministic: a source keeps its angle across polls (it is hashed
 * from the id, not from its position in the list), so a poll never shuffles
 * the map. Positions are fractions of the map's box.
 */

export type FieldSourceState = "found" | "read" | "cited";

export interface FieldSourceInput {
  id: string;
  url: string;
  title: string;
  read: boolean;
  citedIndex?: number | null;
}

export interface FieldNode {
  id: string;
  url: string;
  host: string;
  title: string;
  state: FieldSourceState;
  ring: number;
  deg: number;
  x: number;
  y: number;
  /** Shown with its host beside it (read and cited sources, newest first, and the current one). */
  label: boolean;
  /** Which side of the point the label sits on, away from the centre. */
  side: "start" | "end";
  /** Where the label's centre sits vertically, nudged apart from its neighbours. */
  labelY: number;
  cited: number | null;
  current: boolean;
}

export interface FieldModel {
  nodes: FieldNode[];
  /** Found sources not drawn because the map is full. */
  hidden: number;
  current: FieldNode | null;
}

/** The three orbits, as fractions of the map (the homepage's proportions). */
export const FIELD_CENTRE = { x: 0.5, y: 0.5 } as const;
export const FIELD_RINGS = [0.2, 0.33, 0.46].map((r, k) => ({ cx: FIELD_CENTRE.x, cy: FIELD_CENTRE.y, rx: r, ry: r * 0.94, faint: k === 2 }));

const RING_OF: Record<FieldSourceState, number> = { cited: 0, read: 1, found: 2 };
const MAX_NODES = 30;
const MAX_LABELS = 6;
/** Labels on one side keep at least this far apart, as a fraction of the map's height. */
const LABEL_GAP = 0.085;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** FNV-1a: a stable angle per source id. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sourceState(source: Pick<FieldSourceInput, "read" | "citedIndex">): FieldSourceState {
  if (typeof source.citedIndex === "number" && source.citedIndex > 0) return "cited";
  return source.read ? "read" : "found";
}

/** Spreads one orbit's points so no two sit closer than the orbit can afford. */
function spread(angles: number[]): number[] {
  const n = angles.length;
  if (n < 2) return angles;
  const gap = Math.min(34, 360 / n);
  const out = [...angles];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) if (out[i] - out[i - 1] < gap) out[i] = out[i - 1] + gap;
    // The last point wraps round to meet the first.
    const over = out[n - 1] - (out[0] + 360 - gap);
    if (over > 0) for (let i = 0; i < n; i++) out[i] -= over * ((i + 1) / n);
  }
  return out.map((deg) => ((deg % 360) + 360) % 360);
}

function separate(nodes: FieldNode[]): void {
  for (const side of ["start", "end"] as const) {
    const group = nodes.filter((node) => node.label && node.side === side).sort((a, b) => a.labelY - b.labelY);
    for (let i = 1; i < group.length; i++) {
      if (group[i].labelY - group[i - 1].labelY < LABEL_GAP) group[i].labelY = group[i - 1].labelY + LABEL_GAP;
    }
    // Pushed off the bottom: walk the column back up from the edge.
    for (let i = group.length - 1; i >= 0; i--) {
      const ceiling = i === group.length - 1 ? 0.96 : group[i + 1].labelY - LABEL_GAP;
      if (group[i].labelY > ceiling) group[i].labelY = ceiling;
    }
  }
}

/**
 * Places the run's sources. `currentHost` is the domain the server says is
 * being read (`phaseDetail.domain`), or the host of the newest page opened.
 */
export function deepField(
  sources: readonly FieldSourceInput[],
  opts: { currentHost?: string | null; maxNodes?: number; maxLabels?: number } = {},
): FieldModel {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const maxLabels = opts.maxLabels ?? MAX_LABELS;
  const currentHost = opts.currentHost?.replace(/^www\./, "") || null;

  // Everything read or cited is drawn; found sources fill what room is left,
  // the newest first (the list is in discovery order).
  const indexed = sources.map((source, order) => ({ source, order, state: sourceState(source) }));
  const evidence = indexed.filter((entry) => entry.state !== "found");
  const found = indexed.filter((entry) => entry.state === "found");
  const room = Math.max(0, maxNodes - evidence.length);
  const shownFound = room > 0 ? found.slice(-room) : [];
  const shown = [...evidence, ...shownFound].sort((a, b) => a.order - b.order);

  // The current source: the newest drawn source on the host being read.
  const currentId = currentHost
    ? [...shown].reverse().find((entry) => hostOf(entry.source.url) === currentHost)?.source.id ?? null
    : null;
  // Labels: the current source, the cited ones in citation order, then the newest reads.
  const labelled = new Set<string>();
  if (currentId) labelled.add(currentId);
  for (const entry of [...shown]
    .filter((e) => e.state === "cited")
    .sort((a, b) => (a.source.citedIndex ?? 0) - (b.source.citedIndex ?? 0))) {
    if (labelled.size >= maxLabels) break;
    labelled.add(entry.source.id);
  }
  for (const entry of [...shown].filter((e) => e.state === "read").reverse()) {
    if (labelled.size >= maxLabels) break;
    labelled.add(entry.source.id);
  }

  const nodes: FieldNode[] = [];
  for (const ring of [0, 1, 2]) {
    const members = shown
      .filter((entry) => RING_OF[entry.state] === ring)
      .map((entry) => ({ entry, base: hash(entry.source.id) % 360 }))
      .sort((a, b) => a.base - b.base || a.entry.source.id.localeCompare(b.entry.source.id));
    const angles = spread(members.map((m) => m.base));
    const spec = FIELD_RINGS[ring];
    members.forEach(({ entry }, i) => {
      const deg = angles[i];
      const t = (deg * Math.PI) / 180;
      const x = spec.cx + spec.rx * Math.cos(t);
      const y = spec.cy + spec.ry * Math.sin(t);
      nodes.push({
        id: entry.source.id,
        url: entry.source.url,
        host: hostOf(entry.source.url),
        title: entry.source.title,
        state: entry.state,
        ring,
        deg,
        x,
        y,
        label: labelled.has(entry.source.id),
        // Away from the centre, except at the map's edges, where a label
        // would run out of the map: there it turns inward over the field.
        side: x > 0.84 ? "start" : x < 0.16 ? "end" : x >= spec.cx ? "end" : "start",
        labelY: y,
        cited: entry.state === "cited" ? entry.source.citedIndex ?? null : null,
        current: entry.source.id === currentId,
      });
    });
  }
  separate(nodes);
  // Discovery order, whatever the orbit: a point changing orbit must not move
  // in the DOM, or the browser replays its arrival as if it were new.
  const discovery = new Map(shown.map((entry) => [entry.source.id, entry.order]));
  nodes.sort((a, b) => (discovery.get(a.id) ?? 0) - (discovery.get(b.id) ?? 0));
  return { nodes, hidden: found.length - shownFound.length, current: nodes.find((node) => node.current) ?? null };
}
