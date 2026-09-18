/**
 * The app group's fallback, for the segments that do not ship one of their own.
 *
 * Chat and Code each have their own `loading.tsx` tuned to the shape they are
 * about to draw. Everything else in this group — Library, Projects, Artifacts,
 * Skills' children, Settings' routes — had nothing, so a navigation to one of
 * them held the previous page on screen with no sign that anything was
 * happening, and then swapped it whole. Next needs a boundary here to stream at
 * all; this is that boundary.
 *
 * Deliberately shapeless: a page-sized pulse rather than a guess at a layout.
 * A skeleton that predicts the wrong structure is worse than one that predicts
 * none, because the correction reads as the page breaking.
 */
export default function AppGroupLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-7 w-48 rounded-control" />
      <div className="mt-6 space-y-2.5">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="skeleton h-9 rounded-control"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
