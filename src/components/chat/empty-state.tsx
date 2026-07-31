"use client";

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

// Time-of-day greeting buckets. Each hour range has a few phrases so the welcome
// feels fresh — including playful late-night ones (e.g. "Moonlight chat" at 3am).
const TIME_GREETINGS: { from: number; to: number; phrases: string[] }[] = [
  { from: 0, to: 5, phrases: ["Moonlight chat", "Burning the midnight oil", "Late-night thoughts", "The world's asleep", "Night owl mode", "Can't sleep?"] },
  { from: 5, to: 7, phrases: ["Rise and shine", "Early bird", "Up before the sun", "Dawn patrol"] },
  { from: 7, to: 12, phrases: ["Good morning", "Morning", "Bright and early", "Fresh start", "Rise and grind"] },
  { from: 12, to: 14, phrases: ["Good afternoon", "Midday check-in", "Lunch-hour thoughts"] },
  { from: 14, to: 18, phrases: ["Good afternoon", "Afternoon", "Hitting your stride", "Halfway there"] },
  { from: 18, to: 22, phrases: ["Good evening", "Winding down", "Evening", "Golden hour"] },
  { from: 22, to: 24, phrases: ["Good evening", "Late shift", "Still going", "Night owl"] },
];

function pickGreeting(random: boolean): string {
  const h = new Date().getHours();
  const bucket = TIME_GREETINGS.find((b) => h >= b.from && h < b.to) ?? TIME_GREETINGS[2];
  const idx = random ? Math.floor(Math.random() * bucket.phrases.length) : h % bucket.phrases.length;
  return bucket.phrases[idx];
}

/** The serif greeting + signature mark — sits above the centered composer.
 *
 *  Layout: three equal side columns (`1fr auto 1fr`). The text lives only in
 *  the middle, so it stays on the true screen center. The mark sits in the
 *  left column, end-aligned, so it flanks the text without shifting it — and
 *  never gets clipped the way an absolute `right-full` mark did inside the
 *  chat overflow container.
 */
export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.split(" ")[0];
  // Deterministic during SSR (stable hydration), then pick a random,
  // time-appropriate phrase once mounted on the client so it varies per visit.
  const [phrase, setPhrase] = React.useState(() => pickGreeting(false));
  React.useEffect(() => setPhrase(pickGreeting(true)), []);

  // The mark's press animation: retrigger the spring-pop keyframe per click.
  const [popping, setPopping] = React.useState(false);

  return (
    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
      <div className="flex items-center justify-end pr-[0.38em]">
        <button
          type="button"
          aria-label="Juno"
          onClick={() => setPopping(true)}
          onAnimationEnd={() => setPopping(false)}
          className={cn(
            // The GLYPH is 1.32rem (21px) at mobile size, which is the visual
            // weight the greeting wants. The TARGET must not be: WCAG 2.2 2.5.8
            // asks for 24x24 CSS px. grid + place-items keeps the mark exactly
            // where it was and grows only the hit area around it, so nothing
            // moves and the button becomes tappable.
            "grid size-6 shrink-0 place-items-center outline-none [animation-fill-mode:backwards] [animation-delay:60ms] motion-safe:animate-rise-in sm:size-8",
            popping && "juno-mark-popping",
          )}
        >
          <JunoMark
            className={cn(
              "block h-[1.32rem] w-[1.32rem] sm:h-[1.83rem] sm:w-[1.83rem]",
              "transition-transform duration-base ease-spring motion-reduce:transition-none",
              !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110",
            )}
          />
        </button>
      </div>
      <h1
        className="empty-greeting text-center font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]"
        suppressHydrationWarning
      >
        {/* The greeting and the name rise as two beats rather than one block.
            suppressHydrationWarning belongs HERE, not only on the <h1>: React
            does not apply it to deeply nested children, and this is the node
            whose text differs. The server picks its bucket from UTC and the
            client from the visitor's own clock, so any timezone that crosses a
            bucket boundary hydrates with different words — which is the whole
            point of the effect below, not a bug to fix. */}
        <span
          suppressHydrationWarning
          className="inline-block [animation-fill-mode:backwards] [animation-delay:60ms] motion-safe:animate-rise-in"
        >
          {phrase}
          {firstName ? "," : null}
        </span>
        {firstName ? (
          <>
            {" "}
            <span className="empty-greeting__name inline-block font-medium italic text-primary [animation-fill-mode:backwards] [animation-delay:180ms] motion-safe:animate-rise-in">
              {firstName}
            </span>
          </>
        ) : null}
      </h1>
      {/* Mirror column keeps the text cell on the true horizontal center. */}
      <div aria-hidden="true" />
    </div>
  );
}

/** Private-mode empty header — same type scale as the normal greeting, no decoration. */
export function PrivateGreeting() {
  return (
    <div className="flex w-full flex-col items-center gap-2 text-center">
      <h1 className="font-serif text-[1.7rem] font-normal leading-[1.12] tracking-tight sm:text-[2.35rem]">
        You&apos;re incognito
      </h1>
      <p className="max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
        Chats aren&apos;t saved, added to memory, or used to train models.
      </p>
    </div>
  );
}
