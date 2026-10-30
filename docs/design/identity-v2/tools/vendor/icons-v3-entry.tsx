// "Before" renderer for ICONS §4: renders the product's own V3 drawings with its own renderer.
// Build: npx esbuild docs/design/identity-v2/tools/vendor/icons-v3-entry.tsx --bundle --platform=node --outfile=/tmp/icons-v3.cjs
// Run:   node /tmp/icons-v3.cjs '{"search":"search"}'  (prints SVG markup per size)
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../../../../../src/components/ui/juno-icons/index";
const MAP: Record<string, string> = JSON.parse(process.argv[2]);
const sizes = [16, 20, 24];
const out: Record<string, Record<number, string>> = {};
for (const [mine, theirs] of Object.entries(MAP)) {
  out[mine] = {};
  for (const s of sizes) {
    try { out[mine][s] = renderToStaticMarkup(React.createElement(Icon as any, { name: theirs, size: s, px: 2 })); }
    catch (e) { out[mine][s] = `<!-- ${String(e)} -->`; }
  }
}
process.stdout.write(JSON.stringify(out));
