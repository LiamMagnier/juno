"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function ForgotPasswordForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      // The endpoint intentionally returns the same success shape whether or
      // not the address exists, so this screen cannot reveal registered users.
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not send the reset email.");
      setSent(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the reset email.");
    } finally {
      setLoading(false);
    }
  }

  if (!emailEnabled) {
    return (
      <div className="space-y-5 text-center" role="status">
        {/* `rounded-field` (10px), the ladder's rung for inline notes and wells —
            `rounded-lg` resolves to --radius (the 16px surface step), which is
            the panel rung and put this note at the same corner as the card
            containing it. */}
        <p className="rounded-field border border-warning/35 bg-warning/10 px-3.5 py-3 text-body text-foreground">
          Password recovery is temporarily unavailable. Please contact the site owner.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/sign-in"><ArrowLeft aria-hidden /> Back to sign in</Link>
        </Button>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="space-y-5 text-center" role="status">
        {/* motion-safe:animate-pop-in: this state replaces the form in place with
            no navigation, so without an entrance the card silently becomes a
            different card. */}
        <CheckCircle2 className="mx-auto size-9 text-success motion-safe:animate-pop-in" aria-hidden />
        <div className="space-y-1.5">
          {/* text-heading (18px) — this was text-xl (20px) under a 30px page h1,
              a third size for the serif-heading role inside one card. */}
          <h2 className="font-serif text-heading font-medium">Check your inbox</h2>
          <p className="text-body text-muted-foreground">
            If an account exists for that email, we sent a link that expires in one hour.
          </p>
        </div>
        <Button asChild variant="outline" className="w-full">
          <Link href="/sign-in">
            <ArrowLeft aria-hidden /> Back to sign in
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading} aria-busy={loading}>
        {/* motion-safe:, matching the majority convention — see the note in
            auth-form.tsx. The button is disabled and aria-busy either way. */}
        {loading && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
        Send reset link
      </Button>
      {/* `group` + a transform on the glyph: hover was the link's only affordance
          and hover does not exist on touch or for a keyboard. The arrow now also
          answers focus, and the travel is dropped under motion-reduce. */}
      <Link
        href="/sign-in"
        className="group mx-auto flex w-fit items-center justify-center gap-1.5 rounded-xs text-body text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline focus-visible:text-foreground"
      >
        <ArrowLeft
          className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5 group-focus-visible:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
          aria-hidden
        />
        Back to sign in
      </Link>
    </form>
  );
}
