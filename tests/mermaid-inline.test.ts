import test from "node:test";
import assert from "node:assert/strict";
import { buildInlineMermaidDoc, MERMAID_CLICK_MESSAGE, MERMAID_SIZE_MESSAGE, type MermaidTheme } from "@/components/canvas/sandbox-frame";

/*
 * The inline chat diagram (src/components/chat/mermaid-block.tsx). It used to
 * be a fixed-height frame with Mermaid's light default centred in it: in dark
 * mode, a tiny diagram in a big white box. These pin the fix at the document
 * level, where it lives.
 */

const dark: MermaidTheme = { dark: true, surface: "#1f1d1b", fill: "#2a2826", stroke: "#5d5a57", line: "#a19d99", text: "#ebe9e7", muted: "#a19d99" };
const light: MermaidTheme = { dark: false, surface: "#ffffff", fill: "#f6f5f4", stroke: "#c8c5c2", line: "#6d6964", text: "#1b1a19", muted: "#6d6964" };
const code = "flowchart LR\n  A[Prompt] --> B[Tokens] --> C[Next token]";

test("the diagram is drawn on the app's colours, transparent, in the page's colour scheme", () => {
  const d = buildInlineMermaidDoc(code, { theme: dark, minScale: 0.6, maxScale: 1.1 });
  assert.match(d, /color-scheme:dark/);
  assert.match(d, /html,body\{margin:0;background:transparent/);
  assert.ok(d.includes('"theme":"base"'));
  assert.ok(d.includes('"darkMode":true'));
  assert.ok(d.includes('"primaryTextColor":"#ebe9e7"'));
  assert.ok(!/background:#fff|bg-white/.test(d));
  const l = buildInlineMermaidDoc(code, { theme: light, minScale: 0.6, maxScale: 1.1 });
  assert.match(l, /color-scheme:light/);
  assert.ok(l.includes('"darkMode":false'));
});

test("it is fitted to the width between the scales, and reports its height instead of filling a fixed box", () => {
  const d = buildInlineMermaidDoc(code, { theme: dark, minScale: 0.6, maxScale: 1.1 });
  assert.ok(d.includes('"useMaxWidth":false'), "Mermaid's own shrink-to-container is off; the fit below decides");
  assert.ok(d.includes("Math.max(0.6, Math.min(1.1, avail / w))"));
  assert.ok(d.includes(MERMAID_SIZE_MESSAGE));
  assert.ok(d.includes(MERMAID_CLICK_MESSAGE), "a click asks the block to expand");
  assert.ok(!/min-height:100vh|place-items:center/.test(d), "no centred full-height canvas");
});

test("the source cannot close its script, and Mermaid runs in strict mode", () => {
  const d = buildInlineMermaidDoc("flowchart LR\nA-->B</script><script>alert(1)</script>", { theme: dark, minScale: 0.6, maxScale: 1.1 });
  assert.ok(!d.includes("B</script><script>alert(1)"));
  assert.ok(d.includes('"securityLevel":"strict"'));
});
