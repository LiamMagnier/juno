import Link from "next/link";
import { ArrowLeft } from "@/components/ui/icons";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { JunoMark } from "@/components/brand/logo";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { Plate } from "@/components/landing/plate";
import { LABS } from "@/components/landing/lab-marquee";
import { staggerDelay } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The three legal documents, labelled in English like the landing footer
 * (landing-page.tsx explains why). The slugs stay French: they are the
 * documents' canonical URLs, and `lang="fr"` tells assistive tech what it will
 * find on the other side.
 */
const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Privacy" },
  { href: "/legal/cgu", label: "Terms" },
  { href: "/legal/mentions-legales", label: "Legal notice" },
];

const LEGAL_LINK =
  "rounded-xs transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The inline links in the consent line: the same recipe /upgrade uses for the same sentence. */
const CONSENT_LINK =
  "rounded-xs underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

/** The labs named on the art panel: a taste of the picker, not the picker. */
const PANEL_LABS = LABS.slice(0, 6);

/**
 * Sign in, sign up, forgot and reset password.
 *
 * Two halves on a wide screen: the form on the page ground (no card around it;
 * the fields carry their own material and a box around a box was the old
 * template look), and a painted panel holding one sentence about the product.
 * On a phone the painting becomes a short band above the form, so the first
 * thing on screen is still the brand and the field is one thumb-reach down.
 *
 * Entrance: brand, form, fine print, on the `loose` stagger rung; the panel
 * fades in with the form. All of it collapses under reduced motion.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="relative flex min-h-dvh flex-col">
        {/* Phone band: the same plate as the wide panel, cropped to a strip. */}
        <div className="relative h-36 overflow-hidden lg:hidden">
          <Plate name="path" dim priority sizes="100vw" imageClassName="object-[50%_35%]" />
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
        </div>

        <header className="flex items-center justify-between px-6 pt-5 sm:px-10 lg:pt-8">
          <Link
            href="/"
            aria-label={`${PRODUCT_NAME} home`}
            style={staggerDelay(0, "loose")}
            className="pressable inline-flex items-center gap-2.5 rounded-control motion-safe:animate-fade-in [animation-fill-mode:backwards] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <JunoMark className="size-7" />
            <AsciiWordmark />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-xs text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {`Back to ${PRODUCT_NAME}`}
          </Link>
        </header>

        <main
          style={staggerDelay(1, "loose")}
          className="mx-auto flex w-full max-w-[25rem] flex-1 flex-col justify-center px-6 py-10 motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:px-0"
        >
          {children}
        </main>

        <footer
          style={staggerDelay(2, "loose")}
          className="px-6 pb-6 text-center motion-safe:animate-fade-in [animation-fill-mode:backwards] sm:px-10 lg:pb-8"
        >
          <p className="mx-auto max-w-sm text-caption text-muted-foreground">
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
          <nav
            aria-label="Legal"
            className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-caption text-muted-foreground"
          >
            {LEGAL_LINKS.map(({ href, label }) => (
              // py-1.5 lifts the 11px line box to the 24px target SC 2.5.8 asks for.
              <Link key={href} href={href} lang="fr" className={`${LEGAL_LINK} py-1.5`}>
                {label}
              </Link>
            ))}
          </nav>
        </footer>
      </div>

      {/* The art panel: inset from the window edge by the gutter, so it reads
          as a framed picture rather than a half-screen background. */}
      <aside aria-hidden className="hidden p-3 lg:block">
        <div className="stage sticky top-3 flex h-[calc(100dvh-1.5rem)] flex-col justify-end rounded-stage motion-safe:animate-fade-in">
          <Plate name="path" dim priority sizes="55vw" imageClassName="object-[50%_60%]" />
          <div className="relative m-4 rounded-panel bg-card/75 p-6 backdrop-blur-xl backdrop-saturate-150 xl:m-6 xl:p-7">
            <p className="max-w-md text-balance font-serif text-title font-medium text-foreground">
              Every frontier model in one calm place, with the cost of each answer in plain sight.
            </p>
            <ul className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2.5">
              {PANEL_LABS.map(({ provider, label, model }) => (
                <li key={provider} className="inline-flex items-center gap-1.5 text-ui text-foreground/75">
                  <ProviderLogo provider={provider} label={label} className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{model}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    </div>
  );
}
