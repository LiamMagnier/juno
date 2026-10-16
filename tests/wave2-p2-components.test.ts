import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { pageEntranceKeyframes, PAGE_ENTRANCE, routeClickTarget } from "@/components/app/page-transition";
import { AttachmentChip, ATTACHMENT_CHIP_SIZE, progressDashOffset, QuoteCard } from "@/components/ui/attachment-chip";
import { Badge, badgeSizeFor } from "@/components/ui/badge";
import { Collapse, CollapseChevron } from "@/components/ui/collapse";
import { EmptyMark, emptyMarkDots, EMPTY_MARK_SIZE } from "@/components/ui/empty-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { installInputModality, isNavigationKey } from "@/components/ui/input-modality";
import { Kbd } from "@/components/ui/kbd";
import { menuShellFrameClass } from "@/components/ui/menu-recipe";
import { pushSheet } from "@/components/ui/sheet-gesture";
import { createSkeletonGate, Skeleton, SkeletonRegion, type GateClock, type SkeletonPhase } from "@/components/ui/skeleton";
import { USER_BUBBLE_CLASS, USER_BUBBLE_CLAMP_GRADIENT, USER_BUBBLE_CLAMP_LINES, UserBubble } from "@/components/ui/user-bubble";
import { inSheetDragZone, mediumDetentOffset, releaseDetent } from "@/lib/sheet-gesture";
import { ROUTE_WAIT_MS, withViewTransition } from "@/lib/view-transition";

/* P2-web-foundations (4)–(8), (11), (14)–(16), (18): overlays, sheets, toasts and the shared components. */

