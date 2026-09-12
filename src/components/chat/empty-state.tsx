"use client";

import { useApp } from "@/components/app/app-provider";

export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex w-full max-w-2xl flex-col items-center px-4">
      <h1 className="text-balance text-center font-serif text-page-title font-normal text-foreground sm:text-display motion-safe:animate-rise-in">
        How can I help{firstName ? <>, <span className="italic">{firstName}</span></> : null}?
      </h1>
    </div>
  );
}

/** Private-mode empty header — same type scale as the normal greeting, no decoration. */
export function PrivateGreeting() {
  return (
    <div className="flex w-full flex-col items-center gap-2 text-center">
      <h1 className="font-sans text-title font-semibold leading-tight tracking-[-0.025em] sm:text-page-title">
        You&apos;re incognito
      </h1>
      {/* On the scale, not Tailwind's stock rungs: `text-body` is the same 24px
          line box `text-sm leading-6` was building by hand, and `body-lg` is the
          rung `text-base` was standing next to. */}
      <p className="max-w-md text-body text-muted-foreground sm:text-body-lg">
        Chats aren&apos;t saved, added to memory, or used to train models.
      </p>
    </div>
  );
}
