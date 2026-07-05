import Link from "next/link";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
import { JunoMark } from "@/components/brand/logo";
import { DotField } from "@/components/signature/dot-field";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <DotField />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_45%_at_50%_0%,hsl(var(--primary)/0.12),transparent_70%)]"
      />
      {/* Layered entrance: mark + wordmark → card → fine print. */}
      <Link href="/" className="mb-8 flex flex-col items-center gap-3 rounded-md motion-safe:animate-fade-in">
        <JunoMark className="h-12 w-12" />
        <AsciiWordmark />
      </Link>
      <div className="w-full max-w-sm motion-safe:animate-rise-in [animation-delay:60ms] [animation-fill-mode:backwards]">
        {children}
      </div>
      <p className="mt-8 max-w-sm text-center text-caption text-muted-foreground motion-safe:animate-fade-in [animation-delay:180ms] [animation-fill-mode:backwards]">
        By continuing you agree to use Juno responsibly. Your conversations are private to your account.
      </p>
      <nav
        aria-label="Legal"
        className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-caption text-muted-foreground/80 motion-safe:animate-fade-in [animation-delay:240ms] [animation-fill-mode:backwards]"
      >
        <Link href="/legal/confidentialite" className="rounded-sm transition-colors duration-fast ease-out-soft hover:text-foreground">
          Confidentialité
        </Link>
        <span aria-hidden>·</span>
        <Link href="/legal/cgu" className="rounded-sm transition-colors duration-fast ease-out-soft hover:text-foreground">
          CGU
        </Link>
        <span aria-hidden>·</span>
        <Link href="/legal/mentions-legales" className="rounded-sm transition-colors duration-fast ease-out-soft hover:text-foreground">
          Mentions légales
        </Link>
      </nav>
    </div>
  );
}
