/**
 * The proposal board for one direction, built as plain DOM so the same code
 * runs in the dev page and in a standalone bundle for screenshots.
 */
import { CHARACTERS, Studio, type Direction, type EyeState } from "./orbit-render";

const TITLE: Record<Direction, [string, string]> = {
  A: ["Direction A · Simple 3D", "Soft matte vinyl, crisp simple volumes, soft studio light, graphic eyes. Calm and premium."],
  B: ["Direction B · Funny 3D", "Velvet flock, chunkier proportions, bigger eyes and accessories. More personality."],
};

const CSS = `
.oa{font:14px/1.4 "Inter",-apple-system,system-ui,sans-serif;color:#16151b;background:#f4f3f0;padding:36px 40px 44px;width:1240px;box-sizing:border-box}
.oa h1{font:500 34px/1.1 "Iowan Old Style","Georgia",serif;margin:0 0 6px;letter-spacing:-.01em}
.oa .lede{color:#5d5a66;margin:0 0 26px;max-width:760px}
.oa h2{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6a6774;margin:26px 0 12px}
.oa .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px 8px}
.oa figure{margin:0;display:flex;flex-direction:column;align-items:center}
.oa figure img{width:160px;height:160px}
.oa figcaption{font-size:13px;text-align:center;margin-top:-4px}
.oa figcaption span{display:block;color:#7a7784;font-size:12px}
.oa .row{display:flex;gap:28px;align-items:flex-end}
.oa .small img{width:48px;height:48px}
.oa .strip{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:#fff;border-radius:14px;padding:10px 14px}
.oa .panes{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.oa .pane{border-radius:16px;padding:14px;background:#fff;border:1px solid #e7e4dd}
.oa .pane.dark{background:#1b1a1f;border-color:#2a2930;color:#ecebef}
.oa .li{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px}
.oa .li.sel{background:#f0eee9}.oa .dark .li.sel{background:#26252b}
.oa .li .nm{font-weight:500}.oa .li .st{color:#76737f;margin-left:auto;font-size:12.5px}
.oa .dark .li .st{color:#9a98a3}
.oa .li .st.need{color:#b5530f;font-weight:500}.oa .dark .li .st.need{color:#f2a15c}
.oa .tree .li{padding:4px 8px;font-size:13px}.oa .tree .li.d1{padding-left:30px}.oa .tree .li.d2{padding-left:52px}
.oa .note{color:#7a7784;font-size:12px;margin-top:8px}
`;

function img(src: string, px: number, alt = ""): HTMLImageElement {
  const i = document.createElement("img");
  i.src = src;
  i.width = px;
  i.height = px;
  i.alt = alt;
  i.style.width = `${px}px`;
  i.style.height = `${px}px`;
  return i;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function mountGallery(root: HTMLElement, dir: Direction): void {
  const studio = new Studio();
  const style = el("style");
  style.textContent = CSS;
  const board = el("div", "oa");
  board.append(style, el("h1", "", TITLE[dir][0]), el("p", "lede", TITLE[dir][1] + " Twelve original Alevr Orbit agents: six simple forms (Mira is the hero) and six exclusive forms from Alevr's own geometry — the Orbit ellipse, a black hole, a ringed planet, a crescent moon, a comet, a pulsar star. No mouths, no blush: the eyes carry the state."));

  const section = (title: string, kind: "simple" | "cosmic") => {
    board.append(el("h2", "", title));
    const grid = el("div", "grid");
    for (const c of CHARACTERS.filter((x) => x.kind === kind)) {
      const f = el("figure");
      f.append(img(studio.render(c, dir, "ready", 160), 160, c.name));
      const cap = el("figcaption", "", c.name);
      cap.append(el("span", "", c.role));
      f.append(cap);
      grid.append(f);
    }
    board.append(grid);
  };
  section("Simple forms · 160 px", "simple");
  section("Exclusive · Alevr geometry · 160 px", "cosmic");

  board.append(el("h2", "", "The same twelve at 48 px"));
  const strip = el("div", "strip small");
  for (const c of CHARACTERS) strip.append(img(studio.render(c, dir, "ready", 48), 48, c.name));
  board.append(strip);

  board.append(el("h2", "", "Mira · four core states (words always beside the face)"));
  const mira = CHARACTERS[0]!;
  const states: [EyeState, string][] = [
    ["ready", "Ready"],
    ["working", "Working"],
    ["waiting", "Needs your answer"],
    ["finished", "Finished"],
  ];
  const srow = el("div", "row");
  for (const [s, label] of states) {
    const f = el("figure");
    f.append(img(studio.render(mira, dir, s, 160), 160, `Mira, ${label}`), el("figcaption", "", label));
    srow.append(f);
  }
  const extra = el("div", "row small");
  extra.style.marginLeft = "18px";
  for (const [s, label] of [["thinking", "Thinking"], ["paused", "Paused"]] as [EyeState, string][]) {
    const f = el("figure");
    f.append(img(studio.render(mira, dir, s, 48), 48, `Mira, ${label}`), el("figcaption", "", label));
    extra.append(f);
  }
  srow.append(extra);
  board.append(srow);

  board.append(el("h2", "", "In the product · pre-rendered sprites at 28 px and 20 px"));
  const panes = el("div", "panes");
  const list = (dark: boolean) => {
    const pane = el("div", dark ? "pane dark" : "pane");
    const rows: [string, EyeState, string, boolean][] = [
      ["mira", "waiting", "Needs your answer", true],
      ["otto", "working", "Reconciling March invoices", false],
      ["orbit", "thinking", "Thinking", false],
      ["luna", "paused", "Paused until 9:00", false],
      ["rhea", "finished", "Finished · 3 replies drafted", false],
    ];
    rows.forEach(([id, s, words, need], i) => {
      const c = CHARACTERS.find((x) => x.id === id)!;
      const li = el("div", i === 0 ? "li sel" : "li");
      li.append(img(studio.render(c, dir, s, 28), 28), el("span", "nm", c.name), el("span", need ? "st need" : "st", words));
      pane.append(li);
    });
    pane.append(el("div", "note", "Agent list · 28 px"));
    const tree = el("div", "tree");
    tree.style.marginTop = "10px";
    const trow: [string, EyeState, string, string, number][] = [
      ["orbit", "thinking", "Lead", "Planning the change", 0],
      ["bram", "working", "Builder 1", "Editing src/cart/total.ts", 1],
      ["pip", "working", "Builder 2", "Running pnpm test", 1],
      ["dew", "paused", "Explorer", "Paused", 2],
      ["pulsar", "waiting", "Verifier", "Needs you", 1],
      ["saturn", "finished", "Reviewer", "Done", 1],
    ];
    for (const [id, s, name, words, d] of trow) {
      const c = CHARACTERS.find((x) => x.id === id)!;
      const li = el("div", `li d${d}`);
      li.append(img(studio.render(c, dir, s, 20), 20), el("span", "nm", name), el("span", s === "waiting" ? "st need" : "st", words));
      tree.append(li);
    }
    pane.append(tree, el("div", "note", "Code agents tree · 20 px"));
    return pane;
  };
  panes.append(list(false), list(true));
  board.append(panes);
  root.append(board);
  root.setAttribute("data-ready", "");
}
