// Builds the self-contained Alevr Code v2 design mocks into docs/code-v2/mocks/*.html.
// Run: node_modules/.bin/tsx docs/code-v2/mocks/src/build.mts
// Icons come from the product's own set (src/components/ui/juno-icons), lab
// marks from src/components/brand/provider-marks.ts, the Alevr mark from the
// Continuum geometry, fonts from src/app/fonts (embedded as data URIs).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { icon as I } from "./icons.mjs";
import { PROVIDER_MARKS } from "../../../../src/components/brand/provider-marks.ts";
import { continuumDrawing } from "../../../../src/components/brand/continuum-geometry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const out = join(here, "..");
const font = (f: string) => readFileSync(join(root, "src/app/fonts", f)).toString("base64");
const css = readFileSync(join(here, "base.css"), "utf8");
const fonts = `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${font("inter-latin-wght-normal.woff2")}) format("woff2");font-weight:400 600;font-display:block}
@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,${font("jetbrains-mono-latin-wght-normal.woff2")}) format("woff2");font-weight:400 600;font-display:block}`;

/* ── Marks ─────────────────────────────────────────────────────────────── */
function lab(p: string, size = 16) {
  const m = (PROVIDER_MARKS as Record<string, { scale: number; center: readonly [number, number]; paths: readonly string[] }>)[p];
  const [cx, cy] = m.center;
  const t = `translate(12 12) scale(${m.scale}) translate(${-cx} ${-cy})`;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><g transform="${t}">${m.paths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
}
function alevr(size = 16) {
  const d = continuumDrawing(size * 2);
  return `<svg class="ic" width="${size}" height="${size}" viewBox="${d.viewBox}" fill="currentColor" aria-hidden="true">${d.paths.map((p) => `<path d="${p.d}"/>`).join("")}</svg>`;
}
function ring(pct: number, size = 16, warn = false) {
  // The context gauge: a hairline dial with a solid wedge, so it can never be
  // mistaken for the spinner (an open arc that turns).
  const a = (Math.min(pct, 99.9) / 100) * 2 * Math.PI, r = 5.5;
  const x = 8 + r * Math.sin(a), y = 8 - r * Math.cos(a);
  const wedge = `M8 8 L8 ${8 - r} A${r} ${r} 0 ${pct > 50 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
  const ink = warn ? "hsl(var(--signal))" : "hsl(var(--muted-fg))";
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.25" fill="none" stroke="hsl(var(--muted-fg) / 0.55)" stroke-width="1"/><path d="${wedge}" fill="${ink}"/></svg>`;
}
const chev = I("chevron-down", 12);

/* ── Shell parts ──────────────────────────────────────────────────────── */
function sidebar(sel: string, extra = "") {
  const row = (ic: string, label: string, opts: { sel?: boolean; tail?: string; sub?: boolean } = {}) =>
    `<div class="nav${opts.sel ? " sel" : ""}${opts.sub ? " sub" : ""}">${ic ? I(ic, 16) : ""}<span class="trunc">${label}</span>${opts.tail ? `<span class="tail">${opts.tail}</span>` : ""}</div>`;
  const t = (label: string, tail = "") => row("", label, { sub: true, sel: sel === label, tail });
  return `<aside class="side">
  <div class="side-top"><span style="color:hsl(var(--fg))">${alevr(18)}</span><div class="switch" style="margin-left:auto"><span>${I("chat", 14)}Chat</span><span class="on">${I("code", 14)}Code</span></div></div>
  ${row("new-chat", "New session", { tail: "<kbd>⌘N</kbd>" })}
  ${row("search", "Search", { tail: "<kbd>⌘K</kbd>" })}
  ${row("pull-request", "Pull requests")}
  ${row("plug", "Connections", {})}
  <div class="side-h">Needs you</div>
  ${row("", `Cart total regression suite`, { sub: true, tail: `<span class="sig">${I("needs-you", 14)}</span>` }).replace('class="nav sub"', 'class="nav" style="padding-left:16px"')}
  <div class="side-h">Projects</div>
  ${row("folder-open", "storefront")}
  ${t("Move checkout totals to the server", I("loading", 14))}
  ${t("Lazy-load product images")}
  ${t("Fix the stale cart total")}
  ${row("folder", "docs-site")}
  ${t("Document the webhooks API")}
  ${extra}
  <div class="side-foot"><span class="avatar">MO</span><span>Maya Okafor</span><span class="mute" style="margin-left:auto">${I("settings", 16)}</span></div>
</aside>`;
}
function topbar(title: string, where: string, on: string[] = []) {
  const b = (ic: string, label: string, k: string) => `<span class="iconbtn${on.includes(ic) ? " on" : ""}" title="${label} ${k}">${I(ic, 16)}</span>`;
  return `<header class="top">
  <span class="iconbtn only-narrow">${I("chevron-left", 18)}</span>
  <span class="title trunc">${title}</span><span class="where mono trunc">${where}</span>
  <span style="margin-left:auto" class="row gap4">
    <span class="wide row gap4">${b("terminal", "Terminal", "⌘J")}${b("diff", "Changes", "⌘D")}${b("file-tree", "Files", "⌘P")}${b("browser", "Preview", "⌘⇧J")}${b("agents", "Agents", "⌘⇧G")}</span>
    <span class="iconbtn only-narrow">${I("diff", 18)}</span>
    <span class="iconbtn">${I("more", 16)}</span>
  </span>
</header>`;
}
type Foot = { mode?: string; orch?: string; model?: string; modelMark?: string; traits?: string; ringPct?: number; stop?: boolean; open?: string; draft?: string; ph?: string; state?: "" | "working" | "needs" };
function composer(f: Foot = {}) {
  const o = (k: string) => (f.open === k ? " open" : "");
  return `<div class="composer ${f.state ?? ""}">
  <div class="draft${f.draft ? "" : " ph"}">${f.draft ?? f.ph ?? "Ask for a change, @ to mention a file, / for commands"}</div>
  <div class="cfoot">
    <span class="ctl">${I("plus", 16)}</span>
    <span class="ctl${o("mode")}">${I("permission", 15)}<span class="v">${f.mode ?? "Auto-edit"}</span>${chev}</span>
    <span class="ctl wide${o("orch")}">${I("workflow", 15)}<span class="v">${f.orch ?? "Solo"}</span>${chev}</span>
    <span style="flex:1"></span>
    <span class="ctl${o("model")}">${f.modelMark ?? lab("anthropic", 14)}<span class="v">${f.model ?? "Opus 5.5"}</span></span>
    <span class="ctl wide${o("traits")}" style="padding-left:2px"><span>${f.traits ?? "High · 1M"}</span>${chev}</span>
    <span class="ring" title="Context">${ring(f.ringPct ?? 18)}</span>
    <span class="send${f.stop ? " stop" : ""}">${f.stop ? `<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>` : I("arrow-up", 16)}</span>
  </div>
</div>`;
}
function page(name: string, title: string, body: string) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- Alevr Code v2 design mock (static). Source: docs/code-v2/mocks/src/build.mts. Light and dark follow prefers-color-scheme; narrow layout below 761px. -->
<style>${fonts}
${css}</style></head>
<body>${body}</body></html>`;
  writeFileSync(join(out, `${name}.html`), html);
  console.log("wrote", name);
}

/* ── Shared thread content ────────────────────────────────────────────── */
const historyTurn = `
<div class="you">Move the checkout total to the server. Today the cart computes it in the browser and drifts from what Stripe charges. Add tests.</div>
<div class="turnhead">${I("chevron-right", 14)}<span>Worked for 4m 12s</span><span class="rule"></span></div>
<div class="prose">The browser total and the charged total come from two different sums: <code>selectCartTotal</code> applies the coupon before tax, the payment intent applies it after. I moved the sum into <code>/api/cart/total</code> and the cart now reads it from there.</div>`;

const steps = `
<div class="steps">
  <div class="step">${I("reasoning", 16)}<span>Thought for 14s</span></div>
  <div class="step">${I("document", 16)}<span class="verb">Read</span><span class="mono trunc">src/cart/selectors.ts</span><span>and 5 more</span></div>
  <div class="step">${I("text-search", 16)}<span class="verb">Searched</span><span class="mono">cartTotal</span><span>11 results</span></div>
  <div class="step">${I("edit", 16)}<span class="verb">Edited</span><span class="mono trunc">src/server/cart/total.ts</span><span class="add tnum">+84</span><span class="del tnum">−6</span></div>
</div>`;

/* ── 1. Workspace (thread + right dock) ───────────────────────────────── */
const workspaceThread = `
<div class="scroll"><div class="col">
${historyTurn}
<div class="receipt">
  <div class="rh">${I("diff", 16)}<span class="m">Changed 3 files</span><span class="add tnum">+118</span><span class="del tnum">−24</span><span style="flex:1"></span><span class="btn ghost">${I("undo", 14)}Undo</span><span class="btn">Review</span></div>
  <div class="rf"><span class="mono trunc grow">src/server/cart/<span style="color:hsl(var(--fg))">total.ts</span></span><span class="add tnum">+84</span><span class="del tnum">−6</span></div>
  <div class="rf"><span class="mono trunc grow">src/cart/<span style="color:hsl(var(--fg))">useCartTotal.ts</span></span><span class="add tnum">+22</span><span class="del tnum">−18</span></div>
  <div class="rf"><span class="mono trunc grow">src/server/cart/<span style="color:hsl(var(--fg))">total.server.test.ts</span></span><span class="add tnum">+12</span><span class="del tnum">−0</span></div>
</div>
<div class="you">Run the cart suite before you call it done.</div>
<div class="steps">
  <div class="step">${I("reasoning", 16)}<span>Thought for 6s</span><span class="t">6s</span></div>
  <div class="step">${I("terminal", 16)}<span class="verb">Ran</span><span class="mono">pnpm typecheck</span><span class="t">18s</span></div>
  <div class="step" style="color:hsl(var(--fg))">${I("loading", 16)}<span class="shimmer">Running</span><span class="mono shimmer">pnpm test --filter cart</span><span class="t mute">0:41</span></div>
</div>
<div class="term" style="padding:6px 0 0 28px; color:hsl(var(--muted-fg))">
  ✓ cart/total.server.test.ts <span class="faint">(9)</span><br>✓ cart/useCartTotal.test.tsx <span class="faint">(6)</span><br><span style="color:hsl(var(--fg))">… cart/checkout.e2e.test.ts</span>
</div>
</div></div>
<div class="cwrap"><div class="col">
  <div class="queue">
    <div class="q">${I("corner-down-right", 14)}<span class="txt trunc grow">Also update the README section on how totals are computed</span><span class="btn ghost" style="height:24px">${I("edit", 13)}</span><span class="btn" style="height:24px">Steer now <kbd>⌘↵</kbd></span></div>
  </div>
  ${composer({ state: "working", stop: true, orch: "Lead + 3", ph: "Queue a follow-up, or ⌘↵ to steer", ringPct: 31 })}
</div></div>`;

const dockChanges = `
<aside class="dock">
  <div class="tabs"><span class="tab on">${I("diff", 14)}Changes <span class="mute tnum">3</span></span><span class="tab">${I("terminal", 14)}Terminal</span><span class="tab">${I("file-tree", 14)}Files</span><span class="tab">${I("browser", 14)}Preview</span><span style="flex:1"></span><span class="iconbtn">${I("expand", 14)}</span></div>
  <div class="dockbar"><span class="seg"><span class="on">This turn</span><span>Whole thread</span></span><span style="flex:1"></span><span class="add tnum">+118</span><span class="del tnum">−24</span><span class="btn ink">Commit…</span></div>
  <div class="dockscroll">
    <div class="fileh">${I("chevron-down", 14)}<span class="mono" style="color:hsl(var(--fg))">total.ts</span><span class="mono mute trunc grow">src/server/cart/</span><span class="add tnum">+84</span><span class="del tnum">−6</span></div>
    <div class="diff">
      <div class="hunk"><span class="mono">@@ −1,9 +1,24 @@</span><span style="flex:1"></span><span class="btn ghost">Reject</span><span class="btn">Accept</span></div>
      <div class="ln"><span>1</span><span></span><span><span class="k">import</span> { applyCoupon } <span class="k">from</span> <span class="s">"./pricing"</span>;</span></div>
      <div class="ln a"><span>2</span><span>+</span><span><span class="k">import</span> { taxFor } <span class="k">from</span> <span class="s">"./tax"</span>;</span></div>
      <div class="ln"><span>3</span><span></span><span></span></div>
      <div class="ln d"><span>4</span><span>−</span><span><span class="k">export function</span> total(items, coupon) {</span></div>
      <div class="ln a"><span>4</span><span>+</span><span><span class="k">export function</span> total(items: Item[], coupon?: Coupon) {</span></div>
      <div class="ln a"><span>5</span><span>+</span><span>  <span class="c">// Same order as the payment intent: tax first, then coupon.</span></span></div>
      <div class="ln"><span>6</span><span></span><span>  <span class="k">const</span> subtotal = items.reduce((s, i) =&gt; s + i.price * i.qty, <span class="n">0</span>);</span></div>
      <div class="ln a"><span>7</span><span>+</span><span>  <span class="k">const</span> taxed = subtotal + taxFor(subtotal);</span></div>
      <div class="ln d"><span>7</span><span>−</span><span>  <span class="k">return</span> applyCoupon(subtotal, coupon) + taxFor(subtotal);</span></div>
      <div class="ln a"><span>8</span><span>+</span><span>  <span class="k">return</span> coupon ? applyCoupon(taxed, coupon) : taxed;</span></div>
      <div class="ln"><span>9</span><span></span><span>}</span></div>
    </div>
    <div class="fileh">${I("chevron-down", 14)}<span class="mono" style="color:hsl(var(--fg))">useCartTotal.ts</span><span class="mono mute trunc grow">src/cart/</span><span class="add tnum">+22</span><span class="del tnum">−18</span></div>
    <div class="diff">
      <div class="hunk"><span class="mono">@@ −12,14 +12,18 @@</span><span style="flex:1"></span><span class="mute">Accepted</span></div>
      <div class="ln d"><span>12</span><span>−</span><span>  <span class="k">const</span> total = useSelector(selectCartTotal);</span></div>
      <div class="ln a"><span>12</span><span>+</span><span>  <span class="k">const</span> { data: total } = useQuery(cartTotalQuery(cartId));</span></div>
      <div class="ln"><span>13</span><span></span><span>  <span class="k">return</span> total ?? <span class="k">null</span>;</span></div>
    </div>
    <div class="fileh">${I("chevron-right", 14)}<span class="mono" style="color:hsl(var(--fg))">total.server.test.ts</span><span class="mono mute trunc grow">src/server/cart/</span><span class="add tnum">+12</span><span class="del tnum">−0</span></div>
  </div>
</aside>`;

page("workspace", "Alevr Code: workspace", `<div class="app">${sidebar("Move checkout totals to the server")}
<main class="main">${topbar("Move checkout totals to the server", "storefront · alevr/server-totals", ["diff"])}
<div class="body"><section class="thread">${workspaceThread}</section>${dockChanges}</div></main></div>`);

/* ── Picker pages share a quiet thread and an open popover ───────────── */
const quietThread = (foot: Foot) => `
<div class="scroll"><div class="col">
${historyTurn}
${steps}
<div class="prose">All 15 cart tests pass. The checkout e2e test now asserts the server total matches the payment intent to the cent.</div>
</div></div>
<div class="cwrap"><div class="col">${composer(foot)}</div></div>`;

function pickerPage(name: string, title: string, foot: Foot, pop: string) {
  page(name, title, `<div class="app">${sidebar("Move checkout totals to the server")}
<main class="main">${topbar("Move checkout totals to the server", "storefront · alevr/server-totals")}
<div class="body nodock"><section class="thread">${quietThread(foot)}<div class="scrim sheetable"></div>${pop}</section></div></main></div>`);
}

/* ── 2. Model picker ──────────────────────────────────────────────────── */
const modelRow = (mark: string, name: string, sub: string, meta: string, on = false, hl = false) =>
  `<div class="opt${hl ? " hl" : ""}"><span class="ck">${on ? I("check", 16) : ""}</span><span style="color:hsl(var(--fg))">${mark}</span><span class="grow"><div class="${on ? "m" : ""}">${name}</div><div class="sub trunc">${sub}</div></span><span class="meta">${meta}</span></div>`;
const modelPop = `
<div class="pop sheetable" style="right:calc(50% - 360px); bottom:136px; width:620px; display:flex; flex-direction:column">
  <div class="row" style="align-items:stretch; min-height:0">
    <div class="rail hide-narrow">
      <span class="ri" title="Alevr">${alevr(18)}</span>
      <span class="ri on" title="Claude (your subscription)">${lab("anthropic", 18)}</span>
      <span class="ri" title="ChatGPT (Codex)">${lab("openai", 18)}</span>
      <span class="ri" title="Gemini CLI">${lab("google", 18)}</span>
      <span class="ri" title="DeepSeek Harness">${lab("deepseek", 18)}</span>
      <span class="sep"></span>
      <span class="ri" title="Your API keys">${I("key", 17)}</span>
      <span class="ri" title="Connect a subscription">${I("plus", 17)}</span>
    </div>
    <div class="grow" style="display:flex; flex-direction:column">
      <div class="search">${I("search", 16)}<span class="grow">Search models</span><kbd>⌘⇧↑↓ provider</kbd></div>
      <div class="only-narrow" style="display:flex; gap:6px; padding:10px 12px 2px; overflow:hidden">
        <span class="seg"><span>${alevr(14)}</span><span class="on">${lab("anthropic", 14)}&nbsp;Claude</span><span>${lab("openai", 14)}</span><span>${lab("google", 14)}</span><span>${I("key", 14)}</span></span>
      </div>
      <div style="padding:12px 16px 6px">
        <div class="row gap8"><span class="m">Claude (your subscription)</span></div>
        <div class="mute" style="margin-top:2px">Runs your own <span class="mono">claude</span> on this Mac. Max plan, 5-hour window 38% used, resets 16:40.</div>
      </div>
      <div class="sect">Best for coding</div>
      ${modelRow(lab("anthropic", 16), "Claude Opus 5.5", "Long-running agentic coding. Always thinks.", "1M", true, true)}
      ${modelRow(lab("anthropic", 16), "Claude Sonnet 5.5", "Near-Opus quality, lighter on plan limits.", "1M")}
      ${modelRow(lab("anthropic", 16), "Claude Fable 5.1", "Deepest reasoning. Uses limits fastest.", "1M")}
      ${modelRow(lab("anthropic", 16), "Claude Haiku 4.5", "Fast subagents and quick edits.", "200K")}
      <div style="height:6px"></div>
    </div>
  </div>
  <div class="popfoot">
    <span>Effort</span><span class="seg"><span>Low</span><span>Medium</span><span class="on">High</span><span>Max</span></span>
    <span style="flex:1"></span>
    <span class="hide-narrow">Context</span><span class="ctl" style="height:28px; box-shadow:inset 0 0 0 1px hsl(var(--border))"><span class="v">1M</span>${chev}</span>
  </div>
</div>`;
pickerPage("composer-model-picker", "Alevr Code: model picker", { open: "model", traits: "High · 1M" }, modelPop);

/* ── 3. Context tier selector ─────────────────────────────────────────── */
const tierRow = (name: string, win: string, price: string, delta: string, est: string, on = false, hl = false) => `
<div class="opt${hl ? " hl" : ""}" style="align-items:flex-start; padding:10px">
  <span class="ck" style="margin-top:2px">${on ? I("check", 16) : ""}</span>
  <span class="grow"><div class="row gap8"><span class="${on ? "m" : ""}">${name}</span><span class="mute tnum">${win}</span></div><div class="sub" style="margin-top:2px">${price}</div><div class="sub">${delta}</div></span>
  <span class="meta" style="text-align:right"><div style="color:hsl(var(--fg))" class="tnum">${est}</div><div class="sub">next turn</div></span>
</div>`;
const tierPop = `
<div class="pop sheetable" style="right:calc(50% - 300px); bottom:136px; width:440px">
  <div style="padding:14px 16px 4px"><div class="row gap8">${lab("openai", 16)}<span class="m">Context window</span><span class="mute">GPT-6.1 Sol on Alevr</span></div></div>
  <div class="ruler">
    <span class="track"></span><span class="used" style="width:17.5%"></span>
    <span class="now">This thread · 184K</span>
    <span class="tick" style="left:12.2%"></span><span class="tl" style="left:12.2%">128K</span>
    <span class="tick" style="left:25.9%"></span><span class="tl" style="left:25.9%">272K</span>
    <span class="tick" style="left:99.6%"></span><span class="tl" style="left:96%">1.05M</span>
  </div>
  <div style="height:6px"></div>
  ${tierRow("Standard", "272K", "$2.00 in · $10.00 out per million tokens", "Compacts at 217K.", "≈ $0.37", true, false)}
  ${tierRow("Long", "1.05M", "Same rates up to 272K, then $4.00 in · $15.00 out", "2× input and 1.5× output past 272K.", "≈ $0.37", false, true)}
  ${tierRow("Lean", "128K", "$2.00 in · $10.00 out", "Compacts now to about 100K, then every 102K.", "≈ $0.20")}
  <div class="popfoot" style="font-size:12px; line-height:16px"><span>Cached input is $0.10 per million: a turn that hits the cache costs about $0.02. Estimates use this thread's size.</span></div>
</div>`;
pickerPage("context-tier", "Alevr Code: context window", { open: "traits", model: "GPT-6.1 Sol", modelMark: lab("openai", 14), traits: "Medium · 272K", ringPct: 68 }, tierPop);

/* ── 4. Orchestrate (role picker) ─────────────────────────────────────── */
const roleRow = (role: string, what: string, mark: string, model: string, via: string, extra = "", hl = false) => `
<div class="opt${hl ? " hl" : ""}" style="padding:8px 10px">
  <span class="grow" style="min-width:0"><div>${role}</div><div class="sub trunc">${what}</div></span>
  ${extra}
  <span class="ctl" style="height:32px; box-shadow:inset 0 0 0 1px hsl(var(--border)); min-width:196px; justify-content:flex-start"><span style="color:hsl(var(--fg))">${mark}</span><span class="grow" style="text-align:left"><div class="v" style="line-height:15px">${model}</div><div style="font-size:11px; line-height:13px">${via}</div></span>${chev}</span>
</div>`;
const stepper = `<span class="row gap4 mute hide-narrow" style="margin-right:8px"><span class="iconbtn" style="width:24px;height:24px">${I("minus", 12)}</span><span class="tnum" style="color:hsl(var(--fg)); width:12px; text-align:center">3</span><span class="iconbtn" style="width:24px;height:24px">${I("plus", 12)}</span></span>`;
const orchPop = `
<div class="pop sheetable" style="left:calc(50% - 360px); bottom:136px; width:600px">
  <div style="padding:14px 16px 10px" class="row gap12 pophead"><span class="m">Orchestrate</span><span style="flex:1"></span><span class="seg"><span>Solo</span><span class="on">Lead + workers</span><span>Best of N</span></span></div>
  <div style="padding:0 16px 8px" class="mute">The lead plans and delegates. Workers run in parallel, each on its own branch of the plan. The reviewer reads every diff before you do.</div>
  ${roleRow("Lead", "Plans, delegates, writes the summary", lab("anthropic", 16), "Claude Opus 5.5 · High", "Your subscription")}
  ${roleRow("Workers", "Up to 3 at once", lab("openai", 16), "GPT-6.1 Sol · Medium", "ChatGPT (Codex)", stepper, true)}
  ${roleRow("Reviewer", "Reads each diff, can send it back once", lab("anthropic", 16), "Claude Sonnet 5.5 · Medium", "Your subscription")}
  ${roleRow("Explorer", "Searches the repo and the web, read-only", lab("deepseek", 16), "DeepSeek V4.1 Flash", "Alevr · $0.15 / $0.60")}
  <div class="opt" style="padding:6px 10px"><span class="mute grow">Titles and compaction</span><span class="mute">GPT-6 Luna on Alevr</span>${I("chevron-right", 14)}</div>
  <div class="popfoot">
    <span>Stop at</span><span class="ctl" style="height:28px; box-shadow:inset 0 0 0 1px hsl(var(--border))"><span class="v tnum">$4.00</span></span><span class="hide-narrow">of Alevr spend per run</span>
    <span style="flex:1"></span><span class="tnum" style="color:hsl(var(--fg))">≈ $0.90 a run</span>
  </div>
  <div style="padding:0 14px 12px; font-size:12px; line-height:16px" class="mute">Subscription roles count against your Claude and ChatGPT plans, not this budget.</div>
</div>`;
pickerPage("orchestrate", "Alevr Code: orchestrate", { open: "orch", orch: "Lead + 3" }, orchPop);

/* ── 5. Connections ───────────────────────────────────────────────────── */
const meter = (label: string, p: number, tail: string) => `<span class="meter">${label}<i style="--p:${p}%"></i><span class="tnum">${p}%</span><span>${tail}</span></span>`;
const conn = (mark: string, name: string, desc: string, action: string, more = "") =>
  `<div class="li"><span class="mark lg">${mark}</span><div style="min-width:0"><div class="nm">${name}</div><div class="ds">${desc}</div>${more}</div><div class="row gap8">${action}</div></div>`;
const settingsNav = `<nav class="hide-narrow" style="width:200px; flex:none; padding:40px 0 0 24px; display:flex; flex-direction:column; gap:2px">
  ${["General", "Models", "Connections", "Permissions", "Keyboard", "MCP servers", "Environments"].map((n) => `<div class="nav${n === "Connections" ? " sel" : ""}" style="font-size:13.5px">${n}</div>`).join("")}
</nav>`;
const connectionsBody = `
<div class="row" style="align-items:stretch; height:100%; min-height:0">${settingsNav}
<div class="page grow"><div class="inner">
  <div class="h1">Connections</div>
  <div class="lede">Use the plans you already pay for. Alevr starts each vendor's own agent on your Mac, so your sign-in, billing and limits stay with the vendor.</div>
  <div class="row gap8 mute" style="margin-top:14px">${I("laptop", 16)}<span>On the web, these run through <span style="color:hsl(var(--fg))">Maya's MacBook Pro</span>, linked 2 minutes ago.</span></div>

  <div class="group"><div class="gh">Subscriptions</div><div class="list">
    ${conn(lab("anthropic", 18), "Claude (your subscription)", "Your own <span class='mono'>claude</span> CLI, version 3.4.1. Signed in as maya@okafor.studio, Max plan.", `<span class="btn">Manage</span>`, `<div class="ds2">${meter("5-hour", 38, "resets 16:40")}${meter("Weekly", 12, "resets Mon")}</div>`)}
    ${conn(lab("openai", 18), "ChatGPT (Codex)", `<span class="sig row gap6" style="display:inline-flex">${I("needs-you", 14)}Sign-in expired.</span> Codex app-server 0.61, Pro plan.`, `<span class="btn">${I("terminal", 14)}Sign in again</span>`)}
    ${conn(lab("google", 18), "Gemini CLI", "Signed in with a Gemini API key. Personal Google accounts can't be used here.", `<span class="btn">Manage</span>`)}
    ${conn(lab("xai", 18), "Grok", "Installed, not signed in.", `<span class="btn">${I("terminal", 14)}Sign in</span>`)}
    ${conn(lab("deepseek", 18), "DeepSeek Harness", "Not installed. Alevr opens a terminal with the install command so you can read it first.", `<span class="btn">Install</span>`)}
  </div></div>

  <div class="group"><div class="gh">Your API keys<span class="faint" style="font-weight:400">Used by the Alevr engine and never billed by Alevr</span></div><div class="list">
    ${conn(lab("anthropic", 18), "Anthropic", "<span class='mono'>sk-ant-…4f2a</span>, added Sep 30. Last used today.", `<span class="btn ghost">Remove</span>`)}
    ${conn(lab("openai", 18), "OpenAI", "No key.", `<span class="btn">Add key</span>`)}
  </div></div>

  <div class="group"><div class="gh">Alevr</div><div class="list">
    ${conn(alevr(18), "Alevr models", "Every model in the catalogue on your Plus plan.", `<span class="btn ghost">Usage</span>`, `<div class="ds2">${meter("This month", 31, "$12.40 of $40")}</div>`)}
  </div></div>
</div></div></div>`;
page("connections", "Alevr Code: connections", `<div class="app">${sidebar("Connections")}
<main class="main"><header class="top"><span class="iconbtn only-narrow">${I("chevron-left", 18)}</span><span class="title">Settings</span></header>
<div style="min-height:0; overflow:hidden">${connectionsBody}</div></main></div>`);

/* ── 6. Multi-agent view ──────────────────────────────────────────────── */
const kid = (glyph: string, role: string, mark: string, model: string, task: string, line: string, right: string, sel = false) => `
<div class="kid${sel ? " sel" : ""}"><span class="g">${glyph}</span><div class="b"><div class="row gap8"><span class="m name trunc">${task}</span></div><div class="row gap6 kidline" style="margin-top:1px"><span>${role}</span><span class="faint">·</span><span style="color:hsl(var(--fg))">${mark}</span><span class="trunc">${model}</span></div><div class="kidline trunc" style="margin-top:2px">${line}</div></div><span class="r">${right}</span></div>`;
const agentThread = `
<div class="scroll"><div class="col">
<div class="you">Move checkout totals to the server and add tests. Split the call sites across workers.</div>
<div class="steps"><div class="step">${I("reasoning", 16)}<span>Thought for 9s</span></div><div class="step">${I("plan", 16)}<span class="verb">Planned</span><span>3 tasks, one per call site</span></div></div>
<div class="prose">Three workers, one per call site. Explorer already mapped them; I'll merge their branches and have the reviewer read each diff.</div>
<div class="tree">
  <div class="head">${I("agents", 16)}<span class="m">3 workers</span><span class="mute">and an explorer</span><span style="flex:1"></span><span class="mute tnum treemeta">2m 41s · $0.64 of $4.00</span></div>
  ${kid(`<span class="add">${I("check", 16)}</span>`, "Worker 1", lab("openai", 12), "GPT-6.1 Sol", "Server route for the total", "Added <span class='mono'>/api/cart/total</span> with tax before coupon. <span class='add'>+84</span> <span class='del'>−6</span>", "1m 52s")}
  ${kid(I("loading", 16), "Worker 2", lab("openai", 12), "GPT-6.1 Sol", "Client reads the server total", "<span class='shimmer'>Editing</span> <span class='mono shimmer'>src/cart/useCartTotal.ts</span>", "2m 41s", true)}
  ${kid(`<span class="sig">${I("needs-you", 16)}</span>`, "Worker 3", lab("openai", 12), "GPT-6.1 Sol", "Cart total regression suite", "<span class='sig'>Waiting for you:</span> wants to run a command", "2m 03s")}
  ${kid(`<span class="mute">${I("check", 16)}</span>`, "Explorer", lab("deepseek", 12), "DeepSeek V4.1 Flash", "Map every caller of selectCartTotal", "Found 3 call sites and 2 tests. Closed.", "38s")}
</div>
</div></div>
<div class="cwrap"><div class="col">
<div class="composer needs" style="padding:16px 16px 12px 18px">
  <div class="row gap10"><span class="sig">${I("needs-you", 18)}</span><span class="m">Worker 3 wants to run a command</span><span style="flex:1"></span><span class="mute hide-narrow">1 of 1</span></div>
  <div class="mono" style="margin:10px 0 6px; padding:9px 12px; border-radius:10px; background:hsl(var(--muted)); box-shadow:inset 0 0 0 1px hsl(var(--hairline)); font-size:12.5px">pnpm test --filter cart -- --runInBand</div>
  <div class="mute">To run the new regression suite against the server route. It reads files and writes nothing outside <span class="mono">coverage/</span>.</div>
  <div class="row gap8 approve-actions" style="margin-top:12px"><span class="btn ghost lg">Deny <kbd>Esc</kbd></span><span style="flex:1"></span><span class="btn lg">Allow for this session <kbd>⌘⇧↵</kbd></span><span class="btn ink lg">Allow once <kbd style="background:hsl(var(--on-primary)/0.16); color:hsl(var(--on-primary))">↵</kbd></span></div>
</div>
</div></div>`;
const agentDock = `
<aside class="dock">
  <div class="tabs"><span class="tab">${I("diff", 14)}Changes <span class="mute tnum">4</span></span><span class="tab">${I("terminal", 14)}Terminal</span><span class="tab on">${I("agents", 14)}Agents <span class="mute tnum">4</span></span><span style="flex:1"></span><span class="iconbtn">${I("expand", 14)}</span></div>
  <div class="dockbar"><span style="color:hsl(var(--fg))">${lab("openai", 16)}</span><span class="m">Worker 2</span><span class="mute trunc grow">GPT-6.1 Sol · ChatGPT (Codex)</span><span class="btn ghost">Stop</span></div>
  <div class="dockscroll" style="padding:14px 16px; display:flex; flex-direction:column; gap:10px">
    <div class="mute" style="font-size:12px">Task from the lead</div>
    <div style="font-size:13.5px; line-height:21px">Replace the client-side total in <span class="mono">useCartTotal</span> with a query to <span class="mono">/api/cart/total</span>. Keep the optimistic coupon state. Don't touch the server route.</div>
    <div class="steps" style="margin-top:4px">
      <div class="step">${I("document", 16)}<span class="verb">Read</span><span class="mono trunc">src/cart/useCartTotal.ts</span></div>
      <div class="step">${I("document", 16)}<span class="verb">Read</span><span class="mono trunc">src/server/cart/total.ts</span><span>from Worker 1</span></div>
      <div class="step" style="color:hsl(var(--fg))">${I("loading", 16)}<span class="shimmer">Editing</span><span class="mono shimmer trunc">useCartTotal.ts</span><span class="t mute">0:12</span></div>
    </div>
    <div class="diff" style="margin:0">
      <div class="ln d"><span>12</span><span>−</span><span>  <span class="k">const</span> total = useSelector(selectCartTotal);</span></div>
      <div class="ln a"><span>12</span><span>+</span><span>  <span class="k">const</span> { data: total } = useQuery(</span></div>
      <div class="ln a"><span>13</span><span>+</span><span>    cartTotalQuery(cartId)</span></div>
    </div>
    <div style="flex:1"></div>
  </div>
  <div style="padding:10px 12px 12px; border-top:1px solid hsl(var(--border))"><div class="row gap8" style="height:36px; padding:0 6px 0 12px; border-radius:12px; box-shadow:inset 0 0 0 1px hsl(var(--border)); background:hsl(var(--card))"><span class="faint grow">Message Worker 2</span><span class="send" style="width:26px;height:26px">${I("arrow-up", 14)}</span></div></div>
</aside>`;
page("multi-agent", "Alevr Code: agents", `<div class="app">${sidebar("Move checkout totals to the server")}
<main class="main">${topbar("Move checkout totals to the server", "storefront · alevr/server-totals", ["agents"])}
<div class="body"><section class="thread">${agentThread}</section>${agentDock}</div></main></div>`);
