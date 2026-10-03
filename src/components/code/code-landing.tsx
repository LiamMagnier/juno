import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { CodeComposer } from "@/components/code/code-composer";
import type { CodePrefill } from "@/lib/code-prefill";
import { BRAND } from "@/lib/brand/names";
import { HomeField } from "@/components/chat/empty-state";

/**
 * The Code landing's column: Alevr Code's lockup, the entry question and the
 * composer, centred together (see the notes on `/code`, app/(app)/code/page.tsx).
 * A component of its own so /dev/pages can draw the real landing signed out.
 */
export function CodeLanding({ prefill }: { prefill: CodePrefill }) {
  return (
    // `overflow-x-clip` for the same reason the chat greeting has it: nothing
    // in this column may put a horizontal scrollbar over dead space, and the
    // composer's focus ring is wider than the box it belongs to.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-clip">
      {/*
        ONE CENTRED BLOCK — the greeting and the field together, exactly as
        `/chat` composes the same two objects.
        
        This page used to give the greeting a third of the column and pin the
        composer to the floor, on an argument about where a line "lands". The
        argument was fine and the result was not: at 900px the two objects
        ended up 26% and 90% of the way down with six hundred pixels of
        nothing between them, and the page read as two unrelated things at
        opposite ends of a window rather than as a question and the place you
        answer it.
        
        It also contradicted this file's own docblock, which says `/chat` is
        "the same shape for the same reason" — it was not, and nobody noticed
        because the two landings are never on screen at once. They are now the
        same shape: `items-center justify-center`, the greeting, `mb-6
        sm:mb-8`, the field. Switching products no longer moves the composer
        two thirds of the way down the window.
        
        No `vh` anywhere, which was the one thing the old comment got right and
        is kept: a page inside this shell does not have the window
        (PREMIUM_AUDIT.md §3 rule 11), so the centring is the flex column's,
        not the viewport's.
      */}
      <div className="page-gutter mx-auto flex w-full max-w-[44rem] flex-1 flex-col items-center justify-center py-6 md:py-8">
        {/* Alevr Code's entry line (CODE_SYSTEM.md): the product's lockup at
            identity size, then the question. No name in italics, no hero. */}
        <p className="ed-rise mb-3 flex items-center gap-1.5 text-muted-foreground" style={{ ["--i" as string]: 0 }}>
          <AlevrLockup height={16} tone="muted" decorative />
          <span className="font-serif text-body leading-none">{BRAND.code.label}</span>
          <span className="sr-only">{BRAND.code.title}</span>
        </p>
        <h1 className="chat-home__title ed-rise mb-6 text-balance text-center font-serif font-normal text-foreground sm:mb-8" style={{ ["--i" as string]: 1 }}>
          What will you build?
        </h1>
        {/* The chat home's construction, on the composer the same way: one
            drawing for both products' first screen. */}
        <div className="relative isolate w-full">
          <HomeField />
          <CodeComposer prefill={prefill} />
        </div>
      </div>
    </div>
  );
}
