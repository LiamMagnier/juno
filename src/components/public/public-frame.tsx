import { PublicThemeToggle } from "./theme-toggle";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import Link from "next/link";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { BrandTone } from "@/components/brand/brand-tone";
import { Construction } from "@/components/home/construction";
import "@/components/home/alv-base.css";

export function PublicBrand({ height = 26, tone, className = "" }: { height?: number; tone?: BrandTone; className?: string }) {
  return (
    <Link href="/" aria-label={`${PRODUCT_NAME} home`} className={`inline-flex min-h-11 items-center rounded-lg ${className}`}>
      <AlevrLockup height={height} tone={tone} decorative />
    </Link>
  );
}

/** Signed-out pages share the V3 ground, typography and quiet controls. */
export function PublicFrame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`alevr-public min-h-dvh bg-background text-foreground ${className}`}>{children}</div>;
}

/**
 * Recovery and status pages (404, offline, gone links, computer entry). The
 * construction sits behind the message as it does behind the homepage hero, so
 * an error still looks like Alevr; the copy and the way back stay first.
 */
export function PublicState({ title, description, code, children }: { title: string; description: string; code?: string; children?: React.ReactNode }) {
  return (
    <PublicFrame className="alevr-public-state alv">
      <header className="alevr-access-header"><PublicBrand /><PublicThemeToggle /></header>
      <main className="alv-state">
        <div className="alv-state-construction" aria-hidden="true"><Construction ticks={false} /></div>
        <div className="alv-state-copy">
          <div className="alv-state-identifier alv-enter" aria-hidden="true">{code ? <span>{code}</span> : <ContinuumMark size={56} />}</div>
          {code && <p className="sr-only">Error {code}</p>}
          <h1 className="alv-display alv-enter" style={{ ["--i" as string]: 1 }}>{title}</h1>
          <p className="alv-lede alv-enter" style={{ ["--i" as string]: 2 }}>{description}</p>
          {children && <div className="alv-state-actions alv-enter" style={{ ["--i" as string]: 3 }}>{children}</div>}
        </div>
      </main>
      <footer className="alevr-state-footer text-ui text-muted-foreground"><span>Go further.</span><Link href="/" className="inline-flex min-h-11 items-center rounded-lg hover:text-foreground">Alevr home</Link></footer>
    </PublicFrame>
  );
}
