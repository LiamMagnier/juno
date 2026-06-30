import Link from "next/link";
import { AsciiWordmark } from "@/components/signature/dot-matrix";
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
      <Link href="/" className="mb-8">
        <AsciiWordmark />
      </Link>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 max-w-sm text-center text-xs text-muted-foreground">
        By continuing you agree to use Juno responsibly. Your conversations are private to your account.
      </p>
    </div>
  );
}