(globalThis as { React?: typeof React }).React = React;

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const css = () => read("src/components/ui/sheet.css").replace(/\/\*[\s\S]*?\*\//g, "");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

test("overlays: frequent 120 in / 70 out from 0.97, infrequent 220 on the standard spring / 160 to 0.98, keyboard opacity only", () => {
  const s = css();
  assert.match(s, /\.ui-overlay-frequent\[data-state="open"\],\s*\.ui-overlay-frequent\[data-state="delayed-open"\] \{\s*animation: ui-overlay-in var\(--dur-fast\) var\(--ease-out-soft\) both;/);
  assert.match(s, /\.ui-overlay-frequent\[data-state="closed"\] \{\s*animation: ui-overlay-out var\(--dur-press\) var\(--ease-in\) both;/);
  assert.match(s, /\.ui-overlay-frequent\[data-state="instant-open"\] \{\s*animation: none;/, "a peer tooltip shows instantly");
  assert.match(s, /\.ui-overlay-infrequent\[data-state="open"\] \{\s*animation: ui-overlay-in var\(--dur-base\) var\(--spring-standard/);
  assert.match(s, /\.ui-overlay-infrequent\[data-state="closed"\] \{\s*animation: ui-overlay-out-far var\(--dur-exit\) var\(--ease-in\) both;/);
  assert.match(s, /@keyframes ui-overlay-in \{\s*from \{\s*opacity: 0;\s*transform: scale\(var\(--motion-scale-from, 0\.97\)\);/);
  assert.match(s, /@keyframes ui-overlay-out-far \{\s*to \{\s*opacity: 0;\s*transform: scale\(var\(--motion-scale-from, 0\.98\)\);/);
  assert.match(s, /html\[data-input-modality="keyboard"\] \.ui-overlay-frequent\[data-state="open"\][\s\S]*?animation: ui-overlay-fade-in var\(--dur-fast\)/);
  assert.match(s, /transform-origin: var\(--radix-popper-transform-origin/);
  // Wired into the primitives.
  assert.match(menuShellFrameClass, /ui-overlay-frequent/);
  assert.match(read("src/components/ui/tooltip.tsx"), /"ui-overlay-frequent [^"]*text-ui/);
  assert.match(read("src/components/ui/popover.tsx"), /"ui-overlay-infrequent /);
  assert.match(read("src/components/ui/dialog.tsx"), /ui-overlay-infrequent/);
  assert.doesNotMatch(read("src/components/ui/dialog.tsx"), /backdrop-blur/, "no backdrop-filter in ui (D15)");
  assert.doesNotMatch(read("src/components/ui/popover.tsx"), /backdrop-blur-|backdrop-filter/);
});

test("every keyframe in the ui stylesheet keeps Tier B: travel reads --motion-shift or --motion-scale-from, and nothing blurs", () => {
  const s = css();
  for (const [, name, body] of s.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) {
    assert.doesNotMatch(body, /blur\(/, `${name} blurs`);
    for (const m of body.matchAll(/transform: ([^;]+);/g)) {
      assert.match(m[1], /var\(--motion-(shift|scale-from)/, `${name}: ${m[1]} travels under reduced motion`);
    }
  }
});

test("tooltip timing is 500 then 300 for peers", () => {
  const tooltip = read("src/components/ui/tooltip.tsx");
  assert.match(tooltip, /delayDuration = TIMING\.tooltip,/);
  assert.match(tooltip, /skipDelayDuration = TIMING\.tooltipSkip,/);
  assert.doesNotMatch(read("src/components/providers.tsx"), /delayDuration=\{/, "the provider tree does not override it");
});

test("toasts sit 16px above the composer height, rise 8px over 220 and drop 4px over 160", () => {
  // sonner.tsx builds its icons as JSX at module scope, so it is read rather than imported here.
  assert.match(read("src/components/ui/sonner.tsx"), /export const TOAST_BOTTOM_OFFSET = "calc\(var\(--composer-h, 0px\) \+ 16px\)";/);
  const sonner = read("src/components/ui/sonner.tsx");
  assert.match(sonner, /offset=\{\{ bottom: TOAST_BOTTOM_OFFSET \}\}/);
  assert.match(sonner, /mobileOffset=\{\{ bottom: TOAST_BOTTOM_OFFSET,/);
  assert.doesNotMatch(sonner, /COMPOSER_ROUTES/, "no route list: --composer-h is 0 without a composer");
  const s = css();
  assert.match(s, /\[data-styled="true"\] \{\s*transition-duration: var\(--dur-base\);\s*transition-timing-function: var\(--spring-standard/);
  assert.match(s, /\[data-mounted="false"\] \{\s*--y: translateY\(calc\(8px \* var\(--motion-shift, 1\)\)\);/);
  assert.match(s, /\[data-removed="true"\] \{\s*transition-duration: var\(--dur-exit\);\s*transition-timing-function: var\(--ease-in\);/);
  assert.match(s, /\[data-swipe-out="false"\] \{\s*--y: translateY\(calc\(4px \* var\(--motion-shift, 1\)\)\);/);
  assert.match(read("src/components/providers.tsx"), /<Toaster \/>/, "the Toaster stays mounted in providers.tsx");
});

test("sheets: drag zone, detents, nesting, half scrim at medium, 220 programmatic dismiss", () => {
  // The 44px header, or the first 44px of a body scrolled to the top.
  assert.equal(inSheetDragZone({ y: 140, panelTop: 100 }), true);
  assert.equal(inSheetDragZone({ y: 145, panelTop: 100 }), false);
  assert.equal(inSheetDragZone({ y: 300, panelTop: 100, body: { top: 270, scrollTop: 0 } }), true);
  assert.equal(inSheetDragZone({ y: 300, panelTop: 100, body: { top: 270, scrollTop: 12 } }), false, "a scrolled body keeps the touch");
  assert.equal(inSheetDragZone({ y: 330, panelTop: 100, body: { top: 270, scrollTop: 0 } }), false);
  // Medium detent: half the viewport shows.
  assert.equal(mediumDetentOffset(800, 900), 350);
  assert.equal(mediumDetentOffset(300, 900), 0, "a short sheet sits at its own height");
  const at = (o: Partial<Parameters<typeof releaseDetent>[0]>) =>
    releaseDetent({ detent: "medium", offset: 0, velocity: 0, detentOffset: 350, visible: 450, ...o });
  assert.equal(at({ offset: -120 }), "large", "pulled up 30% of the way");
  assert.equal(at({ offset: -40, velocity: -0.6 }), "large", "a flick up");
  assert.equal(at({ offset: -40 }), "medium");
  assert.equal(at({ offset: 200 }), "dismiss");
  assert.equal(at({ offset: 40, velocity: 0.6 }), "dismiss", "a flick down from medium");
  assert.equal(releaseDetent({ detent: "large", offset: 150, velocity: 0.1, detentOffset: 350, visible: 800 }), "large");
  assert.equal(releaseDetent({ detent: "large", offset: 300, velocity: 0.1, detentOffset: 350, visible: 800 }), "medium", "large → medium first");
  assert.equal(releaseDetent({ detent: "large", offset: 600, velocity: 0.1, detentOffset: 350, visible: 800 }), "dismiss");
  const s = css();
  assert.match(s, /\[data-swipe-scrim\]\[data-detent="medium"\] \{\s*opacity: 0\.5;/, "0.13 light, 0.28 dark");
  assert.match(s, /\.ui-sheet\[data-side="bottom"\]\[data-detent="medium"\] \{\s*translate: 0 var\(--sheet-detent-offset, 0px\);/);
  assert.match(s, /\.ui-sheet\.ui-sheet\[data-sheet-covered\] \{\s*translate: 0 calc\(-16px \* var\(--motion-shift, 1\)\);/);
  assert.match(s, /\.ui-sheet\[data-side="bottom"\]\[data-state="closed"\] \{\s*animation: ui-sheet-sink var\(--dur-base\) var\(--ease-in\) both;/, "a programmatic dismiss runs 220 and stays mounted (Radix Presence waits for it)");
  assert.match(s, /\[data-swipe-scrim\]\[data-sheet-scrim\]\[data-state="closed"\] \{\s*animation-duration: var\(--dur-base\);/, "the scrim fades in step");
  // Kinds.
  const sheet = read("src/components/ui/sheet.tsx");
  assert.match(sheet, /data-sheet-kind=\{sheetKind\}/);
  assert.match(sheet, /sheetKind === "form" \? <DialogCloseButton/);
  assert.match(read("src/components/ui/bottom-sheet.tsx"), /kind = "glance"/);
});

test("nested bottom sheets: every sheet under the top one is covered", () => {
  const make = () => {
    const attrs = new Set<string>();
    return {
      attrs,
      setAttribute: (name: string) => attrs.add(name),
      removeAttribute: (name: string) => attrs.delete(name),
    } as unknown as HTMLElement & { attrs: Set<string> };
  };
  const a = make();
  const b = make();
  const c = make();
  const offA = pushSheet(a);
  assert.equal(a.attrs.has("data-sheet-covered"), false);
  const offB = pushSheet(b);
  const offC = pushSheet(c);
  assert.deepEqual([a, b, c].map((s) => s.attrs.has("data-sheet-covered")), [true, true, false]);
  offC();
  assert.deepEqual([a, b].map((s) => s.attrs.has("data-sheet-covered")), [true, false]);
  offB();
  offA();
  assert.equal(a.attrs.has("data-sheet-covered"), false);
});

test("the drawer: --drawer-width, the drawer dim, 0.22 parallax and a reduced cross-fade", () => {
  const s = css();
  assert.match(s, /\.ui-sheet\[data-drawer\] \{\s*width: var\(--drawer-width/);
  assert.match(s, /\[data-swipe-scrim\]\[data-drawer-scrim\] \{\s*background: rgb\(0 0 0 \/ var\(--drawer-dim, 0\.12\)\);/);
  assert.match(s, /html\[data-drawer-open\] \[data-drawer-parallax\] \{\s*transform: translate3d\(calc\(var\(--drawer-width[^)]*\)\) \* var\(--drawer-parallax, 0\.22\)\)/);
  assert.match(s, /\.ui-sheet\[data-drawer\]\[data-state="open"\] \{\s*animation: ui-drawer-in var\(--dur-base\)/, "220, a cross-fade when --motion-shift is 0");
  assert.match(s, /@keyframes ui-drawer-in \{\s*from \{\s*opacity: var\(--motion-shift, 1\);/);
  assert.match(read("src/components/ui/sheet-gesture.ts"), /const ms = settleMs\(open \? w - travel : travel, velocity\);/, "the edge pull settles per D18");
});

test("input modality: navigation keys mark the keyboard, a pointerdown the pointer", () => {
  assert.equal(isNavigationKey({ key: "Enter" }), true);
  assert.equal(isNavigationKey({ key: "ArrowDown" }), true);
  assert.equal(isNavigationKey({ key: "k", metaKey: true }), true);
  assert.equal(isNavigationKey({ key: "a" }), false, "typing is not navigation");
  const listeners = new Map<string, (e: unknown) => void>();
  const attrs = new Map<string, string>();
  const doc = {
    documentElement: {
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Document;
  const dispose = installInputModality(doc);
  listeners.get("keydown")!({ key: "Enter" });
  assert.equal(attrs.get("data-input-modality"), "keyboard");
  listeners.get("pointerdown")!({});
  assert.equal(attrs.get("data-input-modality"), "pointer");
  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(attrs.has("data-input-modality"), false);
});

test("view transitions: 80ms route wait, a close direction for the canvas", async () => {
  assert.equal(ROUTE_WAIT_MS, 80);
  const source = read("src/lib/view-transition.ts");
  assert.match(source, /root\.dataset\.vtDir = "close"/);
  assert.match(source, /markRouteClick\(target\)/);
  assert.doesNotMatch(source, /@view-transition/);
  let ran = false;
  await withViewTransition("canvas", () => {
    ran = true;
  }, { dir: "close" });
  assert.ok(ran, "without the API the update simply runs");
  assert.match(read("src/components/app/page-transition.tsx"), /markShellVisible\(pathname\)/);
});

test("page transition: a 160 opacity fallback, 6px only when motion is allowed, nothing left behind", () => {
  assert.equal(PAGE_ENTRANCE.durationMs, 160);
  assert.deepEqual(pageEntranceKeyframes(1), [
    { opacity: 0, transform: "translateY(6px)" },
    { opacity: 1, transform: "none" },
  ]);
  assert.deepEqual(pageEntranceKeyframes(0), [{ opacity: 0 }, { opacity: 1 }], "reduced motion: opacity only");
  assert.match(read("src/components/app/page-transition.tsx"), /fill: "none"/);
});

test("every plain in-app link click starts the route budget", () => {
  const location = { origin: "https://alevr.test", pathname: "/chat", href: "https://alevr.test/chat" };
  const anchor = (href: string, attrs: Record<string, string> = {}) => ({
    getAttribute: (name: string) => (name === "href" ? href : attrs[name] ?? null),
    hasAttribute: (name: string) => name in attrs,
  });
  const click = (href: string, over: Partial<MouseEvent> = {}, attrs: Record<string, string> = {}) =>
    routeClickTarget(
      {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        target: { closest: () => anchor(href, attrs) } as unknown as EventTarget,
        ...over,
      },
      location,
    );
  assert.equal(click("/library"), "/library");
  assert.equal(click("https://alevr.test/code/abc"), "/code/abc");
  assert.equal(click("/chat"), null, "same path");
  assert.equal(click("#section"), null, "a hash");
  assert.equal(click("https://example.com/x"), null, "another origin");
  assert.equal(click("/library", { metaKey: true }), null, "a new tab");
  assert.equal(click("/library", { button: 1 }), null);
  assert.equal(click("/library", {}, { target: "_blank" }), null);
});

test("skeleton: 200ms before it shows, at least 400ms once shown, busy and labelled", () => {
  const clock = fakeClock();
  const phases: SkeletonPhase[] = [];
  const gate = createSkeletonGate((p) => phases.push(p), clock as GateClock);
  gate.setLoading(true);
  clock.advance(150);
  gate.setLoading(false);
  assert.deepEqual(phases, ["waiting", "content"], "a fast load never shows the skeleton");
  phases.length = 0;
  gate.setLoading(true);
  clock.advance(200);
  assert.equal(gate.phase(), "skeleton");
  clock.advance(100);
  gate.setLoading(false);
  assert.equal(gate.phase(), "skeleton", "held for the 400ms minimum");
  clock.advance(299);
  assert.equal(gate.phase(), "skeleton");
  clock.advance(1);
  assert.equal(gate.phase(), "content");
  gate.dispose();
  const region = html(React.createElement(SkeletonRegion, { loading: true, skeleton: React.createElement(Skeleton), children: "Loaded" }));
  assert.match(region, /aria-busy="true"/);
  assert.match(region, /class="sr-only">Loading</);
  assert.doesNotMatch(region, /Loaded/);
  assert.match(html(React.createElement(Skeleton)), /class="skeleton rounded-control"/);
  const s = css();
  assert.match(s, /@media \(prefers-reduced-motion: reduce\) \{\s*\.skeleton\.skeleton \{\s*animation: none;\s*opacity: 0\.8;/, "Tier C holds at 0.8");
  assert.match(s, /\.ui-skeleton-content \{\s*animation: ui-overlay-fade-in var\(--dur-exit\)/, "skeleton → content is a 160 cross-fade");
});

test("collapse: 220 in-out open with 120 opacity, 160 close, mounted and inert, chevron 120", () => {
  assert.equal(html(React.createElement(Collapse, { open: false, children: "Hidden" })), "", "never opened: not mounted");
  const open = html(React.createElement(Collapse, { open: true, children: "Shown" }));
  assert.match(open, /data-state="open"/);
  assert.match(open, /data-appear="none"/, "open on the first render: no unfold");
  assert.doesNotMatch(open, /inert/);
  const s = css();
  assert.match(s, /\.ui-collapse \{\s*grid-template-rows: 1fr;\s*opacity: 1;\s*transition:\s*grid-template-rows var\(--dur-base\) var\(--ease-in-out\),\s*opacity var\(--dur-fast\) var\(--ease-out-soft\);/);
  assert.match(s, /\.ui-collapse\[data-state="closed"\] \{\s*grid-template-rows: 0fr;\s*opacity: 0;\s*transition:\s*grid-template-rows var\(--dur-exit\) var\(--ease-in\),\s*opacity var\(--dur-exit\) var\(--ease-in\);/);
  assert.match(s, /\.ui-collapse-chevron \{\s*transition: rotate var\(--dur-fast\)/);
  assert.match(read("src/components/ui/collapse.tsx"), /inert=\{!open\}/);
  assert.match(html(React.createElement(CollapseChevron, { open: true, children: "›" })), /data-state="open"/);
});

test("icon swap at 120 from 0.8; the press dip only on solo icon buttons", () => {
  const swap = read("src/components/ui/icon-swap.tsx");
  assert.doesNotMatch(swap, /scale-75/);
  assert.match(swap, /scale\(var\(--motion-scale-from,0\.8\)\)/);
  assert.match(swap, /duration-fast/);
  const pressable = read("src/components/ui/pressable.tsx");
  assert.match(pressable, /tile: "[^"]*active:scale-100"/);
  assert.match(pressable, /chip: "[^"]*active:scale-100"/);
  assert.doesNotMatch(pressable.match(/icon: "[^"]*"/)![0], /active:scale-100/, "icons keep the 0.97 dip");
});

test("Kbd and Badge use text-kbd; chords print in the platform form", () => {
  const kbd = html(React.createElement(Kbd, { chord: "⇧⌘F" }));
  assert.match(kbd, /text-kbd/);
  assert.match(kbd, /⇧⌘F/, "the server's first paint is the Apple form");
  assert.doesNotMatch(read("src/components/ui/kbd.tsx"), /text-micro/);
  assert.equal(badgeSizeFor("3"), "count");
  assert.equal(badgeSizeFor(99), "count");
  assert.equal(badgeSizeFor("99+"), "count");
  assert.equal(badgeSizeFor("Beta"), "label", "words never drop under the 12px floor");
  assert.match(html(React.createElement(Badge, null, "12")), /text-kbd/);
  assert.match(html(React.createElement(Badge, null, "Beta")), /text-label/);
});

test("segmented control and product thumbs travel on spring.standard", () => {
  assert.match(read("src/components/ui/segmented-control.tsx"), /spring\.standard/);
});

test("empty state: 48/32 neutral mark, Newsreader title, 44ch body, primary and quiet action, panel recess at 16", () => {
  assert.equal(EMPTY_MARK_SIZE.page, 48);
  assert.equal(EMPTY_MARK_SIZE.panel, 32);
  const dots = emptyMarkDots(48);
  assert.ok(dots.length > 50);
  assert.ok(dots.every((d) => (d.x - 2) % 4 === 0 && (d.y - 2) % 4 === 0), "the 4px dot-matrix pitch");
  assert.ok(dots.some((d) => d.ring) && dots.some((d) => !d.ring));
  const mark = html(React.createElement(EmptyMark, { size: "panel" }));
  assert.match(mark, /width="32" height="32"/);
  assert.match(mark, /aria-hidden="true"/);
  assert.doesNotMatch(mark, /presence|canvas/, "neutral: no presence lamp, no canvas");
  const page = html(
    React.createElement(EmptyState, {
      title: "No chats yet",
      description: "Start one.",
      action: React.createElement("button", null, "New chat"),
      secondaryAction: React.createElement("button", null, "Import"),
    }),
  );
  assert.match(page, /<h2 class="[^"]*font-serif[^"]*text-page-title/);
  assert.match(page, /max-w-\[44ch\][^"]*text-body/);
  assert.ok(page.indexOf("New chat") < page.indexOf("Import"));
  const panel = html(React.createElement(EmptyState, { title: "Nothing here", size: "panel" }));
  assert.match(panel, /rounded-panel/);
  assert.match(panel, /bg-muted/);
  assert.match(panel, /text-title/);
  assert.doesNotMatch(panel, /dashed/);
});

test("attachment chips: 224×56 files at 12, 64×64 images at 10, progress arc, failed with glyph, word and Retry", () => {
  assert.deepEqual(ATTACHMENT_CHIP_SIZE.file, { width: 224, height: 56, radius: 12 });
  assert.deepEqual(ATTACHMENT_CHIP_SIZE.image, { width: 64, height: 64, radius: 10 });
  assert.equal(progressDashOffset(0, 100), 100);
  assert.equal(progressDashOffset(0.25, 100), 75);
  assert.equal(progressDashOffset(2, 100), 0);
  const file = html(React.createElement(AttachmentChip, { kind: "file", name: "report.pdf", meta: "PDF · 2 MB", layoutId: "att-1" }));
  assert.match(file, /width:224px;height:56px;border-radius:12px/);
  assert.match(file, /data-layout-id="att-1"/);
  const uploading = html(React.createElement(AttachmentChip, { kind: "file", name: "a.txt", state: "uploading", progress: 0.4 }));
  assert.match(uploading, /role="progressbar"[^>]*aria-valuenow="40"/);
  assert.match(uploading, /stroke-dashoffset/);
  assert.doesNotMatch(uploading, /animate-spin/, "a progress arc, never a spinner");
  const failed = html(React.createElement(AttachmentChip, { kind: "image", name: "cat.png", src: "blob:x", state: "failed", onRetry: () => {} }));
  assert.match(failed, /width:64px;height:64px;border-radius:10px/);
  assert.match(failed, /Failed/);
  assert.match(failed, /Retry/);
  assert.match(failed, /data-glyph="AlertTriangle"/);
  const quote = html(React.createElement(QuoteCard, { text: "A line worth quoting.", layoutId: "q-1" }));
  assert.match(quote, /aria-label="Selection"/);
  assert.match(quote, />Selection</);
  assert.match(quote, /data-layout-id="q-1"/);
});

test("user bubble: 12 with an 8 end-end tuck, --user-bubble fill, 10/16 padding, max 85%, exported fill and clamp", () => {
  assert.match(USER_BUBBLE_CLASS, /\bui-user-bubble\b/);
  assert.match(css(), /\.ui-user-bubble \{\s*border-radius: var\(--radius-bubble, 12px\);\s*border-end-end-radius: var\(--radius-bubble-tuck, 8px\);/, "12 with the 8 tuck on the logical end-end corner (mirrors in RTL)");
  assert.match(USER_BUBBLE_CLASS, /bg-\[hsl\(var\(--user-bubble\)\)\]/);
  assert.match(USER_BUBBLE_CLASS, /px-4 py-2\.5/);
  assert.equal(USER_BUBBLE_CLAMP_LINES, 12);
  assert.match(USER_BUBBLE_CLAMP_GRADIENT, /hsl\(var\(--user-bubble\)\)/);
  const bubble = html(React.createElement(UserBubble, { layoutId: "m1" }, "Hello"));
  assert.match(bubble, /max-w-\[85%\]/);
  assert.match(bubble, /data-tone-step=""/, "the high-contrast edge");
  assert.match(bubble, /data-layout-id="m1"/);
  assert.match(read("src/components/ui/user-bubble.tsx"), /hover:bg-\[hsl\(var\(--user-bubble-hover\)\)\]/);
});
