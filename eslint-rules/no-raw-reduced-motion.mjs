/**
 * Reduced motion has three inputs (the OS, the in-app Motion choice, a
 * gallery's simulation) and one module that combines them,
 * `src/lib/motion-preference.ts`. Querying the media string directly reads
 * only the OS: the in-app Reduced and Full choices are silently ignored, which
 * is exactly how ~40 scripted animations drifted from the stylesheet.
 *
 * Reports `matchMedia("(prefers-reduced-motion…)")` and framer-motion's
 * `useReducedMotion` (also OS-only); the fix is `prefersReducedMotion()`,
 * `reducedMotionAt(el)`, `subscribeReducedMotion()` or `useReducedMotion()`
 * from `@/lib/motion-preference`.
 */
const MESSAGE =
  "Read reduced motion through @/lib/motion-preference (prefersReducedMotion, reducedMotionAt, subscribeReducedMotion, useReducedMotion): a raw query ignores the in-app Motion setting.";

const isMediaString = (node) =>
  node && ((node.type === "Literal" && typeof node.value === "string") || node.type === "TemplateLiteral") &&
  /prefers-reduced-motion/.test(node.type === "Literal" ? node.value : node.quasis.map((q) => q.value.raw).join(""));

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Read reduced motion through lib/motion-preference, never the raw media query." },
    schema: [],
    messages: { raw: MESSAGE },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : null;
        if (name === "matchMedia" && isMediaString(node.arguments[0])) context.report({ node, messageId: "raw" });
      },
      ImportDeclaration(node) {
        if (node.source.value !== "framer-motion") return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.imported.name === "useReducedMotion") context.report({ node: spec, messageId: "raw" });
        }
      },
    };
  },
};

export default rule;
