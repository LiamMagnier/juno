import { PublicThemeToggle } from "@/components/public/theme-toggle";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingPhoneMenu } from "@/components/landing/phone-menu";
import { LandingColumn } from "@/components/landing/section";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The public site's chrome: one bar and one footer for every page a signed-out
 * visitor can read (landing, download, legal, engineering), so moving between
 * them feels like one site instead of four templates.
 *
 * The bar is transparent at rest and takes the page ground over a blur with one
 * hairline once content scrolls under it (landing-header.tsx). On the landing
 * the section links are in-page anchors; everywhere else they point back at the
 * landing's sections.
 */

/**
 * English labels over the French route slugs on purpose: the slugs are the
 * legal pages' canonical URLs (operated from France), while every other word
 * in the chrome is English. `lang="fr"` tells assistive tech what is on the
 * other side.
 */
const LEGAL_LINKS = [
  { href: "/legal/confidentialite", label: "Privacy" },
  { href: "/legal/cgu", label: "Terms" },
  { href: "/legal/mentions-legales", label: "Legal notice" },
];

const PRODUCT_LINKS = [
  { href: "/sign-in", label: "Sign in" },
  { href: "/sign-up", label: "Create account" },
  // A page, not a file: /download reports what is actually published.
  { href: "/download", label: "Download" },
];

/**
 * The address the product already sends from (src/lib/email.ts, `EMAIL_FROM`
 * with the same default), so Contact and Support go where a reply to any Juno
 * email would.
 */
const CONTACT_EMAIL = (process.env.EMAIL_FROM ?? `${PRODUCT_NAME} <hello@chat.liams.dev>`).replace(/^.*<|>\s*$/g, "").trim();

/**
 * No Status link: there is no status page. The roadmap lives behind the
 * sign-in wall, so `?next=` makes the redirect intentional.
 */
const COMPANY_LINKS = [
  { href: "/engineering/file-understanding", label: `How ${PRODUCT_NAME} reads files` },
  { href: `mailto:${CONTACT_EMAIL}`, label: "Contact" },
  { href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${PRODUCT_NAME} support`)}`, label: "Support" },
  { href: "/sign-in?next=/roadmap", label: "Changelog & roadmap" },
];

const SECTIONS = [
  { id: "metering", label: "Metering" },
  { id: "apps", label: "Apps" },
  { id: "features", label: "Features" },
  { id: "pricing", label: "Pricing" },
];

/** `py-1` lifts the 15px line box to the 24px target SC 2.5.8 asks for. */
const FOOTER_LINK =
  "block w-fit rounded-xs py-1 text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground";

const LOGO_LOCKUP =
  "pressable inline-flex items-center gap-2.5 rounded-control motion-reduce:transition-none motion-reduce:active:scale-100";

export function SiteHeader({ onLanding = false }: { onLanding?: boolean }) {
  const links = SECTIONS.map(({ id, label }) => ({ href: onLanding ? `#${id}` : `/#${id}`, label }));
  return (
    <LandingHeader>
      <LandingColumn contentClassName="flex items-center justify-between gap-3 py-2.5">
        <Link href="/" aria-label={`${PRODUCT_NAME} home`} className={`${LOGO_LOCKUP} min-h-11`}>
          <AlevrLockup height={26} decorative />
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-0.5 lg:flex">
          {links.map(({ href, label }) => (
            <Button key={href} asChild variant="ghost" size="sm" className="text-muted-foreground">
              <a href={href}>{label}</a>
            </Button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <PublicThemeToggle />
          <nav aria-label="Account" className="hidden items-center gap-2 sm:flex">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link href="/sign-up">Create account</Link>
            </Button>
          </nav>
          {/* The compact menu keeps both navigation and returning-user access. */}
          <LandingPhoneMenu links={[...links, { href: "/sign-in", label: "Sign in" }, { href: "/sign-up", label: "Create account" }]} />
        </div>
      </LandingColumn>
    </LandingHeader>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60">
      <LandingColumn contentClassName="py-12">
        <div className="flex flex-col justify-between gap-10 sm:flex-row">
          <div>
            <Link href="/" aria-label={`${PRODUCT_NAME} home`} className={LOGO_LOCKUP}>
              <AlevrLockup height={24} decorative />
            </Link>
            <p className="mt-3 max-w-xs text-body text-muted-foreground">
              Conversation. Agents. Code. Go further.
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-6 text-body sm:grid-cols-3">
            <FooterColumn title="Product">
              {PRODUCT_LINKS.map(({ href, label }) => (
                <Link key={href} href={href} className={FOOTER_LINK}>
                  {label}
                </Link>
              ))}
            </FooterColumn>
            <FooterColumn title="Company">
              {COMPANY_LINKS.map(({ href, label }) =>
                href.startsWith("mailto:") ? (
                  <a key={label} href={href} className={FOOTER_LINK}>
                    {label}
                  </a>
                ) : (
                  <Link key={label} href={href} className={FOOTER_LINK}>
                    {label}
                  </Link>
                )
              )}
            </FooterColumn>
            <FooterColumn title="Legal">
              {LEGAL_LINKS.map(({ href, label }) => (
                <Link key={href} href={href} lang="fr" className={FOOTER_LINK}>
                  {label}
                </Link>
              ))}
            </FooterColumn>
          </nav>
        </div>
        <p className="mt-10 border-t border-border/60 pt-6 text-caption text-muted-foreground">
          © {new Date().getFullYear()}{` ${PRODUCT_NAME}. Go further.`}
        </p>
      </LandingColumn>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-ui font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}
