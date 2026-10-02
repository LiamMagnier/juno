import Image from "next/image";
import Link from "next/link";
import { PublicThemeToggle } from "@/components/public/theme-toggle";
import { PublicBrand, PublicFrame } from "@/components/public/public-frame";

/** One focused access surface. The material study is secondary to the form,
 * and collapses away on phones so returning users reach the fields immediately. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-auth">
      <header className="alevr-access-header">
        <PublicBrand height={28} />
        <div className="flex items-center gap-4">
          <Link href="/" className="inline-flex min-h-11 items-center rounded-lg text-ui text-muted-foreground hover:text-foreground">Back to home</Link>
          <PublicThemeToggle />
        </div>
      </header>
      <div className="alevr-access-layout">
        <aside className="alevr-access-story" aria-hidden="true">
          <div className="alevr-access-material" aria-hidden="true">
            <Image src="/brand/home-continuity.webp" alt="" fill sizes="(max-width:1023px) 1px, 25vw" className="object-cover" />
          </div>
        </aside>
        <main className="alevr-auth-form">{children}</main>
      </div>
      <footer className="alevr-access-footer text-caption leading-relaxed text-muted-foreground">
        <p className="max-w-sm">By continuing you accept the <Link href="/legal/cgu" lang="fr" className="underline underline-offset-4">terms of service</Link> and the <Link href="/legal/confidentialite" lang="fr" className="underline underline-offset-4">privacy policy</Link>.</p>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6">
          <Link href="/legal/confidentialite" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Privacy</Link>
          <Link href="/legal/cgu" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Terms</Link>
          <Link href="/legal/mentions-legales" lang="fr" className="inline-flex min-h-11 items-center hover:text-foreground">Legal notice</Link>
        </nav>
      </footer>
    </PublicFrame>
  );
}
