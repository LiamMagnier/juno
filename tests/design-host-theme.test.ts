import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { appearanceTables, parseBlocks, resolveColor } from "../scripts/generate-design-tokens";
import { projectHostChrome, projectHostTheme } from "../scripts/build-design-editor.mjs";

const globals = readFileSync("src/app/globals.css", "utf8");
const built = readFileSync("native/macOS/JunoDesktop/Resources/DesignEditor/editor.css", "utf8");
const canonical = appearanceTables(parseBlocks(globals));

function builtAppearance(dark: boolean, highContrast: boolean) {
  const values = new Map<string, string>();
  postcss.parse(built).walkRules((rule) => {
    if (rule.selector !== ":root") return;
    for (let ancestor: postcss.Node | undefined = rule.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type !== "atrule") continue;
      const parent = ancestor as postcss.AtRule;
      if (parent.name === "layer") continue;
      if (parent.name !== "media") return;
      const condition = parent.params.replace(/\s/g, "");
      if (condition.includes("prefers-reduced-motion")) return;
      if (condition.includes("prefers-color-scheme:dark") && !dark) return;
      if (condition.includes("prefers-contrast:more") && !highContrast) return;
    }
    for (const node of rule.nodes) {
      if (node.type === "decl" && node.prop.startsWith("--")) values.set(node.prop.slice(2), node.value);
    }
  });
  return values;
}

test("the shipped native editor resolves shared colors and fields in all four appearances", () => {
  const roles = [
    "background", "foreground", "primary", "primary-foreground", "presence",
    "card", "muted", "muted-foreground", "popover", "border", "ring",
    "field-surface", "field-surface-active", "field-border", "field-hover", "field-focus", "field-ring",
  ];
  for (const [appearance, dark, contrast] of [
    ["light", false, false], ["dark", true, false],
    ["hcLight", false, true], ["hcDark", true, true],
  ] as const) {
    const actual = builtAppearance(dark, contrast);
    for (const role of roles) {
      assert.ok(actual.has(role), appearance + " declares " + role);
      assert.deepEqual(resolveColor(actual, role), resolveColor(canonical[appearance], role), appearance + " " + role);
    }
  }
});

test("the shipped native editor includes shared field, button, menu and tooltip rules", () => {
  const rules = new Map<string, string>();
  postcss.parse(built).walkRules((rule) => {
    for (const selector of rule.selectors) rules.set(selector, (rules.get(selector) ?? "") + rule.toString());
  });
  assert.match(rules.get(".bg-field") ?? "", /background-color:hsl\(var\(--field-surface\)\)/);
  assert.match(rules.get(".border-field-border") ?? "", /border-color:hsl\(var\(--field-border\)\)/);
  for (const selector of [".control-primary", ".surface-float", ".overlay-glass", ".ui-tooltip"]) {
    assert.match(rules.get(selector) ?? "", /background-color:/, selector + " has its material");
  }
  assert.match(built, /\.coarse\\:min-h-11/, "shared menu rows retain their touch target");
  assert.doesNotMatch(built, /@apply\b/, "all shared surface directives were compiled");
});

test("host projection keeps conditional scope and excludes app/page rules", () => {
  const theme = projectHostTheme(globals + "\n@media (prefers-reduced-motion: reduce) { :root { --field-border: 0 0% 0%; } }");
  assert.doesNotMatch(theme, /--field-border: 0 0% 0%/);
  assert.doesNotMatch(theme, /@import|@tailwind|\.app-sidebar|\.pressable/);
  const chrome = projectHostChrome(globals);
  assert.match(chrome, /prefers-color-scheme: dark/);
  assert.match(chrome, /prefers-contrast: more/);
  assert.doesNotMatch(chrome, /\.dark\s+\.ui-tooltip|\.app-sidebar|\.chat-composer/);
});
