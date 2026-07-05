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
      <div className="w-full max-w-md rounded-[24px] border border-border bg-card p-8 text-center shadow-float motion-safe:animate-rise-in">
        <JunoMark className="mx-auto h-10 w-10" />
        <p className="mt-6 font-mono text-label uppercase tracking-[0.14em] text-destructive">Account suspended</p>
        <h1 className="mt-2 font-serif text-heading font-medium">Your access has been paused</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This account has been suspended for violating Juno&rsquo;s{" "}
          <a href="/legal/cgu" className="text-foreground underline underline-offset-2">
            Terms of Use
          </a>
          .
        </p>
        {ban.reason && (
          <div className="mt-4 rounded-[14px] border border-border/60 bg-muted/40 px-4 py-3 text-left text-sm">
            <span className="font-mono text-caption uppercase tracking-wide text-muted-foreground">Reason</span>
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
