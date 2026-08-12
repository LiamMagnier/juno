/**
 * The hydration placeholder for AuthForm.
 *
 * `<Suspense fallback={null}>` meant the sign-in and sign-up cards rendered as a
 * heading over empty space and then snapped to full height when the whole form
 * (Google button, divider, two fields, submit) arrived at once — the very first
 * render a new account sees, and a card that changes height under the cursor.
 *
 * The bars are sized to the real controls so the card's height is stable across
 * the swap: Button's default height, Input's `h-9 rounded-field`, and the same
 * `space-y-5` / `space-y-4` rhythm the form itself uses. It is aria-hidden with
 * a `status` role on the wrapper — a placeholder is an announcement that
 * something is coming, not content to read out.
 */
export function AuthFormSkeleton({ mode }: { mode: "signin" | "signup" }) {
  return (
    <div className="space-y-5" role="status" aria-label="Loading the form">
      <div className="skeleton h-9 w-full rounded-field coarse:h-11" aria-hidden />
      {/* The "or" divider's own row, so the swap does not shift the fields up. */}
      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-border/60" />
        <span className="skeleton h-2.5 w-6 rounded-micro" />
        <span className="h-px flex-1 bg-border/60" />
      </div>
      <div className="space-y-4" aria-hidden>
        {/* Sign-up carries a third field (Name); matching the count is the whole
            point of sizing the placeholder at all. */}
        {(mode === "signup" ? [0, 1, 2] : [0, 1]).map((i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton h-3 w-16 rounded-micro" />
            <div className="skeleton h-9 w-full rounded-field coarse:h-11" />
          </div>
        ))}
        <div className="skeleton h-9 w-full rounded-field coarse:h-11" />
      </div>
      <div className="skeleton mx-auto h-3 w-44 rounded-micro" aria-hidden />
    </div>
  );
}
