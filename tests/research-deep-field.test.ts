import test from "node:test";
import assert from "node:assert/strict";
import { FIELD_RINGS, deepField, sourceState } from "@/components/research/deep-field-model";
import { readingHost } from "@/components/research/workspace-model";
import type { ResearchEventDTO } from "@/lib/research/domain";

const src = (id: string, read = false, citedIndex: number | null = null, host = `${id}.example`) => ({
  id, url: `https://www.${host}/${id}`, title: `Title ${id}`, read, citedIndex,
});
const event = (seq: number, kind: ResearchEventDTO["kind"], payload: Record<string, unknown>): ResearchEventDTO => ({
  id: `${seq}`, seq, kind, payload, createdAt: "2026-10-04T10:00:00Z",
});

test("a source's orbit is how far it got: found outside, read in the middle, cited inside", () => {
  assert.equal(sourceState({ read: false }), "found");
  assert.equal(sourceState({ read: true }), "read");
  assert.equal(sourceState({ read: true, citedIndex: 2 }), "cited");
  // A zero or missing index is not a citation.
  assert.equal(sourceState({ read: true, citedIndex: 0 }), "read");
  const { nodes } = deepField([src("a"), src("b", true), src("c", true, 1)]);
  assert.deepEqual(Object.fromEntries(nodes.map((n) => [n.id, n.ring])), { a: 2, b: 1, c: 0 });
  assert.equal(nodes.find((n) => n.id === "c")!.cited, 1);
  for (const node of nodes) {
    const ring = FIELD_RINGS[node.ring];
    const dx = (node.x - ring.cx) / ring.rx;
    const dy = (node.y - ring.cy) / ring.ry;
    assert.ok(Math.abs(dx * dx + dy * dy - 1) < 1e-9, "every point sits on its orbit");
  }
});

test("positions are stable across polls: list order and new arrivals elsewhere never move a point", () => {
  const sources = [src("a", true), src("b", true), src("c"), src("d")];
  const first = deepField(sources);
  const reordered = deepField([...sources].reverse());
  const angle = (model: typeof first, id: string) => model.nodes.find((n) => n.id === id)!.deg;
  for (const id of ["a", "b", "c", "d"]) assert.equal(angle(first, id), angle(reordered, id));
  // A new source on a different orbit leaves this orbit alone.
  const grown = deepField([...sources, src("e", true, 1)]);
  assert.equal(angle(grown, "c"), angle(first, "c"));
  assert.equal(angle(grown, "d"), angle(first, "d"));
});

test("points on one orbit keep apart", () => {
  const many = Array.from({ length: 8 }, (_, i) => src(`s${i}`, true));
  const angles = deepField(many).nodes.map((n) => n.deg).sort((a, b) => a - b);
  const gaps = angles.map((a, i) => (i ? a - angles[i - 1] : a + 360 - angles[angles.length - 1]));
  assert.ok(Math.min(...gaps) > 20, `minimum gap ${Math.min(...gaps)}`);
});

test("the presence line goes only to a drawn source on the host being read", () => {
  const sources = [src("a", true, null, "nature.com"), src("b", true, null, "iea.org"), src("c", false, null, "nature.com")];
  const model = deepField(sources, { currentHost: "www.nature.com" });
  // The newest source on that host.
  assert.equal(model.current?.id, "c");
  assert.equal(model.nodes.filter((n) => n.current).length, 1);
  assert.equal(deepField(sources, { currentHost: "elsewhere.org" }).current, null);
  assert.equal(deepField(sources).current, null);
});

test("a full map keeps every read and cited source and says how many found ones it left out", () => {
  const sources = [...Array.from({ length: 6 }, (_, i) => src(`r${i}`, true)), ...Array.from({ length: 30 }, (_, i) => src(`f${i}`))];
  const model = deepField(sources, { maxNodes: 12 });
  assert.equal(model.nodes.filter((n) => n.state === "read").length, 6);
  assert.equal(model.nodes.filter((n) => n.state === "found").length, 6);
  assert.equal(model.hidden, 24);
  // The newest found sources are the ones drawn.
  assert.ok(model.nodes.some((n) => n.id === "f29"));
  assert.ok(!model.nodes.some((n) => n.id === "f0"));
});

test("labels: the current source, cited ones in citation order, then the newest reads, at most six", () => {
  const sources = [
    ...Array.from({ length: 8 }, (_, i) => src(`r${i}`, true)),
    src("c2", true, 2), src("c1", true, 1), src("f", false, null, "live.org"),
  ];
  const model = deepField(sources, { currentHost: "live.org" });
  const labelled = model.nodes.filter((n) => n.label).map((n) => n.id).sort();
  assert.deepEqual(labelled, ["c1", "c2", "f", "r5", "r6", "r7"].sort());
  // Labels on one side are pushed apart, never stacked.
  for (const side of ["start", "end"] as const) {
    const ys = model.nodes.filter((n) => n.label && n.side === side).map((n) => n.labelY).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 0.084, `${side} labels collide`);
  }
});

test("the reading host is the server's domain while it reads, else the newest page opened while investigating", () => {
  const opened = [event(1, "worker_tool_call", { tool: "open_page", arg: "https://www.sintef.no/x" })];
  assert.equal(readingHost({ state: "investigating", phase: "reading", phaseDetail: { domain: "www.iea.org" } }, opened), "iea.org");
  assert.equal(readingHost({ state: "investigating", phase: "searching", phaseDetail: { query: "q" } }, opened), "sintef.no");
  // A failed open is not a page being read.
  assert.equal(readingHost({ state: "investigating", phase: "searching" }, [event(1, "worker_tool_call", { tool: "open_page", arg: "https://a.org", ok: false })]), null);
  // A later stage change ends the reading: no stale presence line while writing or paused.
  assert.equal(readingHost({ state: "synthesizing", phase: "writing" }, opened), null);
  assert.equal(readingHost({ state: "paused", phase: "paused", phaseDetail: { domain: "iea.org" } }, opened), null);
  assert.equal(readingHost({ state: "investigating", phase: "searching" }, [...opened, event(2, "state_changed", { state: "investigating" })]), null);
});

test("points keep discovery order whatever their orbit, so a promotion never re-inserts a point", () => {
  const before = deepField([src("a"), src("b"), src("c", true)]).nodes.map((n) => n.id);
  const after = deepField([src("a", true, 1), src("b", true), src("c", true), src("d")]).nodes.map((n) => n.id);
  assert.deepEqual(before, ["a", "b", "c"]);
  assert.deepEqual(after, ["a", "b", "c", "d"]);
});
