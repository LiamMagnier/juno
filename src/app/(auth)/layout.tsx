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
          one step between the marketing page and the app, so it is lit the same
          way as both. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_40%_at_50%_0%,hsl(var(--primary)/0.09),transparent_72%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(hsl(var(--foreground)/0.05)_0.7px,transparent_0.8px)] [background-size:24px_24px] [mask-image:radial-gradient(70%_60%_at_50%_35%,black,transparent)]"
      />
      {/* Layered entrance: mark + wordmark → card → fine print → legal nav, on
          the `loose` stagger rung. */}
      <Link
        href="/"
        style={staggerDelay(0, "loose")}
        className="mb-7 flex flex-col items-center gap-2.5 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-safe:animate-fade-in [animation-fill-mode:backwards] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <JunoMark className="size-10" />
        <AsciiWordmark />
      </Link>
      {/* The card: `surface-raised-lg` at the panel rung (20) — the same
          material and corner as a dialog, which is what a centred card on a
          full-screen ground is. The recipe carries its own hairline and its own
          per-theme throw, so nothing is hand-written for the dark ground. */}
      <main
        style={staggerDelay(1, "loose")}
        className="surface-raised-lg w-full max-w-[24rem] rounded-panel p-6 motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:p-7"
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
