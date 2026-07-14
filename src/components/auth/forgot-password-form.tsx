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
      <div className="space-y-5 text-center">
        <p className="rounded-lg border border-warning/35 bg-warning/10 px-3.5 py-3 text-sm text-foreground">
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
        <CheckCircle2 className="mx-auto h-9 w-9 text-success" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="font-serif text-xl font-medium">Check your inbox</h2>
          <p className="text-sm text-muted-foreground">
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
      <Button type="submit" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" aria-hidden />}
        Send reset link
      </Button>
      <Link
        href="/sign-in"
        className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to sign in
      </Link>
    </form>
  );
}
