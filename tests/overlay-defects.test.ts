import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { inertOutside } from "@/components/ui/modal-layer";
import { placeComposerPopover } from "@/components/code/v2/primitives";
import { MemoryUpdatedNotice } from "@/components/chat/memory-updated-notice";

/*
 * The overlay defect pass (pop-ups, dialogs, sheets, toasts, hover cards,
 * approvals): each test pins one fix that holds under any visual direction.
 */

// The icon set compiles with the classic JSX runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}
const TSX = sourceFiles("src");

/** Every `<DialogContent ...>` opening tag in the product, with its file. */
function dialogContentTags(): { file: string; tag: string }[] {
  const tags: { file: string; tag: string }[] = [];
  for (const file of TSX) {
    if (file.startsWith("src/components/ui/")) continue;
    const src = read(file);
    for (const m of src.matchAll(/<DialogContent\b/g)) {
      let i = m.index! + m[0].length;
      let depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0 && src[i - 1] !== "=") break;
      }
      tags.push({ file, tag: src.slice(m.index!, i + 1) });
    }
  }
  return tags;
}

test("a dialog's panel is a frame that never scrolls; one body scrolls under a pinned header and footer", () => {
  const dialog = read("src/components/ui/dialog.tsx");
  // The frame: flex column, clipped, not a scroller (pinned mode).
  assert.match(dialog, /bare \? "grid gap-4 overflow-y-auto" : "flex flex-col overflow-hidden"/);
  assert.match(dialog, /\{bare \? children : <div className="ui-dialog-body">\{children\}<\/div>\}/);
  // The ✕ and the grabber are the frame's, outside the scroller.
  assert.match(dialog, /<DialogCloseButton className="ui-dialog-close" \/>/);
  assert.match(dialog, /data-dialog-close=\{hideClose \? undefined : ""\}/);
  assert.match(dialog, /"ui-dialog-header flex flex-col/);
  assert.match(dialog, /"ui-dialog-footer flex flex-col-reverse/);
  // The title reads its token's own tracking.
  assert.doesNotMatch(dialog, /tracking-\[-0\.01em\]/);

  const css = read("src/components/ui/dialog.css");
  assert.match(css, /\.ui-dialog-body \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*padding: var\(--dialog-pad\);/s);
  assert.match(css, /\.ui-dialog-body \.ui-dialog-header \{[^}]*position: sticky;[^}]*top: calc\(var\(--dialog-pad\) \* -1\);[^}]*background-color: hsl\(var\(--popover\)\);/s);
  assert.match(css, /\.ui-dialog-body \.ui-dialog-footer \{[^}]*position: sticky;[^}]*bottom: calc\(var\(--dialog-pad\) \* -1\);[^}]*background-color: hsl\(var\(--popover\)\);/s);
  // The gutter keeps a title off the ✕, measured from the same edge.
  assert.match(css, /\.ui-dialog\[data-dialog-close\] \.ui-dialog-body \.ui-dialog-header \{\s*padding-inline-end: calc\(1rem \+ var\(--dialog-close\) \+ 0\.5rem\);/);
  // The ✕ is centred on the title's first line, whatever the inset and pointer.
  assert.match(css, /top: calc\(var\(--dialog-pad\) \+ \(1\.125rem \* 1\.3 - var\(--dialog-close\)\) \/ 2\);/);
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.ui-dialog \{\s*--dialog-close: 2\.75rem;/);
  assert.match(read("src/app/layout.tsx"), /import "@\/components\/ui\/dialog\.css";/);
});

