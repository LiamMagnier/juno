import Link from "next/link";
import { PublicThemeToggle } from "@/components/public/theme-toggle";
import { PublicBrand, PublicFrame } from "@/components/public/public-frame";
import { Construction } from "@/components/home/construction";

/**
 * Access: the form on the page ground, beside one charcoal panel that carries
 * the construction and the promise. The panel is the same deliberate dark
 * object as the homepage's Code slab. Phones drop it so the fields come first.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-auth alv">
      <div className="alv-access">
        <aside className="alv-access-panel">
          <PublicBrand height={26} tone="current" />
          <div className="alv-access-construction" aria-hidden="true"><Construction /></div>
          <div className="alv-access-promise" aria-hidden="true">
            <p className="alv-display">Go further.</p>
            <p>Chat, agents and code in one calm workspace.</p>
          </div>
        </aside>
        <div className="alv-access-main">
          <header className="alv-access-head">
            <PublicBrand height={24} className="alv-access-phone-brand" />
            <div className="flex items-center gap-4">
              <Link href="/" className="inline-flex min-h-11 items-center rounded-lg text-ui text-muted-foreground hover:text-foreground">Back to home</Link>
              <PublicThemeToggle />
            </div>
          </header>
          <main className="alevr-auth-form">{children}</main>
          <footer className="alv-access-foot text-caption leading-relaxed text-muted-foreground">
            <p className="max-w-sm">By continuing you accept the <Link href="/legal/cgu" lang="fr" className="underline underline-offset-4">terms of service</Link> and the <Link href="/legal/confidentialite" lang="fr" className="underline underline-offset-4">privacy policy</Link>.</p>
            <nav aria-label="Legal" className="flex flex-wrap gap-x-6">
              <Link href="/legal/confidentialite" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Privacy</Link>
              <Link href="/legal/cgu" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Terms</Link>
              <Link href="/legal/mentions-legales" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Legal notice</Link>
            </nav>
          </footer>
        </div>
      </div>
    </PublicFrame>
  );
}
