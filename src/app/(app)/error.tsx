"use client";

/**
 * Segment boundary for everything under the app shell. Catches a page that
 * throws *after* the layout rendered — a failed conversation load, a bad
 * bootstrap read — so the sidebar and chrome stay up and only the pane is
 * replaced. (Errors thrown by `(app)/layout.tsx` itself bubble past this to
 * `app/global-error.tsx`, which is why that fallback exists too.)
 */

import Link from "next/link";

import { JunoMark } from "@/components/brand/logo";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <JunoMark className="h-9 w-9 opacity-70" />
      <p className="mt-6 font-mono text-label text-muted-foreground">Something broke</p>
      <h1 className="mt-2 font-serif text-heading font-medium">This view couldn&rsquo;t load</h1>
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">
        Nothing was lost. Retry the view, or head back to your chats if it keeps failing.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2.5">
        <button
          type="button"
          onClick={reset}
          className="rounded-[10px] bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-foreground/85"
        >
          Try again
        </button>
        <Link
          href="/chat"
          className="rounded-[10px] border border-border/60 bg-card px-4 py-2 text-sm transition-colors hover:border-border"
        >
          Back to chats
        </Link>
      </div>
      {error.digest && <p className="mt-6 font-mono text-caption text-muted-foreground/70">Reference: {error.digest}</p>}
    </div>
  );
}