test("no dialog can pick up half of the default padding: a panel that lays itself out is `bare`", () => {
  for (const { file, tag } of dialogContentTags()) {
    assert.doesNotMatch(tag, /sm:p-0/, `${file}: \`sm:p-0\` patched the old padding leak; use \`bare\``);
    if (/["\s]p-0[\s"]/.test(tag)) assert.match(tag, /\bbare\b/, `${file}: a p-0 panel must be bare`);
  }
  // The five that leaked the 24px frame at ≥640px.
  for (const file of [
    "src/components/app/onboarding.tsx",
    "src/components/chat/mermaid-block.tsx",
    "src/components/billing/checkout-sheet.tsx",
    "src/components/artifacts/suggestion-compare-dialog.tsx",
    "src/components/memory/import-dialog.tsx",
  ]) {
    assert.ok(dialogContentTags().some((d) => d.file === file && /\bbare\b/.test(d.tag)), file);
  }
  // The diagram dialog is on the dialog's own fill, not the darker card.
  assert.ok(!dialogContentTags().some((d) => d.file === "src/components/chat/mermaid-block.tsx" && /bg-card/.test(d.tag)));
});

test("every confirmation is the one ConfirmDialog: one width, Cancel first and focused, no ✕, no dismissal mid-request", () => {
  const confirm = read("src/components/ui/confirm-dialog.tsx");
  assert.match(confirm, /role="alertdialog"/);
  assert.match(confirm, /hideClose/);
  assert.match(confirm, /className="max-w-sm"/);
  assert.match(confirm, /cancelRef\.current\?\.focus\(/);
  assert.match(confirm, /if \(!next && busy\) return;/);
  assert.match(confirm, /<Button ref=\{cancelRef\} type="button" variant="ghost"/);
  assert.match(confirm, /variant=\{tone === "destructive" \? "destructive" : "default"\}\s+loading=\{busy\}/);
  // Cancel leads, the action trails.
  assert.ok(confirm.indexOf("{cancelLabel}") < confirm.indexOf("{confirmLabel}"));

  for (const file of [
    "src/components/app/app-sidebar.tsx",
    "src/components/skills/skill-detail-dialogs.tsx",
    "src/components/skills/skills-library-page.tsx",
    "src/components/admin/users-admin.tsx",
    "src/components/admin/moderation-admin.tsx",
    "src/components/admin/announcements-admin.tsx",
    "src/components/agents/agent-panel.tsx",
    "src/components/agents/agent-computer.tsx",
    "src/components/agents/agent-thread-header.tsx",
    "src/components/auth/account-security.tsx",
    "src/components/app/code-work-list.tsx",
    "src/components/code/code-session-menu.tsx",
    "src/components/code/v2/session-actions.tsx",
    "src/components/settings/sections/remote.tsx",
    "src/components/settings/sections/data-privacy.tsx",
    "src/components/settings/sections/account.tsx",
    "src/components/artifacts/artifact-lifecycle-actions.tsx",
    "src/components/memory/memory-footer.tsx",
    "src/app/(app)/permissions/[hostId]/page.tsx",
    "src/app/(app)/connections/page.tsx",
    "src/app/(app)/assistants/page.tsx",
    "src/app/(app)/artifacts/page.tsx",
    "src/app/(app)/automations/[id]/page.tsx",
    "src/components/chat/session-expired-dialog.tsx",
  ]) {
    assert.match(read(file), /<ConfirmDialog\b/, file);
  }
});

test("a dialog's Cancel is the ghost button everywhere", () => {
  for (const file of TSX) {
    const src = read(file);
    for (const footer of src.matchAll(/<DialogFooter[\s\S]*?<\/DialogFooter>/g)) {
      assert.doesNotMatch(footer[0], /variant="outline"[^>]*>\s*(Cancel|Keep control)\s*</, `${file}: an outline Cancel`);
    }
  }
});

test("one close button: the house ✕ on every sheet, overlay and viewer; the image editor's sits top-right", () => {
  for (const file of [
    "src/components/memory/activity-sheet.tsx",
    "src/components/connections/app-detail-sheet.tsx",
    "src/components/agents/agent-computer.tsx",
    "src/components/connections/add-mcp-server-dialog.tsx",
    "src/components/chat/mermaid-block.tsx",
  ]) {
    assert.match(read(file), /<DialogCloseButton\b/, file);
  }
  assert.match(read("src/components/documents/document-viewer.tsx"), /<CloseButton size="md" label="Close file" onClick=\{onClose\} \/>/);
  for (const file of TSX) {
    assert.doesNotMatch(read(file), /size="icon-sm"[^>]*aria-label="Close"/, `${file}: a square close plate`);
  }
  // The settings modal's corner is the house corner.
  assert.doesNotMatch(read("src/components/settings/settings-modal.tsx"), /right-3 top-3/);
  const editor = read("src/components/chat/image-edit-overlay.tsx");
  const header = editor.slice(editor.indexOf('<header className="ie-chrome'), editor.indexOf("</header>"));
  const end = header.lastIndexOf('<div className="flex justify-end">');
  assert.ok(end > 0 && header.indexOf('aria-label="Close image editor"') > end, "the close is in the trailing cell");
});

test("the skill and MCP dialogs are the house dialog: radius, motion, exit, focus return and the phone sheet", () => {
  for (const file of TSX.filter((f) => f.startsWith("src/components/"))) assert.doesNotMatch(read(file), /borderRadius: 20\b/, file);
  const shell = read("src/components/skills/skill-dialog-shell.tsx");
  assert.match(shell, /"ui-dialog overlay-glass fixed/);
  assert.match(shell, /data-phone-sheet=""/);
  assert.match(shell, /useDialogFocusReturn\(onCloseAutoFocus\)/);
  assert.match(shell, /style=\{phone \? undefined : \{ borderRadius: RADIUS\.panel \}\}/);
  assert.match(shell, /<div className="ui-sheet-grabber" data-sheet-handle="" aria-hidden \/>/);
  const mcp = read("src/components/connections/add-mcp-server-dialog.tsx");
  // On the shared primitive, whose modal-out keyframe plays through Radix
  // presence: no framer exit left without an AnimatePresence to run it.
  assert.match(mcp, /<DialogContent bare hideClose className="flex max-w-md flex-col gap-0 overflow-hidden">/);
  assert.doesNotMatch(mcp, /framer-motion|exit=\{/);
});

test("toasts sit on the --z-toast rung; their buttons take the control corner", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.toaster\[data-sonner-toaster\] \{\s*z-index: var\(--z-toast\);\s*\}/);
  const button = css.slice(css.indexOf('[data-sonner-toast][data-styled="true"] [data-button] {'));
  assert.match(button.slice(0, 600), /border-radius: theme\("borderRadius\.control"\);/);
  assert.doesNotMatch(button.slice(0, 600), /border-radius: 10px;/);
});

test("the memory notice is drawn as a toast is, and its live region is its words alone", () => {
  const notice = read("src/components/chat/memory-updated-notice.tsx");
  assert.match(notice, /"surface-float pointer-events-auto relative isolate flex[^"]*rounded-card/);
  assert.doesNotMatch(notice, /rounded-panel|shadow-glass/);
  assert.match(notice, /const EXIT_MS = DURATION\.exit;/);
  assert.match(notice, /inline-flex h-8 items-center[^"]*text-ui/);
  const html = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, {
      write: { saved: [{ id: "m1", content: "Prefers metric units", category: "preferences" }] } as never,
      onDismiss: () => undefined,
    }),
  );
  const region = /<span role="status" aria-live="polite"[^>]*>([\s\S]*?)<\/span><span class="flex shrink-0/.exec(html);
  assert.ok(region, html);
  assert.doesNotMatch(region[1], /<button|<a /, "no control inside the live region");
  assert.doesNotMatch(html.slice(0, html.indexOf(">")), /role="status"/, "the notice itself is not the live region");
});

