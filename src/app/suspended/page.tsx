import { redirect } from "next/navigation";
import { getSessionBan } from "@/lib/session";
import { JunoMark } from "@/components/brand/logo";
import { SuspendedActions } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Account suspended" };

export default async function SuspendedPage() {
  const ban = await getSessionBan();
  // Not banned (or signed out) → nothing to see here.
  if (!ban) redirect("/chat");

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      {/* Same archetype as the auth card — a centred full-screen panel — so it
          gets the same radius and the same elevation treatment. It used to be
          `rounded-lg` (16px) + `shadow-float`, and `shadow-float` is pure black
          ink on dark, so on the OLED ground the panel's only separation was a
          damped hairline; the dark override is the lit INSET edge
          `.dark .composer-surface` uses.
          `rounded-surface` (16px), not `rounded-panel` (18px): the auth card has
          since moved to surface, so the two identical shapes were back to two
          corners on two rungs. `panel` is the rung for FLOATING layers; both of
          these are in-flow panels resting on the page ground, which is exactly
          what `surface` is named for (tailwind.config.ts). */}
      <div className="w-full max-w-md rounded-surface border border-border bg-card p-8 text-center shadow-soft motion-safe:animate-rise-in dark:shadow-[inset_0_1px_0_hsl(var(--sheen)),0_1px_2px_hsl(0_0%_0%/0.5),0_18px_44px_-30px_hsl(0_0%_0%/0.9)]">
        <JunoMark className="mx-auto h-10 w-10" />
        <p className="mt-6 font-mono text-label text-destructive">Account suspended</p>
        {/* text-title (22px), not text-heading (18px). This is a terminal,
            account-level page title and it was the smallest page title in the
            unauthenticated product — barely larger than the text-label eyebrow
            directly above it. */}
        <h1 className="mt-2 text-balance font-serif text-title">Your access has been paused</h1>
        <p className="mt-3 text-body text-muted-foreground">
          This account has been suspended for violating Juno&rsquo;s{" "}
          <a
            href="/legal/cgu"
            className="rounded-xs text-foreground underline underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
          >
            Terms of Use
          </a>
          .
        </p>
        {ban.reason && (
          // `bg-muted` opaque, not `bg-muted/40`. That alpha was tuned against
          // the old ~9% dark ground; over today's 6.5% card it composites to
          // ~7.7% — a 1.2-point step, invisible on an OLED panel, so the quoted
          // ban reason lost its container entirely.
          // `rounded-field` (10px), not `rounded-menu` (12px). `menu` is the
          // rung for dropdown/select/tabs shells; `field` is the one named for
          // inline notes and wells, and it is what the identical quoted note on
          // the forgot-password card already uses. Two inline notes, one rung.
          <div className="mt-4 rounded-field border border-border/60 bg-muted px-4 py-3 text-left text-body">
            <span className="font-mono text-caption text-muted-foreground">Reason</span>
            <p className="mt-1 text-foreground">{ban.reason}</p>
          </div>
        )}
        <p className="mt-4 text-caption text-muted-foreground">
          Believe this is a mistake? Reply to your account email to appeal.
        </p>
        <SuspendedActions />
      </div>
    </div>
  );
}
