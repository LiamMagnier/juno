"use client";

import { useApp } from "@/components/app/app-provider";

/**
 * The home's one line (V3 gallery, home scene): upright Newsreader at its
 * display size, regular weight, no italic name and no entrance animation
 * (D-027). It rests on the composer from above; what to do is the composer.
 */
export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex w-full max-w-2xl flex-col items-center">
      <h1 className="chat-home__title text-balance text-center font-serif font-normal text-foreground">
        What’s next{firstName ? <>, <span>{firstName}</span></> : null}?
      </h1>
    </div>
  );
}

/** Private-mode empty header — same type scale as the normal greeting, no
 *  decoration, and, like it, no entrance animation, so switching modes swaps
 *  one still headline for another. */
export function PrivateGreeting() {
  return (
    <div className="flex w-full flex-col items-center gap-2 text-center">
      <h1 className="font-sans text-page-title">
        You&apos;re incognito
      </h1>
      {/* On the scale, not Tailwind's stock rungs: `text-body` is the same 24px
          line box `text-sm leading-6` was building by hand, and `body-lg` is the
          rung `text-base` was standing next to. */}
      <p className="max-w-md text-body-lg text-muted-foreground">
        Chats aren&apos;t saved, added to memory, or used to train models.
      </p>
    </div>
  );
}
