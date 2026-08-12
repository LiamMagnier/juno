import Link from "next/link";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { JunoMark } from "@/components/brand/logo";
import { staggerDelay } from "@/lib/motion";

/** One treatment for the three legal links, so they cannot drift apart. */
const LEGAL_LINK =
  "rounded-xs transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    // `isolate`: the two backdrop layers below sit at -z-10 and would otherwise
    // resolve against the root stacking context and paint behind this ground.
    <div className="relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10 sm:py-12">
      {/* The same two backdrop layers the landing hero wears — a faint coral wash
          and the CSS twin of DotField's resting frame. The sign-in screen is the
          one step between the marketing page and the app, and it was the only
          surface in the funnel rendering on a bare, unlit ground: the visitor
          crossed from a lit page to a flat one and back to a lit one. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_40%_at_50%_0%,hsl(var(--primary)/0.09),transparent_72%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(hsl(var(--foreground)/0.05)_0.7px,transparent_0.8px)] [background-size:24px_24px] [mask-image:radial-gradient(70%_60%_at_50%_35%,black,transparent)]"
      />
      {/* Layered entrance: mark + wordmark → card → fine print → legal nav.
          staggerDelay, not hand-written [animation-delay:60/180/240ms] — that was
          a 60/120/60 step pattern, so the one screen every account passes through
          did not hold a tempo, let alone the product's three-rung scale. */}
      <Link
        href="/"
        style={staggerDelay(0, "loose")}
        className="mb-7 flex flex-col items-center gap-2.5 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-safe:animate-fade-in [animation-fill-mode:backwards] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <JunoMark className="h-10 w-10" />
        <AsciiWordmark />
      </Link>
      {/* Full-strength `border-border`, plus a dark-only lit inset edge.
          `shadow-soft` on dark is `0 1px 2px hsl(0 0% 0% / 0.28)` — black ink on
          a black ground, i.e. nothing — so the card's whole separation collapsed
          to a damped /75 hairline over a 6.5% ground. Depth on black comes from
          the lightness ladder, a hairline, and a 1px INSET highlight, which is
          exactly what `.dark .composer-surface` does in globals.css. An outer
          light-coloured shadow here would be the halo the theme removed. */}
      <main
        style={staggerDelay(1, "loose")}
        className="w-full max-w-[24rem] rounded-surface border border-border bg-card p-6 shadow-soft motion-safe:animate-rise-in [animation-fill-mode:backwards] dark:shadow-[inset_0_1px_0_hsl(var(--sheen)),0_1px_2px_hsl(0_0%_0%/0.5),0_18px_44px_-30px_hsl(0_0%_0%/0.9)] sm:p-7"
      >
        {children}
      </main>
      <p
        style={staggerDelay(2, "loose")}
        className="mt-7 max-w-sm text-center text-caption text-muted-foreground motion-safe:animate-fade-in [animation-fill-mode:backwards]"
      >
        By continuing you agree to use Juno responsibly. Your conversations are private to your account.
      </p>
      {/* No /80 on the ground colour: --muted-foreground is already tuned to the
          4.5:1 floor, and at 11px an extra 20% of transparency puts these three
          links under it with no large-text exemption to fall back on. */}
      <nav
        aria-label="Legal"
        style={staggerDelay(3, "loose")}
        className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-caption text-muted-foreground motion-safe:animate-fade-in [animation-fill-mode:backwards]"
      >
        <Link href="/legal/confidentialite" className={LEGAL_LINK}>
          Confidentialité
        </Link>
        <span aria-hidden>·</span>
        <Link href="/legal/cgu" className={LEGAL_LINK}>
          CGU
        </Link>
        <span aria-hidden>·</span>
        <Link href="/legal/mentions-legales" className={LEGAL_LINK}>
          Mentions légales
        </Link>
      </nav>
    </div>
  );
}
