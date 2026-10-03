import test from "node:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import assert from "node:assert/strict";
import designSystem, { COMPONENT_RADIUS, PX_TO_TOKEN, RADIUS_PX } from "../eslint-rules/design-system.mjs";
import tailwindConfig from "../tailwind.config";

/**
 * The concentric radius rule, pinned by example.
 *
 * `tailwind.config.ts` has stated `outer radius = inner radius + padding` for as
 * long as the ladder has existed, and until this rule nothing checked it. Three
 * places in the app had drifted, each under a comment claiming to have done the
 * arithmetic: the Library's file tile put a 12px well inside a 16px card padded
 * by 12 ("16 − 12 ≈ field 12"), the inline artifact card put a 6px sheet inside
 * the same card padded by 8 ("14px outer minus the 8px mat is 6" — the card is
 * 16), and the image editor's segmented buttons sat at 6 inside a 12px track
 * padded by 4 ("concentric with the `field` (10px) track" — `field` is 12).
 *
 * Then the ladder itself moved (V3: control 8 · field 10 · card 12 · menu 14 ·
 * panel 16 · composer 22) and the rule's px table did not, so for a month it
 * demanded the old arithmetic: right sites carried `eslint-disable` lines
 * ("the rule's table is stale") and wrong ones passed. The first tests below
 * read tailwind.config.ts so the table cannot drift from the ladder again.
 *
 * The valid cases below matter as much as the invalid ones. The rule only fires
 * where both numbers are knowable and something is actually drawn at the child's
 * corners, because a rule that cries wolf on skeleton bars gets disabled.
 */

// `node:test` provides describe/it globally under tsx; RuleTester needs them named.
RuleTester.describe = (text: string, fn: () => void) => fn();
RuleTester.it = (text: string, fn: () => void) => {
  test(`concentric-radius: ${text}`, fn);
};
RuleTester.itOnly = RuleTester.it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as never,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

const rule = designSystem.rules["concentric-radius"];

const ladder = (tailwindConfig.theme?.extend?.borderRadius ?? {}) as Record<string, string>;

test("concentric-radius: the rule's px table is the tailwind ladder", () => {
  for (const [name, value] of Object.entries(ladder)) {
    if (name === "DEFAULT") continue;
    const px = name === "lg" ? 12 : /^(\d+)px$/.exec(value)?.[1];
    if (px === undefined) continue; // %, inherit, calc — not rungs
    assert.equal(RADIUS_PX[name as keyof typeof RADIUS_PX], Number(px), `rounded-${name}`);
  }
  for (const [name, px] of Object.entries(RADIUS_PX)) {
    if (name === "none") continue;
    assert.ok(name in ladder, `rounded-${name} (${px}px) is in the rule but not on the ladder`);
  }
});

test("concentric-radius: every suggested token is the rung it names", () => {
  for (const [px, name] of Object.entries(PX_TO_TOKEN)) {
    if (name === "none") continue;
    assert.equal(RADIUS_PX[name as keyof typeof RADIUS_PX], Number(px), `${px} → rounded-${name}`);
  }
});

test("concentric-radius: wrapper radii match the rungs their sources use", () => {
  assert.equal(COMPONENT_RADIUS.Card, RADIUS_PX.card);
  assert.equal(COMPONENT_RADIUS.DialogContent, RADIUS_PX.panel);
  assert.equal(COMPONENT_RADIUS.PopoverContent, RADIUS_PX.popover);
  assert.equal(COMPONENT_RADIUS.DropdownMenuContent, RADIUS_PX.menu);
  assert.equal(COMPONENT_RADIUS.TooltipContent, RADIUS_PX.control);
});

