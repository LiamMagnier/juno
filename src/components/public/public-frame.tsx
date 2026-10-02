import { PublicThemeToggle } from "./theme-toggle";
import Image from "next/image";
import Link from "next/link";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { PRODUCT_NAME } from "@/lib/brand/names";

export function PublicBrand({ height = 26 }: { height?: number }) {
  return (
    <Link href="/" aria-label={`${PRODUCT_NAME} home`} className="inline-flex min-h-11 items-center rounded-lg">
      <AlevrLockup height={height} decorative />
    </Link>
  );
}

/** Signed-out pages share the V3 ground, typography and quiet controls. */
export function PublicFrame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`alevr-public min-h-dvh bg-background text-foreground ${className}`}>{children}</div>;
}

export function PublicState({ title, description, code, children }: { title: string; description: string; code?: string; children?: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-public-state flex flex-col">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10"><PublicBrand /><PublicThemeToggle /></header>
      <main className="alevr-state-layout mx-auto w-full max-w-6xl flex-1 px-6 py-12 sm:px-10 sm:py-16">
        <div className="alevr-state-copy">
          {code && <p className="alevr-state-code mb-6 text-ui text-muted-foreground">{code}</p>}
          <h1 className="text-balance font-serif text-display font-medium tracking-tight sm:text-hero">{title}</h1>
          <p className="mt-5 max-w-md text-pretty text-body-lg leading-relaxed text-muted-foreground">{description}</p>
          {children && <div className="alevr-state-actions mt-8 flex flex-wrap items-center gap-3">{children}</div>}
        </div>
        <div className="alevr-state-image relative aspect-square overflow-hidden rounded-menu" aria-hidden="true">
          <Image src="/brand/home-continuity.webp" alt="" fill unoptimized sizes="(max-width:767px) 100vw, 40vw" className="object-cover" />
        </div>
      </main>
      <footer className="px-6 pb-6 text-center text-caption text-muted-foreground">Go further.</footer>
    </PublicFrame>
  );
}
