"use client";

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

// Time-of-day greeting buckets. Each hour range has a few phrases so the welcome
// feels fresh — and every phrase has to survive two readings: alone, and with
// ", <name>" appended in italic serif. Nothing that overclaims the hour (no
// "bright and early" at 11:40) and nothing saccharine; the 0–5 bucket is the one
// allowed real personality, because nobody is at a 3am composer by accident.
const TIME_GREETINGS: { from: number; to: number; phrases: string[] }[] = [
  { from: 0, to: 5, phrases: ["Still going", "Moonlight chat", "Up late", "The small hours"] },
  { from: 5, to: 12, phrases: ["Good morning", "Morning", "A fresh page", "Back at it"] },
  { from: 12, to: 18, phrases: ["Good afternoon", "Afternoon", "What's next", "Onward"] },
  { from: 18, to: 24, phrases: ["Good evening", "Evening", "Settling in", "Winding down"] },
];

function pickGreeting(): string {
  const now = new Date();
  const h = now.getHours();
  const bucket = TIME_GREETINGS.find((b) => h >= b.from && h < b.to) ?? TIME_GREETINGS[2];
  // A clock-keyed rotation, not Math.random(). Random would re-roll on every
  // mount — each new chat a slot machine — and would guarantee a visible text
  // swap at hydration, since the server's roll can never match the client's.
  // Keyed to (day + hour) the pick walks the pool as the day moves and shifts
  // by one at the same hour tomorrow, so it is fresh across sittings and still
  // deterministic within one.
  const day = now.getFullYear() * 372 + now.getMonth() * 31 + now.getDate();
  return bucket.phrases[(day + h) % bucket.phrases.length];
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
  // The pick is deterministic per clock (see pickGreeting), so both passes
  // agree whenever server and visitor read the same hour and date. The effect
  // still runs because the SERVER reads UTC and the client the visitor's own
  // clock: anyone whose timezone has crossed a bucket (or date) boundary would
  // otherwise be greeted with the wrong time of day until they navigate.
  const [phrase, setPhrase] = React.useState(() => pickGreeting());
  React.useEffect(() => setPhrase(pickGreeting()), []);

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
            "grid size-7 shrink-0 place-items-center rounded-full [animation-fill-mode:backwards] [animation-delay:60ms] motion-safe:animate-fade-in sm:size-8",
            popping && "juno-mark-popping",
          )}
        >
          <JunoMark
            className={cn(
              "block h-[1.4rem] w-[1.4rem] sm:h-[1.75rem] sm:w-[1.75rem]",
              "transition-transform duration-base ease-out-strong motion-reduce:transition-none",
              !popping && "motion-safe:hover:-rotate-6 motion-safe:hover:scale-110",
            )}
          />
        </button>
      </div>
      <h1
        className="empty-greeting text-center font-serif text-[1.95rem] font-normal leading-[1.15] tracking-[-0.025em] sm:text-[2.45rem]"
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
      <h1 className="font-serif text-[1.65rem] font-normal leading-[1.15] tracking-[-0.025em] sm:text-[2rem]">
        You&apos;re incognito
      </h1>
      <p className="max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
        Chats aren&apos;t saved, added to memory, or used to train models.
      </p>
    </div>
  );
}
