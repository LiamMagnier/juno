import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { openWithViewTransition, supportsViewTransitions, viewTransitionActive, withViewTransition } from "@/lib/view-transition";

/*
 * Motion symmetry (COMPETITIVE_AUDIT G56): what animates in animates out, at
 * about 0.65x the entrance on the accelerate curve; folds stay mounted so they
 * close as they open; list to thread and docked to fullscreen canvas run as
 * view transitions with a crossfade under reduced motion.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

test("Code's surfaces leave the way they came", () => {
  const css = withoutComments(read("src/components/code/v2/code-v2.css"));
  assert.match(css, /--cv2-exit-mid: calc\(var\(--dur-mid\) \* 0\.65\);/);
  assert.match(css, /--cv2-exit-wide: calc\(var\(--dur-wide\) \* 0\.65\);/);
  for (const surface of ["cv2-pop", "cv2-dock", "cv2-palette", "cv2-sheet", "cv2-scrim"]) {
    const rule = new RegExp(`\\.${surface}(?:[.\\w-]*)?\\[data-state="closed"\\][^{]*\\{[^}]*animation: [\\w-]+ var\\(--cv2-exit-(?:mid|wide)\\) var\\(--ease-in\\)`);
    assert.match(css, rule, `${surface} has no exit`);
  }
});

test("Code's reduced motion runs the tiers, not a clamp", () => {
  const css = withoutComments(read("src/components/code/v2/code-v2.css"));
  assert.doesNotMatch(css, /animation-duration: 1ms !important/, "the blanket clamp is back");
  assert.doesNotMatch(css, /data-reduced-motion/);
  // Every travelling keyframe scales its offset by --motion-shift, so the reduced tier keeps the fade.
  for (const [, name, body] of css.matchAll(/@keyframes (cv2-[\w-]+) \{([^@]*?)\}\s*\}/g)) {
    if (/translate[XY]?\(/.test(body) && !/translate[XY]?\(-50%\)\s*;?\s*\}?$/.test(body)) {
      const offsets = [...body.matchAll(/translate[XY]?\(([^;]*?)\)(?=\s*(?:scale|;|\}|$))/g)].map((m) => m[1]);
      for (const offset of offsets) {
        if (offset === "-50%" || offset === "-50%, -50%") continue;
        assert.match(offset, /var\(--motion-shift, 1\)/, `${name}: ${offset} travels under reduced motion`);
      }
    }
  }
  const workspace = read("src/components/code/v2/workspace.tsx");
  assert.match(workspace, /data-motion=\{ui\.reducedMotion \? "reduced" : undefined\}/, "a gallery's simulation uses the app's attribute");
});

test("folds stay mounted so they close as smoothly as they open", () => {
  const thread = read("src/components/code/v2/thread.tsx");
  assert.doesNotMatch(thread, /cv2-fold-inner">\{open && /, "the fold empties before it closes");
  assert.match(thread, /\{foldMounted && <Steps /);
});

test("the task card's live-to-finished swap eases its height instead of collapsing", () => {
  const panel = read("src/components/chat/work-run-panel.tsx");
  assert.doesNotMatch(panel, /mode="wait"/);
  assert.match(panel, /useHeightSwap\(bodyRef, bodyKey\)/);
  const composer = read("src/components/code/v2/composer.tsx");
  assert.match(composer, /useHeightSwap\(shellRef, bodyKind\)/, "the approval swap jumps the composer");
});

test("route changes crossfade under reduced motion instead of cutting", () => {
  const page = read("src/components/app/page-transition.tsx");
  assert.doesNotMatch(page, /reducedMotionAt/, "the entrance skips under reduced motion again");
  assert.match(page, /6 \* \(Number\.isFinite\(shift\) \? shift : 1\)/, "the rise scales by --motion-shift");
  assert.match(page, /notifyRouteCommitted\(pathname\)/);
});

test("view transitions: list to thread and docked to fullscreen canvas", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /html\[data-vt="thread"\] \.app-page \{ view-transition-name: app-page; \}/);
  // Wave 2 (spec C18): the new page rises 4px × shift over the exit rung, the
  // old one leaves over the fast rung on the accelerate (P1 owns the CSS).
  assert.match(css, /@keyframes vt-page-in \{ from \{ opacity: 0; transform: translateY\(calc\(4px \* var\(--motion-shift, 1\)\)\); \} \}/);
  assert.match(css, /html\[data-vt\="thread"\]::view-transition-old\(app-page\) \{\s*animation: vt-page-out var\(--dur-fast\) var\(--ease-in\) both;/);
  assert.match(css, /::view-transition-group\(canvas-panel\)/);
  assert.match(read("src/components/app/app-sidebar.tsx"), /openWithViewTransition\(event, router, `\/chat\/\$\{conversation\.id\}`\)/);
  assert.match(read("src/components/projects/project-chat-list.tsx"), /openWithViewTransition\(event, router, `\/chat\/\$\{chat\.id\}`\)/);
  const canvas = read("src/components/canvas/canvas-panel.tsx");
  assert.match(canvas, /withViewTransition\("canvas", \(\) => flushSync\(onToggleFullscreen\)\)/);
  assert.match(canvas, /if \(!reducedMotionAt\(el\)\) el\.style\.viewTransitionName = "canvas-panel";/, "the box travels under reduced motion");
});

test("without the API the update simply runs, and modified clicks keep the link", async () => {
  assert.equal(supportsViewTransitions(), false);
  let ran = 0;
  await withViewTransition("canvas", () => {
    ran += 1;
  });
  assert.equal(ran, 1);
  assert.equal(viewTransitionActive(), false);
  const click = (extra: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> & { button?: number } = {}) => {
    let prevented = false;
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...extra,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as Parameters<typeof openWithViewTransition>[0];
    const pushed: string[] = [];
    const took = openWithViewTransition(event, { push: (href) => pushed.push(href) }, "/chat/a");
    return { took, prevented, pushed };
  };
  assert.deepEqual(click({ metaKey: true }), { took: false, prevented: false, pushed: [] });
  assert.deepEqual(click({ button: 1 }), { took: false, prevented: false, pushed: [] });
  // No API here: the Link navigates as it always did.
  assert.deepEqual(click(), { took: false, prevented: false, pushed: [] });
});
