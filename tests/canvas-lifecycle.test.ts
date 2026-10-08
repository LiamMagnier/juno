import test from "node:test";
import assert from "node:assert/strict";
import { applyBackingStore, backingStore, watchCanvas, type CanvasEnv, type CanvasSize } from "../src/lib/canvas/canvas-lifecycle";

class FakeQuery extends EventTarget {
  constructor(readonly media: string, public matches = true) { super(); }
}

function fakeEnv() {
  const win = Object.assign(new EventTarget(), { devicePixelRatio: 2 });
  const fonts = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, fonts });
  const queries: FakeQuery[] = [];
  let resizeCb: (() => void) | null = null;
  let ioCb: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  const disconnected = { ro: 0, io: 0 };
  const env: CanvasEnv = {
    window: win,
    document: doc,
    matchMedia: (q) => {
      const mq = new FakeQuery(q);
      queries.push(mq);
      return mq;
    },
    ResizeObserver: class {
      constructor(cb: (entries: unknown[]) => void) { resizeCb = () => cb([]); }
      observe() {}
      disconnect() { disconnected.ro++; }
    },
    IntersectionObserver: class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { ioCb = cb; }
      observe() {}
      disconnect() { disconnected.io++; }
    },
  };
  return {
    env, win, doc, fonts, queries, disconnected,
    resize: () => resizeCb?.(),
    intersect: (on: boolean) => ioCb?.([{ isIntersecting: on }]),
  };
}

function setup(box = { w: 120, h: 40 }) {
  const f = fakeEnv();
  const canvas = new EventTarget();
  const log: string[] = [];
  const sizes: CanvasSize[] = [];
  const stop = watchCanvas({} as Element, canvas, {
    resize: (s) => { sizes.push(s); log.push(`resize ${s.width}x${s.height}`); },
    redraw: (r) => log.push(`redraw ${r}`),
    visible: (on) => log.push(`visible ${on}`),
    hidden: () => log.push("hidden"),
  }, { env: f.env, measure: () => box });
  return { ...f, canvas, log, sizes, stop, box };
}

test("backingStore: device px, capped DPR, null for a box with no area", () => {
  assert.deepEqual(backingStore(100, 50, 3, 2), { w: 100, h: 50, dpr: 2, width: 200, height: 100 });
  assert.equal(backingStore(0, 50, 2), null);
  assert.equal(backingStore(100, 0, 2), null);
  assert.equal(backingStore(Number.NaN, 10, 2), null);
  assert.equal(backingStore(10, 10, 0)?.dpr, 1, "a nonsense DPR draws at 1");
  assert.deepEqual(backingStore(0.3, 0.3, 1)?.width, 1, "never a 0px bitmap");
});

test("applyBackingStore only touches the canvas (and clears it) when the size really changed", () => {
  const c = { width: 300, height: 150 };
  assert.equal(applyBackingStore(c, backingStore(150, 75, 2)!), false);
  assert.equal(applyBackingStore(c, backingStore(150, 76, 2)!), true);
  assert.deepEqual(c, { width: 300, height: 152 });
});

test("measures once at start, and only reports real changes", () => {
  const s = setup();
  assert.deepEqual(s.log, ["resize 240x80"]);
  s.resize();
  assert.deepEqual(s.log, ["resize 240x80"], "same size, no work");
  s.box.w = 160;
  s.resize();
  assert.equal(s.log.at(-1), "resize 320x80");
});

test("a box that collapses to 0x0 keeps its bitmap and is redrawn when it comes back, even at the same size", () => {
  const s = setup({ w: 0, h: 0 });
  assert.deepEqual(s.log, ["hidden"], "a canvas measured while hidden reports nothing to size");
  s.box.w = 120; s.box.h = 40;
  s.resize();
  assert.equal(s.log.at(-1), "resize 240x80", "sized as soon as it has a box");
  s.box.w = 0;
  s.resize();
  s.resize();
  assert.deepEqual(s.log.slice(-1), ["hidden"], "hidden reported once");
  s.box.w = 120;
  s.resize();
  assert.equal(s.log.at(-1), "resize 240x80", "same size as before, redrawn anyway");
});

test("a DPR change (another display, page zoom) resizes without any box change, and the query is re-armed", () => {
  const s = setup();
  assert.equal(s.queries[0].media, "(resolution: 2dppx)");
  s.win.devicePixelRatio = 1;
  s.queries[0].dispatchEvent(new Event("change"));
  assert.equal(s.log.at(-1), "resize 120x40");
  assert.equal(s.queries.at(-1)!.media, "(resolution: 1dppx)");
  // The old query is no longer listened to.
  const before = s.log.length;
  s.queries[0].dispatchEvent(new Event("change"));
  assert.equal(s.log.length, before);
});

test("a restored context, a bfcache restore, a shown tab and late fonts each ask for a redraw", () => {
  const s = setup();
  s.canvas.dispatchEvent(new Event("contextrestored"));
  s.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
  s.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  s.doc.hidden = true;
  s.doc.dispatchEvent(new Event("visibilitychange"));
  s.doc.hidden = false;
  s.doc.dispatchEvent(new Event("visibilitychange"));
  s.fonts.dispatchEvent(new Event("loadingdone"));
  assert.deepEqual(s.log.slice(1), ["redraw context-restored", "redraw page-show", "redraw visible", "redraw fonts"]);
});

test("contextlost is left uncancelled so the browser restores the context", () => {
  const s = setup();
  const lost = new Event("contextlost", { cancelable: true });
  s.canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, false);
});

test("intersection reports visibility and re-measures on entry", () => {
  const s = setup();
  s.intersect(false);
  s.box.w = 60;
  s.intersect(true);
  assert.deepEqual(s.log.slice(1), ["visible false", "visible true", "resize 120x80"]);
});

test("dispose removes every listener and observer", () => {
  const s = setup();
  s.stop();
  s.canvas.dispatchEvent(new Event("contextrestored"));
  s.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  s.queries[0].dispatchEvent(new Event("change"));
  s.intersect(true);
  s.resize();
  assert.deepEqual(s.log, ["resize 240x80"]);
  assert.deepEqual(s.disconnected, { ro: 1, io: 1 });
});