ruleTester.run("concentric-radius", rule as never, {
  valid: [
    // A segmented track: 14 − 4 = 10.
    {
      code: `const A = () => (
        <div className="rounded-menu p-1">
          <span className="rounded-field bg-card">x</span>
        </div>
      )`,
    },
    // The dropdown shell: 14 − 6 = 8.
    {
      code: `const A = () => (
        <div className="rounded-menu p-1.5">
          <div className="rounded-control bg-accent">x</div>
        </div>
      )`,
    },
    // A list well: 12 − 4 = 8.
    {
      code: `const A = () => (
        <div className="rounded-card p-1">
          <div className="rounded-control hover:bg-accent">x</div>
        </div>
      )`,
    },
    // The concentric pair computes its own child radius.
    {
      code: `const A = () => (
        <div className="nest-menu nest-p-1.5 rounded-menu p-1.5">
          <div className="rounded-inner bg-accent">x</div>
        </div>
      )`,
    },
    // A pill is a pill at any size.
    {
      code: `const A = () => (
        <div className="rounded-card p-3">
          <span className="rounded-full bg-primary">x</span>
        </div>
      )`,
    },
    // Out of flow, so the parent's padding never insets it.
    {
      code: `const A = () => (
        <div className="rounded-card p-3">
          <div className="absolute rounded-field bg-card">x</div>
        </div>
      )`,
    },
    // Narrower than the content box: a skeleton bar standing in for text, not a
    // nested surface. This is the false positive that would have made the rule
    // unusable on every loading state in the app.
    {
      code: `const A = () => (
        <div className="rounded-card p-3">
          <div className="h-3 w-3/4 rounded-xs bg-muted" />
        </div>
      )`,
    },
    // Nothing drawn at the corners: the radius exists for a focus ring.
    {
      code: `const A = () => (
        <div className="rounded-card p-3">
          <a className="flex flex-1 items-center rounded-xs">x</a>
        </div>
      )`,
    },
    // Asymmetric padding does not inset all four corners.
    {
      code: `const A = () => (
        <div className="rounded-card px-3">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
    },
    // A parent whose radius this rule cannot know stays silent.
    {
      code: `const A = () => (
        <Whatever className="p-3">
          <div className="rounded-field bg-card">x</div>
        </Whatever>
      )`,
    },
  ],

  invalid: [
    // The Library file tile's shape (a well too round for its card's inset).
    {
      code: `const A = () => (
        <Card className="p-2">
          <div className="surface-inset aspect-square overflow-hidden rounded-field" />
        </Card>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // The same shape written literally rather than through the component.
    {
      code: `const A = () => (
        <div className="rounded-card p-1">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // The old ladder's arithmetic left behind: a 12px well padded by 6 holding
    // 8px rows, seated through a plain wrapper (the upgrade page's FAQ).
    {
      code: `const A = () => (
        <div className="surface-inset rounded-card p-1.5">
          {faq.map((f) => (
            <details key={f.q}>
              <summary className="rounded-control hover:bg-accent">x</summary>
            </details>
          ))}
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // Under the concentric pair, a child that states its own radius is checked.
    {
      code: `const A = () => (
        <div className="nest-menu nest-p-1">
          <div className="rounded-control bg-accent">x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // A recipe hoisted into a module constant is still a literal parent.
    {
      code: `const WELL = "surface-inset rounded-card p-1.5";
      const A = () => (
        <div className={cn(WELL, "mt-2")}>
          <a className="rounded-control hover:bg-accent">x</a>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // A key seated in a floating bar is a nested box however narrow it is,
    // and a Button carries its radius in its own source.
    {
      code: `const A = () => (
        <div className="rounded-menu p-1">
          <Button variant="ghost" size="sm" className="h-7 px-2">x</Button>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // Through `.map()`, which is how the thinking-effort slider hid for so long.
    {
      code: `const A = () => (
        <div className="rounded-control bg-secondary p-0.5">
          {options.map((o) => (
            <button key={o.v} className="flex-1 rounded-sm bg-card">{o.label}</button>
          ))}
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // A radius that only appears in one arm of a ternary is still declared.
    {
      code: `const A = () => (
        <div className="rounded-card p-2">
          <div className={cn("h-full", on && "rounded-xs bg-white")}>x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // 12 − 10 = 2, which IS a rung, so this still names one.
    {
      code: `const A = () => (
        <div className="rounded-card p-2.5">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // 16 − 1 = 15, which is not. The rule asks a human rather than inventing a
    // rung or rounding silently to the nearest one.
    {
      code: `const A = () => (
        <div className="rounded-panel p-px">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offLadder" }],
    },
  ],
});
