import Image from "next/image";
import Link from "next/link";
import { PublicThemeToggle } from "@/components/public/theme-toggle";
import { PublicBrand, PublicFrame } from "@/components/public/public-frame";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-auth flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-h-dvh flex-col">
        <header className="alevr-auth-header flex items-center justify-between gap-4 px-6 py-5 sm:px-10 lg:px-12 lg:py-7">
          <PublicBrand height={28} />
          <div className="flex items-center gap-3">
            <Link href="/" className="rounded-lg py-3 text-ui text-muted-foreground hover:text-foreground">Back to home</Link>
            <PublicThemeToggle />
          </div>
        </header>
        <div className="alevr-auth-mobile-art relative mx-6 h-36 overflow-hidden rounded-menu bg-[#18191b] sm:mx-10 lg:hidden" aria-hidden="true">
          <Image src="/brand/home-horizon-dark.webp" alt="" fill priority fetchPriority="high" sizes="(max-width:1023px) 100vw, 1px" className="object-cover object-[50%_65%]" />
          <p className="absolute inset-x-0 bottom-0 bg-[#18191b] px-6 py-3 font-serif text-title font-medium text-[#e8e9eb]">Go further.</p>
        </div>
        <main className="alevr-auth-form mx-auto flex w-full max-w-[28rem] flex-1 flex-col justify-center px-6 py-10 sm:px-8 lg:py-12">{children}</main>
        <footer className="alevr-auth-footer px-6 pb-6 text-center text-caption leading-relaxed text-muted-foreground sm:px-10 lg:pb-8">
          <p className="mx-auto max-w-sm">
            By continuing you accept the <Link href="/legal/cgu" lang="fr" className="underline underline-offset-4">terms of service</Link> and the <Link href="/legal/confidentialite" lang="fr" className="underline underline-offset-4">privacy policy</Link>.
          </p>
          <nav aria-label="Legal" className="mt-3 flex flex-wrap justify-center gap-x-5">
            <Link href="/legal/confidentialite" lang="fr" className="py-2 hover:text-foreground">Privacy</Link>
            <Link href="/legal/cgu" lang="fr" className="py-2 hover:text-foreground">Terms</Link>
            <Link href="/legal/mentions-legales" lang="fr" className="py-2 hover:text-foreground">Legal notice</Link>
          </nav>
        </footer>
      </div>
      <aside className="hidden p-2 pl-0 lg:block" aria-label="Go further with Alevr">
        <div className="alevr-auth-art relative sticky top-2 h-[calc(100dvh-16px)] min-h-[36rem] overflow-hidden rounded-menu bg-[#18191b] text-[#e8e9eb]">
          <Image src="/brand/home-horizon-dark.webp" alt="" fill priority fetchPriority="high" sizes="50vw" className="alevr-auth-image object-cover object-[60%_50%]" />
          <div className="absolute inset-x-0 bottom-0 bg-[#18191b] px-10 pb-12 pt-6 xl:px-14 xl:pb-14">
            <p className="alevr-auth-art-title font-serif text-hero font-medium tracking-tight">Go further.</p>
            <p className="alevr-auth-art-copy mt-4 max-w-sm text-body leading-relaxed text-[#b4b6ba]">A calm place to think, make something, and carry your work forward.</p>
          </div>
        </div>
      </aside>
    </PublicFrame>
  );
}
