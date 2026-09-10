import Link from "next/link";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { JunoMark } from "@/components/brand/logo";
import { staggerDelay } from "@/lib/motion";

/**
 * The three legal documents, labelled in English like the landing footer
 * (landing-page.tsx explains why: every other word on these screens is
 * English, and three French labels in an English nav read as a localization
 * bug rather than as jurisdiction). The slugs stay French — they are the
 * documents' canonical URLs — and `lang="fr"` on each link tells assistive
 * tech what it will find on the other side.
 */
const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Privacy" },
  { href: "/legal/cgu", label: "Terms" },
  { href: "/legal/mentions-legales", label: "Legal notice" },
];

/** One treatment for the three legal links, so they cannot drift apart. */
const LEGAL_LINK =
  "rounded-xs transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The inline links in the consent line: the same recipe /upgrade uses for the same sentence. */
const CONSENT_LINK =
  "rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

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
      {/* The agreement, in the words /upgrade uses at the moment money changes
          hands: "use Juno responsibly" was a sentiment, not an acceptance of
          the terms — and the one screen that creates an account was the one
          that did not say what the account agreed to. */}
      <p
        style={staggerDelay(2, "loose")}
        className="mt-7 max-w-sm text-center text-caption text-muted-foreground motion-safe:animate-fade-in [animation-fill-mode:backwards]"
      >
        By continuing you accept the{" "}
        <Link href="/legal/cgu" lang="fr" className={CONSENT_LINK}>
          terms of service
        </Link>{" "}
        and the{" "}
        <Link href="/legal/confidentialite" lang="fr" className={CONSENT_LINK}>
          privacy policy
        </Link>
        . Your conversations are private to your account.
      </p>
      {/* No /80 on the ground colour: --muted-foreground is already tuned to the
          4.5:1 floor, and at 11px an extra 20% of transparency puts these three
          links under it with no large-text exemption to fall back on. */}
      <nav
        aria-label="Legal"
        style={staggerDelay(3, "loose")}
        className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-caption text-muted-foreground motion-safe:animate-fade-in [animation-fill-mode:backwards]"
      >
        {LEGAL_LINKS.map(({ href, label }, i) => (
          <span key={href} className="inline-flex items-center gap-2">
            {i > 0 && <span aria-hidden>·</span>}
            {/* py-1.5: the 11px line box alone is ~16px tall, under the 24px
                SC 2.5.8 asks of a target; the padding lifts the hit area
                without moving the text. */}
            <Link href={href} lang="fr" className={`${LEGAL_LINK} py-1.5`}>
              {label}
            </Link>
          </span>
        ))}
      </nav>
    </div>
  );
}
