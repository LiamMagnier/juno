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
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
      {/* Same archetype as the auth card — a centred full-screen panel — so it
          is the same recipe: `surface-raised-lg` at the panel rung. */}
      <div className="surface-raised-lg w-full max-w-md rounded-panel p-6 text-center motion-safe:animate-rise-in sm:p-7">
        <JunoMark className="mx-auto size-10" />
        <p className="mt-6 font-mono text-label text-destructive">Account suspended</p>
        <h1 className="mt-2 text-balance font-serif text-title">Your access has been paused</h1>
        <p className="mt-3 text-body text-muted-foreground">
          This account has been suspended for violating Juno&rsquo;s{" "}
          <a
            href="/legal/cgu"
            className="rounded-xs text-foreground underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
          >
            Terms of Use
          </a>
          .
        </p>
        {ban.reason && (
          // The quoted reason sits in an inset well — the same note recipe the
          // forgot-password card uses for its inline notice.
          <div className="surface-inset mt-4 rounded-field px-4 py-3 text-left text-body">
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
