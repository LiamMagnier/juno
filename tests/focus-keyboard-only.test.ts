import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * TEXT FIELDS RING FOR THE KEYBOARD ONLY.
 *
 * A text field matches :focus-visible on EVERY focus: a click, a tap, a
 * dialog autofocusing it. So `focus-visible:ring-*`, a primary-coloured
 * halo or the global outline on a field drew a near-black double line on
 * every click (the owner: "an ugly black border around the composer"). The
 * fix is one mechanism, pinned here from source because node:test has no
 * DOM:
 *
 *   - lib/input-modality.ts mirrors how the person moves focus to
 *     <html data-modality>, installed once at the root (providers.tsx);
 *   - the `kbd-focus:` / `kbd-focus-within:` variants (tailwind.config.ts)
 *     match only under data-modality=keyboard, and the global outline is
 *     gated on it (globals.css);
 *   - the composer's ring is decided by ComposerShell from the live modality,
 *     so every composer on the shell gets it and none keeps a private copy.
 */

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the modality is tracked from the app's root, not from the first composer", () => {
  const providers = code("src/components/providers.tsx");
  assert.match(providers, /import \{ installInputModality \} from "@\/lib\/input-modality"/);
  assert.match(providers, /React\.useEffect\(installInputModality, \[\]\)/);
});

test("the kbd-focus variants match only while the person is using the keyboard", () => {
  const config = code("tailwind.config.ts");
  assert.match(config, /addVariant\("kbd-focus", ":root\[data-modality=keyboard\] &:focus-visible"\)/);
  assert.match(config, /addVariant\("kbd-focus-within", ":root\[data-modality=keyboard\] &:has\(/);
});

test("the global outline leaves text fields to the keyboard, and quiets a script's focus after a press", () => {
  const css = code("src/app/globals.css");
  const gate = css.match(/@media \(forced-colors: none\) \{([\s\S]*?)\n  \}/);
  assert.ok(gate, "the modality gate is missing");
  assert.match(gate[1], /:root:is\(\[data-modality="pointer"\], \[data-modality="none"\]\) :focus-visible/);
  assert.match(gate[1], /:root:not\(\[data-modality="keyboard"\]\) :is\(textarea, input:not\(/);
  assert.match(gate[1], /outline-color: transparent;/);
});

test("the composer's keyboard ring survives forced colours and steps up under Increase Contrast", () => {
  const css = code("src/app/globals.css");
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.composer-surface\[data-kbd-focus\] \{ outline: 2px solid Highlight;/);
  const contrast = css.match(/@media \(prefers-contrast: more\) \{\s*\.composer-surface \{[\s\S]*?\n  \}/);
  assert.ok(contrast, "the composer's contrast block is missing");
  assert.match(contrast[0], /\.dark \.composer-surface \{ border-color: hsl\(var\(--foreground\) \/ 0\.45\); \}/);
  assert.match(contrast[0], /\.dark \.composer-surface:focus-within \{ border-color: hsl\(var\(--foreground\) \/ 0\.65\); \}/);
  assert.match(contrast[0], /\.composer-surface\[data-kbd-focus\]::after \{ box-shadow: 0 0 0 1px hsl\(var\(--ring\)\); \}/);
});

test("ComposerShell decides the ring from the live modality; hosts keep no private copy", () => {
  const shell = code("src/components/ui/composer-shell.tsx");
  assert.match(shell, /React\.useSyncExternalStore\(subscribeInputModality, inputModality, noModality\)/);
  assert.match(shell, /keyboardFocus \|\| \(fieldFocused && modality === "keyboard"\)/);
  assert.match(shell, /data-kbd-focus=\{ring \? "" : undefined\}/);
  const composer = code("src/components/chat/composer.tsx");
  assert.doesNotMatch(composer, /pointerFocus/, "the stale pointer flag is back (it outlived presses that never focused the field)");
  assert.doesNotMatch(composer, /keyboardFocus=\{/);
  const imageEdit = code("src/components/chat/image-edit-overlay.tsx");
  assert.doesNotMatch(imageEdit, /modalityRef|kbdFocus/, "the image editor tracks modality on its own again");
});

test("no fixed text field draws a ring or a primary halo on every focus", () => {
  const fields = [
    "src/components/ui/input.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/settings/sections/account-username.tsx",
    "src/components/chat/message-item.tsx",
    "src/components/research/scope-card.tsx",
    "src/components/app/code-work-list.tsx",
    "src/components/agents/agents-home.tsx",
    "src/components/agents/computer-viewer.tsx",
    "src/components/code/code-input-request.tsx",
    "src/components/canvas/code-surface.tsx",
    "src/components/chat/memory-fact-row.tsx",
    "src/components/research/run-controls.tsx",
    "src/components/design/effects-panel.tsx",
    "src/components/design/layers-panel.tsx",
    "src/components/design/design-workspace.tsx",
  ];
  const everyFocus = [
    /focus-visible:ring-(?:2|ring|primary)/,
    /focus-within:ring-2/,
    /focus-(?:visible|within):shadow-\[0_0_0_3px_hsl\(var\(--primary\)/,
    /focus-(?:visible|within):border-primary/,
    /has-\[textarea:focus-visible\]:shadow/,
  ];
  // The shared fields are whole files; elsewhere, the line that carries the
  // field's keyboard ring (buttons in the same file keep their own rings).
  const wholeFile = new Set(["src/components/ui/input.tsx", "src/components/ui/textarea.tsx"]);
  // Consolidated fields inherit their keyboard line from the shared recipe.
  // Check the consumer wiring AND that recipe; requiring a private copy of
  // the class in each file would reintroduce the design drift this fixes.
  const sharedConsumers = new Map([
    ["src/components/ui/input.tsx", /fieldFrameClass/],
    ["src/components/ui/textarea.tsx", /fieldFrameClass/],
    ["src/components/settings/sections/account-username.tsx", /<Input\b/],
  ]);
  for (const file of fields) {
    let source = code(file);
    const shared = sharedConsumers.get(file);
    if (shared) {
      assert.match(source, shared, `${file} must consume the shared field`);
      source += "\n" + code("src/components/ui/field-recipe.ts");
    }
    const lines = source.split("\n").filter((line) => /kbd-focus(?:-within)?:/.test(line));
    assert.ok(lines.length > 0, `${file} has no keyboard ring`);
    const checked = wholeFile.has(file) ? [source] : lines;
    for (const text of checked) {
      for (const pattern of everyFocus) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
    }
  }
});

test("the public pages and Code's scope ring stay off text fields", () => {
  const publicCss = code("src/components/public/public.css");
  assert.match(publicCss, /\.alevr-public :is\(button, a\):focus-visible \{ outline:/);
  assert.doesNotMatch(publicCss, /:is\(button, a, input\):focus-visible/);
  assert.doesNotMatch(publicCss, /\.field-well:focus-within \{ border-color: hsl\(var\(--ring\)\)/);
  const cv2 = code("src/components/code/v2/code-v2.css");
  assert.match(cv2, /\.cv2 :focus-visible:where\(:not\(textarea, \[contenteditable\], input:not\(/);
  assert.doesNotMatch(cv2, /^\.cv2 :focus-visible \{/m);
  assert.match(cv2, /:root\[data-modality="keyboard"\] :is\(\.cv2-mini input, \.cv2-budget, \.cv2-keyfield input, \.cv2-preview-url, \.cv2-answer\):focus-visible/);
});
