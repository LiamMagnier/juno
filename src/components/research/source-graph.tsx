"use client";

import * as React from "react";
import { hostOf } from "@/components/chat/source-chip";
import { cn, truncate } from "@/lib/utils";
import type { ResearchRunView, ResearchSourceView } from "@/components/research/use-research-run";

/**
 * What the run's evidence actually hangs off — objectives, the sources that
 * answer them, and how much each of those sources is worth.
 *
 * This is the third view of the same corpus, and it is the one that could not
 * be drawn until now. The timeline draws the query→source forest (what was
 * asked, and what came back), the panel above draws objective→source COUNTS
 * ("2/3 requirements met · 4 sources"), and neither can answer the question a
 * reader of a research report actually has: is this conclusion resting on one
 * forum post, or on four regulators? A count cannot say that, because a count
 * treats every source as one source.
 *
 * It was deliberately not built earlier: `run.ts` dropped the score columns on
 * the way out, so the only quantity a node could have been sized by was "we
 * happened to rank this one", and a graph whose geometry means nothing is worse
 * than no graph — it launders an arbitrary layout into a measurement. The run
 * view now carries `composite` and `sourceType` (see ResearchSourceView), which
 * are the two facts a node needs, so the graph is drawn from them and from
 * nothing else.
 *
 * THE THREE ENCODINGS, and why each is the one it is:
 *
 *  - AREA is `composite`, the weighted roll-up of authority / freshness /
 *    directness / independence. Nulls are NOT drawn small — they are drawn as a
 *    dashed empty ring at the floor radius, which reads as "no measurement"
 *    rather than "measured as poor". Sizing a null as 0 is exactly the fake
 *    graph this component exists not to be, and it is the common case while a
 *    run is still gathering across a legacy write path.
 *  - VERTICAL BAND is `sourceType`, ordered by provenance strength. It is
 *    position rather than hue on purpose: the app's semantic ramps mean
 *    success / warning / danger, and painting a user-generated source amber
 *    would say it is a PROBLEM when it is merely a weaker kind of witness. A
 *    band also carries its own word, so nothing here is colour-only.
 *  - FILL is `read`. A source the report cannot cite (found, never fetched) is
 *    a lead, not evidence, and the hollow ring is the same distinction
 *    `LiveSourceList` draws with its dot — one idea, drawn twice, deliberately.
 *
 * Every edge is one the run actually persists. `coverage[].supportingSourceIds`
 * is the only honest objective→source edge there is, and `conflicts[].sourceIds`
 * the only honest source→source one. `contradictingSourceIds` is not read here
 * for the reason the panel gives: the engine hardcodes it to `[]`, so the edge
 * would be empty when it was right and a lie the moment anything wrote it.
 *
 * Nothing here is a link or a control. The nodes are 3–12 units across, which
 * is not a touch target, and `LiveSourceList` directly under this panel is the
 * same corpus with real anchors and real titles — so this stays a picture and
 * the list stays the way you open a source.
 */

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Phrases composed with counts at runtime. Template literals are invisible to
 * scripts/generate-i18n-catalog.mjs, so the fixed halves live in a const whose
 * name ends in `COPY` — the same reason AUDIT_COPY and TIMELINE_COPY exist.
 */
export const GRAPH_COPY = {
  heading: "Evidence map",
  sources: "sources",
  oneSource: "source",
  links: "evidence links",
  oneLink: "evidence link",
  noLinks: "no objective rests on a source yet",
  notDrawn: "more sources not drawn",
  legendSize: "Circle area is the source's overall score",
  legendUnscored: "Dashed: never scored",
  legendRead: "Solid: read · Hollow: found, not read",
  legendConflict: "Amber: sources that conflict",
  unscored: "not scored",
  read: "read",
  notRead: "found, not read",
  scoreOf: "score",
} as const;

/**
 * The bands, strongest provenance first.
 *
 * The words are `SOURCE_TYPE_LABEL` in citation-audit.tsx said again rather than
 * imported, because that map is keyed for a sentence in an inspector ("Official
 * source") and this is a band header on a chart where the noun is already
 * implied by every circle under it. Importing it would have put "Official
 * source" and "Primary source" side by side as band names, which reads as two
 * unrelated categories rather than one ladder.
 *
 * `null` gets its own band at the bottom and is NOT merged into `unknown`.
 * `unknown` is the classifier having looked at the page and declined to place
 * it; null is nobody ever having looked. Merging them turns an absence of work
 * into a verdict about the source.
 */
