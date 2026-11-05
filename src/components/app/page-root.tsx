import type { ReactElement } from "react";

/**
 * The plain element a `page.tsx` puts between Next and the client component it
 * renders as the page's root. It draws nothing: `display: contents` gives it no
 * box, so the client root lays out exactly as if it were the page's root itself.
 *
 *   export default function ThreadDevPage() {
 *     return (
 *       <PageRoot>
 *         <ThreadScene />
 *       </PageRoot>
 *     );
 *   }
 *
 * WHY IT EXISTS. React bug facebook/react#35518 ("[Fiber] fix useId tracking
 * on replay"), still present in the React that Next 15.5 bundles. Next puts the
 * page in a list: `[SegmentTrieNode, page]` in development (`SegmentViewNode`)
 * and `[page, layerAssets, OutletBoundary]` in production. A client component at
 * that position arrives as a lazy reference, and when its chunk is still loading
 * as hydration reaches it, React waits and replays that fiber. The replay resets
 * the fiber's flags and drops the one that marks "this child is in a list", so
 * every `useId` below the page comes out different from the server's: the
 * intermittent "A tree hydrated but some attributes of the server rendered HTML
 * didn't match" warning (Radix `id`s, SVG `<mask id>`s). With this element in
 * the list instead, the item there is a host element that never waits for a
 * chunk, and the client component below it is an only child, which has no list
 * position for the replay to lose.
 *
 * THREE RULES, all checked by tests/page-root-hydration.test.ts:
 *  - It stays a server component: no "use client", no hooks. Flight erases it,
 *    so what reaches the browser is the `<div>` alone. As a client component it
 *    would be one more lazy reference in the very position it is meant to fill.
 *  - It wraps exactly one element (the `children` type says so): two children
 *    would be a list again.
 *  - Every `page.tsx` and `layout.tsx` that is not itself "use client" and
 *    whose root is a client component wraps that root in it, and every client
 *    component in a list below a root is wrapped or reviewed there.
 *
 * A `layout.tsx` whose root is a client component is in the same position
 * (`[layerAssets, layout]`) and takes the same wrapper; `(app)/layout.tsx`,
 * whose root is `<AppProvider>`, is one.
 *
 * Below the root, a client component that is one of several children (of a
 * host element, a fragment, or a client component), or an item of an array,
 * is in a list too. Where `useId` values below it reach the HTML (Radix
 * `aria-controls`, `<mask id>`), it takes the same wrapper:
 *
 *   <CustomizeFrame current="instructions">
 *     <AppPageHeader … />
 *     <PageRoot>
 *       <PersonalizationSection variant="page" />
 *     </PageRoot>
 *   </CustomizeFrame>
 *
 * The box it does not draw also takes no margin, so it is not for a child of
 * a `space-y-*` stack, whose gap is a margin on each child.
 *
 * Remove it, and the test, once Next ships a React with the fix (Next 16.2+).
 */
export function PageRoot({ children }: { children: ReactElement }) {
  return (
    <div className="contents" data-page-root="">
      {children}
    </div>
  );
}
