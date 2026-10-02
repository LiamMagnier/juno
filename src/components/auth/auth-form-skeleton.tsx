/** A provider-aware placeholder with the exact control height of the form. */
export function AuthFormSkeleton({ mode, googleEnabled = false, appleEnabled = false, emailLinkEnabled = false }: { mode: "signin" | "signup"; googleEnabled?: boolean; appleEnabled?: boolean; emailLinkEnabled?: boolean }) {
  return (
    <div className="space-y-5" role="status" aria-label="Loading the form">
      {[googleEnabled, appleEnabled].map((enabled, i) => enabled && <div key={i} className="skeleton h-11 w-full rounded-lg" aria-hidden />)}
      {(googleEnabled || appleEnabled) && <div className="flex h-5 items-center gap-3" aria-hidden><span className="h-px flex-1 bg-border/60" /><span className="skeleton h-2.5 w-6 rounded-micro" /><span className="h-px flex-1 bg-border/60" /></div>}
      <div className="space-y-4" aria-hidden>
        {(mode === "signup" ? [0, 1, 2] : [0, 1]).map(i => <div key={i} className="space-y-2"><div className="skeleton h-5 w-16 rounded-micro" /><div className="skeleton h-11 w-full rounded-lg" /></div>)}
        <div className="skeleton h-11 w-full rounded-lg" />
      </div>
      {emailLinkEnabled && <div className="skeleton h-11 w-full rounded-lg" aria-hidden />}
      <div className="skeleton mx-auto h-5 w-44 rounded-micro" aria-hidden />
    </div>
  );
}
