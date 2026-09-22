import Link from "next/link";

import { Button } from "@/components/ui/button";
import { StatusIcons } from "@/lib/app-icons";

/**
 * What an owner sees instead of Admin until they have enrolled in two-step
 * verification.
 *
 * Shown in place of the layout's children rather than as a banner above them,
 * because the point is that the pages are genuinely unreachable — a prompt
 * over a working users table would be a suggestion, and this is not one. The
 * API surface fails closed independently (src/lib/admin.ts), so this is the
 * explanation, not the enforcement.
 */
export function AdminMfaRequired() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-16 text-center motion-safe:animate-rise-in">
      {/* The security mark from the shared registry — the same shield the
          rest of the product uses for "this is a security problem" — in the
          quiet tonal tile every designed empty and error state stands on. */}
      <span className="flex size-12 items-center justify-center rounded-field bg-destructive/10 text-destructive">
        <StatusIcons.security className="size-6" aria-hidden />
      </span>
      <h1 className="font-serif text-heading text-foreground">Two-step verification is required here</h1>
      <p className="max-w-prose text-body text-muted-foreground">
        An owner account can read and delete every user&apos;s data and spends without a ceiling, so it cannot be
        protected by a password alone. Turn on two-step verification in Settings and this panel comes back.
      </p>
      <Button asChild>
        <Link href="/settings?section=account">Set up two-step verification</Link>
      </Button>
    </div>
  );
}
