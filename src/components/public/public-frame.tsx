import { PublicThemeToggle } from "./theme-toggle";
import { ContinuumMark } from "@/components/brand/continuum-mark";
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
    <PublicFrame className="alevr-public-state">
      <header className="alevr-access-header"><PublicBrand /><PublicThemeToggle /></header>
      <main className="alevr-state-layout">
        <div className="alevr-state-identifier" aria-hidden="true">
          {code ? <span>{code}</span> : <ContinuumMark size={132} />}
        </div>
        <div className="alevr-state-copy">
          {code && <p className="sr-only">Error {code}</p>}
          <h1 className="font-serif">{title}</h1>
          <p className="mt-6 max-w-md text-pretty text-body-lg leading-relaxed text-muted-foreground">{description}</p>
          {children && <div className="alevr-state-actions mt-9 flex flex-wrap items-center gap-3">{children}</div>}
        </div>
      </main>
      <footer className="alevr-state-footer text-ui text-muted-foreground"><span>Go further.</span><Link href="/" className="inline-flex min-h-11 items-center rounded-lg hover:text-foreground">Alevr home</Link></footer>
    </PublicFrame>
  );
}
