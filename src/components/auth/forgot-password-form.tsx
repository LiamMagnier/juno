"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toast } from "sonner";

export function ForgotPasswordForm({ emailEnabled }: { emailEnabled: boolean }) {
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  // The server's answer, under the field it is about — a toast is gone before
  // a screen reader reaches the input (SC 3.3.1). Toasts stay for the network.
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // The controls below are disabled when email is off, but a submit can
    // still arrive (stale DOM, automation) — refuse it here rather than
    // sending a request the server cannot honour.
    if (!emailEnabled) return;
    setError(null);
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
      if (!res.ok) {
        setError(data.error ?? "Couldn’t send the reset email.");
        return;
      }
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t send the reset email.");
    } finally {
      setLoading(false);
    }
  }

  if (!emailEnabled) {
    // Email is not configured on this server, so the form cannot work — but
    // it still renders, with the field and the action disabled and a note
    // saying why. A warning-only state would leave the forgot-password e2e
    // (which asserts the email field and the submit exist) green only where
    // email happens to be configured, i.e. untestable everywhere else.
    return (
      <form method="post" onSubmit={onSubmit} className="space-y-5" aria-describedby="forgot-password-unavailable">
        <p
          id="forgot-password-unavailable"
          role="note"
          className="flex items-start gap-2 rounded-field border border-warning/35 bg-warning/10 px-3.5 py-3 text-body text-foreground"
        >
          {/* The same leading-glyph well the sign-in form's error and notice
              use, in the warning mark: three tones of one component. */}
          <StatusIcons.warning className="mt-1 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            Password recovery is unavailable because email is not set up on this server. Please contact the site owner.
          </span>
        </p>
        <Field
          id="forgot-email"
          type="email"
          label="Email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          disabled
          aria-disabled="true"
        />
        <Button type="submit" className="w-full" disabled aria-disabled="true">
          Send reset link
        </Button>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/sign-in">
            <ArrowLeft className="size-4" aria-hidden /> Back to sign in
          </Link>
        </Button>
      </form>
    );
  }

  if (sent) {
    return (
      <div className="space-y-5 text-center" role="status">
        {/* The glyph sits in a quiet tonal tile and springs in (`.check-morph`),
            the tile arriving on the pop: this state replaces the form in place
            with no navigation, so without an entrance the card silently becomes
            a different card. A bare 36px mark was the one glyph in the auth
            flow drawn off the size ladder. */}
        <span className="mx-auto flex size-12 items-center justify-center rounded-field bg-success/10 text-success motion-safe:animate-pop-in">
          <StatusIcons.success className="check-morph size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          {/* text-heading (18px) — this was text-xl (20px) under a 30px page h1,
              a third size for the serif-heading role inside one card. */}
          <h2 className="font-serif text-heading font-medium">Check your inbox</h2>
          <p className="text-body text-muted-foreground">
            If an account exists for that email, we sent a link that expires in one hour.
          </p>
        </div>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/sign-in">
            <ArrowLeft className="size-4" aria-hidden /> Back to sign in
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-5">
      <Field
        id="forgot-email"
        type="email"
        label="Email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={error}
        placeholder="you@example.com"
        autoComplete="email"
        inputMode="email"
        autoFocus
      />
      <Button type="submit" className="w-full" disabled={loading} aria-busy={loading}>
        {/* motion-safe:, matching the majority convention — see the note in
            auth-form.tsx. The button is disabled and aria-busy either way. */}
        {loading && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
        Send reset link
      </Button>
      {/* The arrow's own `nudge-l` articulation (icons.tsx) answers hover AND
          keyboard focus on the link, and is dropped under reduced motion by
          globals.css — hover was once this link's only affordance, and a
          hand-written translate here would now double the travel. */}
      <Link
        href="/sign-in"
        className="mx-auto flex w-fit items-center justify-center gap-2 rounded-xs text-body text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline focus-visible:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to sign in
      </Link>
    </form>
  );
}
