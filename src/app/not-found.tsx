/**
 * The root 404 — everything that is not a known route, signed in or not.
 *
 * Without this file an unknown URL fell through to Next's built-in page:
 * Helvetica, pure white, a vertical rule, no Juno type, ground or mark. It was
 * the one screen in the product that looked like a framework default, and it is
 * ten seconds away from the address bar.
 *
 * It renders under the ROOT layout, so fonts, theme and tokens are live but
 * there is no sidebar. That is deliberate: a 404 can be hit signed out. The two
 * actions therefore point at routes that will bounce an anonymous visitor to
 * sign-in, which is the right destination for them anyway — we do not read the
 * session here, because `not-found.tsx` may not be async.
 *
 * tone stays the default "empty", not "error": a 404 is not a failure, it is a
 * page that is genuinely not there. Same reading as
 * `src/app/(app)/chat/[id]/not-found.tsx`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { JunoMark } from "@/components/brand/logo";
import { Plate } from "@/components/landing/plate";

export const metadata: Metadata = { title: "Not found" };

/**
 * The presentation: the sea horizon in a small frame (the front door's own
 * art, so a dead link still looks like Juno), a serif line and two actions.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      {/* Settles in on the shared entrance: this is a whole-screen
          replacement, where a hard cut reads as the site breaking. */}
      <div className="flex w-full max-w-md flex-col items-center motion-safe:animate-rise-in">
        <div className="stage relative flex aspect-[16/10] w-full max-w-xs items-center justify-center rounded-stage">
          <Plate name="horizon" dim sizes="320px" imageClassName="object-[50%_60%]" />
          <span className="relative flex size-14 items-center justify-center rounded-card bg-card/85 shadow-sm backdrop-blur">
            <JunoMark className="size-7" />
          </span>
        </div>
        <h1 className="mt-8 text-balance font-serif text-display font-medium tracking-tight">This page isn&rsquo;t here</h1>
        <p className="mt-3 max-w-sm text-pretty text-body text-muted-foreground">
          The link may be out of date, or the address may have a typo in it. Nothing in your account has changed.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link href="/chat">Back to chat</Link>
          </Button>
          <Button asChild variant="ghost" className="text-muted-foreground hover:text-foreground">
            <Link href="/">Go to the home page</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