test("the in-place full-screen layers are modal: everything else inert, live regions spared", () => {
  type Fake = {
    tagName: string;
    inert: boolean;
    live: boolean;
    children: Fake[];
    parentElement: Fake | null;
    ownerDocument: { body: Fake };
    matches(sel: string): boolean;
    querySelector(sel: string): Fake | null;
  };
  const doc = { body: null as unknown as Fake };
  const el = (tagName: string, children: Fake[] = [], live = false): Fake => {
    const node: Fake = {
      tagName,
      inert: false,
      live,
      children,
      parentElement: null,
      ownerDocument: doc,
      matches: () => node.live,
      querySelector: () => {
        const walk = (n: Fake): Fake | null => {
          for (const c of n.children) {
            if (c.live) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(node);
      },
    };
    for (const c of children) c.parentElement = node;
    return node;
  };
  const layer = el("DIV");
  const header = el("HEADER");
  const announcer = el("P", [], true);
  const main = el("MAIN", [header, layer]);
  const sidebar = el("NAV", [el("A")]);
  const shell = el("DIV", [sidebar, main, announcer]);
  const toaster = el("SECTION", [], true);
  const body = el("BODY", [shell, toaster, el("SCRIPT")]);
  doc.body = body;
  const marked = inertOutside(layer as unknown as HTMLElement);
  assert.equal(sidebar.inert, true);
  assert.equal(header.inert, true);
  assert.equal(layer.inert, false);
  assert.equal(main.inert, false);
  assert.equal(announcer.inert, false, "a live region stays live");
  assert.equal(toaster.inert, false, "toasts stay heard and clickable");
  assert.deepEqual(new Set(marked), new Set([header, sidebar]));

  for (const file of ["src/components/documents/document-viewer.tsx", "src/app/(app)/settings/page.tsx"]) {
    assert.match(read(file), /useModalLayer\(/, file);
  }
  const computer = read("src/components/agents/agent-computer.tsx");
  // The computer view is the house dialog now: trap, return, scroll lock, an exit.
  assert.match(computer, /<Dialog open=\{open\} onOpenChange=\{\(next\) => !next && requestClose\(\)\}>/);
  assert.doesNotMatch(computer, /window\.addEventListener\("keydown"/);
  assert.doesNotMatch(computer, /if \(!open\) return null;/);
  assert.match(computer, /data-\[state=closed\]:animate-\[fade-out_var\(--dur-exit\)_var\(--ease-in\)_both\]/);
  assert.doesNotMatch(computer, /hsl\(var\(--foreground\)\/0\.35\)/, "a foreground shadow glows in dark mode");
});

test("a research citation card is reachable by Tab and leaves focus on its chip when Escape closes it", () => {
  const card = read("src/components/research/citation-card.tsx");
  assert.match(card, /onKeyDownCapture=\{\(e\) => \{\s*\/\/ Tab from an open chip moves into its card\./);
  assert.match(card, /onFocusCapture=\{cancelClose\}/);
  assert.match(card, /onEscapeKeyDown=\{\(\) => \{/);
  // Past the card's last control, Tab carries on from the chip.
  assert.match(card, /const after = page\[page\.indexOf\(chip\) \+ 1\];/);
  // The chat source card is the same object on the same corner.
  assert.match(read("src/app/globals.css"), /\.ui-tooltip\.cite-card \{[^}]*border-radius: theme\("borderRadius\.card"\);/s);
});

test("a code popover is portalled, flips when its side has no room, and stays in the window", () => {
  const viewport = { width: 1280, height: 800 };
  // Room above: it opens above, aligned to the anchor's left edge.
  const above = placeComposerPopover({
    anchor: { top: 600, bottom: 640, left: 300, right: 900 },
    viewport,
    natural: 300,
    width: 280,
    align: "left",
    offset: 0,
    down: false,
  });
  assert.equal(above.down, false);
  assert.equal(above.style.bottom, 800 - 600 + 8);
  assert.equal(above.style.left, 300);
  // No room above, more below: it flips.
  const flipped = placeComposerPopover({
    anchor: { top: 60, bottom: 100, left: 300, right: 900 },
    viewport,
    natural: 300,
    width: 280,
    align: "left",
    offset: 0,
    down: false,
  });
  assert.equal(flipped.down, true);
  assert.equal(flipped.style.top, 106);
  // Right-aligned near the left edge: held inside the window.
  const clamped = placeComposerPopover({
    anchor: { top: 600, bottom: 640, left: 0, right: 100 },
    viewport,
    natural: 200,
    width: 360,
    align: "right",
    offset: 0,
    down: false,
  });
  assert.ok((clamped.style.right as number) <= viewport.width - 8 - 360);

  const primitives = read("src/components/code/v2/primitives.tsx");
  assert.match(primitives, /createPortal\(/);
  const css = read("src/components/code/v2/code-v2.css");
  assert.match(css, /\.cv2-pop \{[^}]*z-index: var\(--z-popper\);/);
  assert.match(css, /\.cv2-sheet \{[^}]*z-index: var\(--z-modal\);/);
  assert.match(css, /\.cv2-palette \{[^}]*z-index: var\(--z-modal\);/);
  assert.doesNotMatch(css, /z-index: (?:3\d|4\d)\b/, "no private stacking numbers");
  assert.doesNotMatch(css, /--cv2-shadow-pop: none/, "floating layers keep a shadow in dark mode");
  assert.match(css, /--cv2-shadow-pop: var\(--shadow-float\);/);
});

test("approvals share one button grammar, and none of them is an alertdialog", () => {
  const cv2 = read("src/components/code/v2/composer.tsx");
  assert.doesNotMatch(cv2, /role="alertdialog"/);
  assert.match(read("src/components/code/v2/code-v2.css"), /\.cv2-approve-actions \.cv2-btn \{ height: 36px; \}/);
  const run = read("src/components/code/code-run-cards.tsx");
  assert.match(run, /<QuietButton disabled=\{responding\}/);
  assert.match(run, /className=\{cn\("h-9 px-4 coarse:h-11", VERB_INK_CLASS\)\}/);
  assert.doesNotMatch(run, /variant="destructive-outline"[\s\S]{0,120}Deny/);
  // The ink verb does not carry the accent's tinted glow.
  assert.match(read("src/components/chat/decision.tsx"), /export const VERB_INK_CLASS =\s*"[^"]*shadow-none/);
  assert.doesNotMatch(read("src/components/chat/work-run-panel.tsx"), /mt-2 flex justify-end">\s*<VerbButton/);
});

test("the one bottom-sheet engine: the phone feedback form and the trace use the house sheet", () => {
  const sheet = read("src/components/ui/bottom-sheet.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(sheet, /import \{ Sheet, SheetContent \} from "@\/components\/ui\/sheet";/);
  assert.doesNotMatch(sheet, /shouldDismissSheet|juno-bottom-sheet/);
  // Code's phone popover is the same sheet: corners, cap, pill, rise and sink.
  const css = read("src/components/code/v2/code-v2.css");
  assert.match(css, /\.cv2-pop \{ position: fixed;[^}]*max-height: calc\(100dvh - env\(safe-area-inset-top, 0px\) - 1\.5rem\); border-radius: theme\("borderRadius\.panel"\) theme\("borderRadius\.panel"\) 0 0; animation: cv2-sheet-up var\(--dur-slow\) var\(--ease-drawer\)/);
  assert.match(css, /animation: cv2-sheet-down var\(--dur-base\) var\(--ease-in\) both;/);
  assert.match(css, /\.cv2-pop-grab \{[^}]*height: 4px;[^}]*background: hsl\(var\(--foreground\) \/ 0\.18\);/);
  assert.doesNotMatch(css, /82dvh|18px 18px 0 0/);
});

test("comments say what the code does", () => {
  assert.doesNotMatch(read("src/app/globals.css"), /2px backdrop blur on the\s+overlay does the rest/);
  assert.doesNotMatch(read("tailwind.config.ts"), /~2% overrun/);
  const palette = read("src/components/app/command-palette.tsx");
  assert.doesNotMatch(palette, /180\/120 tier|60px band|560px overlay/);
  assert.doesNotMatch(read("src/components/chat/approval-card.tsx"), /radius 12, no border/);
  assert.doesNotMatch(read("src/components/code/code-run-cards.tsx"), /h-11, matching chat\/approval-card/);
  assert.doesNotMatch(read("src/components/ui/button.tsx"), /solid accent fill, no shadow/);
  // The settings modal leaves on the exit rung, like every dialog.
  assert.match(read("src/components/settings/settings-modal.tsx"), /pop-out_var\(--dur-exit\)_var\(--ease-in\)_both/);
});