const BANDS: ReadonlyArray<{ key: string; type: string | null; label: string }> = [
  { key: "official", type: "official", label: "Official" },
  { key: "primary", type: "primary", label: "Primary" },
  { key: "reputable_secondary", type: "reputable_secondary", label: "Established publication" },
  { key: "general", type: "general", label: "General web" },
  { key: "user_generated", type: "user_generated", label: "User-generated" },
  { key: "unknown", type: "unknown", label: "Unclassified" },
  { key: "unscored", type: null, label: "Never classified" },
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/*
 * One fixed coordinate space, scaled to whatever width the panel gives it.
 *
 * 720 is chosen to sit just under the panel's own content width so the common
 * case scales up by well under 1.2 — the band labels are drawn IN the SVG (they
 * have to be, they annotate rows of the picture) and every scale factor is a
 * scale factor on their type. A layout in CSS pixels with an absolutely
 * positioned edge overlay would keep the type exact, at the cost of two
 * coordinate systems that have to agree on every reflow; the edges are the part
 * that must not drift, so they own the coordinate system.
 */
const VB_W = 720;
const PAD_Y = 8;
const BAND_LABEL_H = 15;
const ROW_H = 30;
const NODE_PITCH = 30;
const R_MIN = 3.5;
const R_MAX = 12;
/** See the note on `objectiveX` — this and the column width are one decision. */
const OBJECTIVE_LABEL_MAX = 26;

/**
 * How many nodes are drawn before the rest are counted instead.
 *
 * A four-round run can gather well past a hundred sources, and a hundred
 * circles at this pitch is a texture, not a graph. The overflow is LABELLED
 * rather than silent, for the same reason `LiveSourceList` labels its own: a
 * picture that stops without saying so reads as the whole of the evidence.
 */
const MAX_NODES = 60;

/**
 * Score → radius, through a square root.
 *
 * Area is what the eye compares on a circle, so the score has to land on area
 * and not on radius. Mapping it to radius linearly — which was the first
 * drawing — made a 0.9 source look nine times the 0.3 one instead of three, and
 * the whole point of this view is that the comparison between two nodes is a
 * comparison a reader can trust.
 */
function radiusFor(composite: number): number {
  const clamped = Math.max(0, Math.min(1, composite));
  return R_MIN + (R_MAX - R_MIN) * Math.sqrt(clamped);
}

interface PlacedNode {
  source: ResearchSourceView;
  x: number;
  y: number;
  r: number;
  /** True when `composite` is null: drawn as absence, never as a small score. */
  unscored: boolean;
}

interface Band {
  label: string;
  y: number;
  nodes: PlacedNode[];
}

interface Layout {
  height: number;
  bands: Band[];
  objectiveX: number;
  objectives: Array<{ id: string; question: string; y: number; covered: boolean }>;
  byId: Map<string, PlacedNode>;
  hidden: number;
}

type Objectives = NonNullable<ResearchRunView["plan"]["objectives"]>;
type Coverage = NonNullable<ResearchRunView["plan"]["coverage"]>;
type Conflicts = NonNullable<ResearchRunView["plan"]["conflicts"]>;

/**
 * Places every node once, so the drawing below has no arithmetic in it.
 *
 * Deterministic on purpose — no force simulation, and not only because that
 * would be a dependency. This panel re-renders on a 2.5s poll while the run
 * gathers, and a relaxation layout re-seeds every time the node set changes:
 * the whole map would shuffle every few seconds under a reader trying to follow
 * one objective's edges. A fixed band-and-grid layout means a node moves only
 * when something about it actually changed.
 */
function layout(sources: ResearchSourceView[], objectives: Objectives, coverage: Coverage, conflicts: Conflicts): Layout {
  const hasObjectives = objectives.length > 0;
  // 164 is set by the LABEL, not by taste: `OBJECTIVE_LABEL_MAX` characters of
  // mixed-case text at the label's font size has to finish inside it. An SVG
  // <text> cannot ellipsis and does not wrap — it just runs out of the viewBox
  // and is clipped mid-word by the frame, which reads as a rendering bug rather
  // than as a truncation. The two numbers have to be chosen together.
  const objectiveX = hasObjectives ? 164 : 0;
  const nodeX0 = hasObjectives ? 208 : 22;
  const perRow = Math.max(1, Math.floor((VB_W - nodeX0 - 12) / NODE_PITCH));

  // Which sources an edge actually touches. These are the graph's subject, so
  // they survive the cap first; the remainder fills the rest of the budget in
  // arrival order, which is the one ordering that is not itself a judgement
  // about quality (ranking the overflow by score would hide exactly the weak
  // and unscored sources this view exists to expose).
  const linked = new Set<string>();
  for (const entry of coverage) for (const id of entry.supportingSourceIds) linked.add(id);
  for (const conflict of conflicts) for (const id of conflict.sourceIds) linked.add(id);

  const ordered = [...sources].sort((a, b) => {
    const edge = Number(linked.has(b.id)) - Number(linked.has(a.id));
    if (edge !== 0) return edge;
    return a.fetchedAt.localeCompare(b.fetchedAt);
  });
  const drawn = ordered.slice(0, MAX_NODES);
  const hidden = ordered.length - drawn.length;

  const bands: Band[] = [];
  const byId = new Map<string, PlacedNode>();
  let y = PAD_Y;
  for (const band of BANDS) {
    const members = drawn
      .filter((source) => source.sourceType === band.type)
      // Strongest first inside a band so the eye lands on the load-bearing
      // source, with the never-scored at the end — they have no place on a
      // score ordering and pretending otherwise is the null-as-zero bug again.
      .sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
    if (members.length === 0) continue;
    const rows = Math.ceil(members.length / perRow);
    const nodes = members.map((source, i) => {
      const node: PlacedNode = {
        source,
        x: nodeX0 + (i % perRow) * NODE_PITCH + NODE_PITCH / 2,
        y: y + BAND_LABEL_H + Math.floor(i / perRow) * ROW_H + ROW_H / 2,
        r: source.composite === null ? R_MIN : radiusFor(source.composite),
        unscored: source.composite === null,
      };
      byId.set(source.id, node);
      return node;
    });
    bands.push({ label: band.label, y, nodes });
    y += BAND_LABEL_H + rows * ROW_H;
  }

  const height = y + PAD_Y;
  // Objectives spread down the same span the bands occupy, so an edge is a
  // short travel to its band rather than a full-height sweep from a stack at
  // the top.
  const top = PAD_Y + 12;
  const span = Math.max(0, height - top - PAD_Y - 12);
  const placed = objectives.map((objective, i) => ({
    id: objective.id,
    question: objective.question,
    covered: objective.status === "covered",
    y: objectives.length === 1 ? top + span / 2 : top + (span * i) / (objectives.length - 1),
  }));

  return { height, bands, objectiveX, objectives: placed, byId, hidden };
}

/** `M … C …` from an objective to a source node, pulled flat at both ends so the fan reads as a fan. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const pull = Math.max(30, (x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}

/**
 * The bow between two conflicting sources.
 *
 * Bowed DOWNWARD rather than drawn straight: two sources in the same band sit
 * on one horizontal line, and a straight segment between them is
 * indistinguishable from the band's own baseline.
 */
function conflictPath(x1: number, y1: number, x2: number, y2: number): string {
  const drop = 14 + Math.abs(x2 - x1) * 0.12;
  return `M ${x1} ${y1} C ${x1} ${y1 + drop}, ${x2} ${y2 + drop}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export function SourceGraph({
  sources,
  objectives,
  coverage,
  conflicts,
  className,
}: {
  sources: ResearchSourceView[];
  objectives: Objectives;
  /** The run's coverage matrix — `supportingSourceIds` is every objective edge drawn. */
  coverage: Coverage;
  /** UNRESOLVED conflicts only. A resolved one is the matrix remembering it looked, not a live problem. */
  conflicts: Conflicts;
  className?: string;
}) {
  const model = React.useMemo(
    () => layout(sources, objectives, coverage, conflicts),
    [sources, objectives, coverage, conflicts]
  );

  const edges = React.useMemo(() => {
    // Deduped: the matrix carries one entry per REQUIREMENT, and three
    // requirements of one objective satisfied by the same source is three
    // records of one fact. Drawn as three overlapping curves it is also three
    // times the ink, which reads as a thicker — that is, stronger — edge.
    const seen = new Set<string>();
    const out: Array<{ key: string; d: string; covered: boolean }> = [];
    for (const objective of model.objectives) {
      for (const entry of coverage) {
        if (entry.objectiveId !== objective.id) continue;
        for (const sourceId of entry.supportingSourceIds) {
          const node = model.byId.get(sourceId);
          const key = `${objective.id}|${sourceId}`;
          if (!node || seen.has(key)) continue;
          seen.add(key);
          out.push({
            key,
            d: edgePath(model.objectiveX, objective.y, node.x, node.y),
            covered: objective.covered,
          });
        }
      }
    }
    return out;
  }, [model, coverage]);

  const conflictEdges = React.useMemo(() => {
    const out: Array<{ key: string; d: string }> = [];
    for (const conflict of conflicts) {
      // Chained rather than every pair: a three-source conflict drawn as three
      // bows says "three disagreements" when the run recorded one.
      const nodes = conflict.sourceIds.map((id) => model.byId.get(id)).filter((n): n is PlacedNode => !!n);
      for (let i = 1; i < nodes.length; i += 1) {
        const a = nodes[i - 1]!;
        const b = nodes[i]!;
        out.push({ key: `${conflict.id}:${i}`, d: conflictPath(a.x, a.y, b.x, b.y) });
      }
    }
    return out;
  }, [conflicts, model]);

  // Nothing gathered yet is not an empty graph, it is no graph. `LiveSourceList`
  // under this already says "No sources yet" in words, and an empty frame here
  // would read as a picture that failed to load.
  if (model.bands.length === 0) return null;

  const linkCount = edges.length;
  const summary = `${sources.length} ${sources.length === 1 ? GRAPH_COPY.oneSource : GRAPH_COPY.sources} · ${
    linkCount === 0
      ? GRAPH_COPY.noLinks
      : `${linkCount} ${linkCount === 1 ? GRAPH_COPY.oneLink : GRAPH_COPY.links}`
  }`;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-micro uppercase tracking-wider text-muted-foreground">{GRAPH_COPY.heading}</p>
        <p className="shrink-0 truncate font-mono text-micro tabular-nums text-muted-foreground">{summary}</p>
      </div>

      <svg
        viewBox={`0 0 ${VB_W} ${model.height}`}
        className="mt-1 w-full"
        role="img"
        // The picture is a second reading of the list below it, not the only
        // one — so it names what it shows and leaves the per-source detail to
        // `LiveSourceList`, which is real text with real links.
        aria-label={`${GRAPH_COPY.heading}: ${summary}`}
      >
        {/* Edges under nodes, so a node is never a hole punched in a curve. */}
        <g fill="none" strokeLinecap="round">
          {edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.d}
              // A covered objective's edges are the ones carrying the answer;
              // an open objective's are what it has so far and not enough of.
              className={cn("stroke-foreground", edge.covered ? "opacity-25" : "opacity-10")}
              strokeWidth={1}
            />
          ))}
          {conflictEdges.map((edge) => (
            <path
              key={edge.key}
              d={edge.d}
              className="stroke-warning opacity-70"
              strokeWidth={1.25}
              strokeDasharray="3 3"
            />
          ))}
        </g>

        {model.bands.map((band) => (
          <g key={band.label}>
            <text
              x={model.objectiveX > 0 ? model.objectiveX + 44 : 22}
              y={band.y + 10}
              className="fill-muted-foreground font-mono"
              fontSize={9.5}
              letterSpacing="0.06em"
            >
              {band.label.toUpperCase()}
            </text>
            {band.nodes.map((node) => (
              <g key={node.source.id}>
                <title>
                  {`${node.source.title || hostOf(node.source.url)} — ${hostOf(node.source.url)} · ${
                    node.unscored
                      ? GRAPH_COPY.unscored
                      : `${GRAPH_COPY.scoreOf} ${Math.round((node.source.composite ?? 0) * 100)}/100`
                  } · ${node.source.read ? GRAPH_COPY.read : GRAPH_COPY.notRead}`}
                </title>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.r}
                  className={cn(
                    "stroke-source",
                    // Hollow is "found, not read" — the same lead-versus-evidence
                    // distinction the source list draws with a dimmed logo.
                    node.source.read ? "fill-source/45" : "fill-transparent",
                    node.unscored && "opacity-60"
                  )}
                  strokeWidth={node.unscored ? 1 : 1.25}
                  // The dash IS the missing measurement. A never-scored source
                  // gets the floor radius and an empty dashed ring, so it can
                  // never be misread as a source that scored BADLY — which is
                  // exactly what a solid floor-radius circle says, and that is a
                  // real drawing here: a source that genuinely scored 0 lands on
                  // R_MIN too, and the dash is the only thing separating "we
                  // measured this at nothing" from "nobody measured it".
                  strokeDasharray={node.unscored ? "2 2" : undefined}
                />
              </g>
            ))}
          </g>
        ))}

        {model.objectives.map((objective) => (
          <g key={objective.id}>
            <title>{objective.question}</title>
            <text
              x={model.objectiveX - 10}
              y={objective.y + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={9.5}
            >
              {/* SVG text cannot ellipsis, so the cut is made in the string.
                  The full question is on the <title> above and in the
                  objectives list higher up the panel. */}
              {truncate(objective.question, OBJECTIVE_LABEL_MAX)}
            </text>
            <circle
              cx={model.objectiveX}
              cy={objective.y}
              r={3}
              className={objective.covered ? "fill-primary" : "fill-warning"}
            />
          </g>
        ))}
      </svg>

      {/* The legend is HTML, not SVG: it is prose about the picture rather than
          part of it, so it belongs on the type ladder and gets to wrap. */}
      <p className="mt-1 font-mono text-micro leading-relaxed text-muted-foreground">
        {GRAPH_COPY.legendSize} · {GRAPH_COPY.legendUnscored} · {GRAPH_COPY.legendRead}
        {conflictEdges.length > 0 ? ` · ${GRAPH_COPY.legendConflict}` : ""}
      </p>
      {model.hidden > 0 && (
        <p className="font-mono text-micro tabular-nums text-muted-foreground">
          + {model.hidden} {GRAPH_COPY.notDrawn}
        </p>
      )}
    </div>
  );
}
