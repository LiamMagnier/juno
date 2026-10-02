import { PublicThemeToggle } from "./theme-toggle";
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

export function PublicState({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-public-state flex flex-col">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10"><PublicBrand /><PublicThemeToggle /></header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 pb-24 pt-12 text-center">
        <h1 className="text-balance font-serif text-display font-medium tracking-tight sm:text-hero">{title}</h1>
        <p className="mx-auto mt-5 max-w-md text-pretty text-body leading-relaxed text-muted-foreground">{description}</p>
        {children && <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{children}</div>}
      </main>
      <footer className="px-6 pb-6 text-center text-caption text-muted-foreground">Go further.</footer>
    </PublicFrame>
  );
}
