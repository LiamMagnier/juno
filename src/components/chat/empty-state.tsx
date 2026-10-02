"use client";

import { useApp } from "@/components/app/app-provider";
import { IncognitoGlyph } from "@/components/chat/incognito-glyph";

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
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-foreground text-background">
        <IncognitoGlyph className="size-7" strokeWidth={1.5} />
      </span>
      <div className="flex flex-col items-center gap-1.5">
        <h1 className="font-serif text-page-title font-normal text-foreground">Incognito chat</h1>
        <p className="max-w-md text-body text-muted-foreground">
          This chat won&apos;t appear in your history, won&apos;t be added to memory, and isn&apos;t used to train models.
        </p>
      </div>
    </div>
  );
}
