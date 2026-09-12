import test from "node:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import designSystem from "../eslint-rules/design-system.mjs";

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

ruleTester.run("concentric-radius", rule as never, {
  valid: [
    // The segmented track, which was already right: 14 − 4 = 10.
    {
      code: `const A = () => (
        <div className="rounded-menu p-1">
          <span className="rounded-control bg-card">x</span>
        </div>
      )`,
    },
    // The dropdown shell: 16 − 6 = 10.
    {
      code: `const A = () => (
        <div className="rounded-popover p-1.5">
          <div className="rounded-control bg-accent">x</div>
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
    // The Library file tile, exactly as it was.
    {
      code: `const A = () => (
        <Card className="p-3">
          <div className="surface-inset aspect-square overflow-hidden rounded-field" />
        </Card>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // The same shape written literally rather than through the component.
    {
      code: `const A = () => (
        <div className="rounded-card p-3">
          <div className="rounded-control bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // Through `.map()`, which is how the thinking-effort slider hid for so long.
    {
      code: `const A = () => (
        <div className="rounded-control bg-secondary p-0.5">
          {options.map((o) => (
            <button key={o.v} className="flex-1 rounded-xs bg-card">{o.label}</button>
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
    // 16 − 14 = 2, which IS a rung, so this still names one.
    {
      code: `const A = () => (
        <div className="rounded-card p-3.5">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offCentre" }],
    },
    // 16 − 1 = 15, which is not. The rule asks a human rather than inventing a
    // rung or rounding silently to the nearest one.
    {
      code: `const A = () => (
        <div className="rounded-card p-px">
          <div className="rounded-field bg-card">x</div>
        </div>
      )`,
      errors: [{ messageId: "offLadder" }],
    },
  ],
});
