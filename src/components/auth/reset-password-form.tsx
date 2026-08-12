"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function tokenFromFragment(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

export function ResetPasswordForm() {
  const [token, setToken] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [complete, setComplete] = React.useState(false);

  React.useEffect(() => setToken(tokenFromFragment()), []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirmation) {
      toast.error("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not reset your password.");

      // Remove the secret from the address bar/history as soon as it is used.
      window.history.replaceState({}, "", "/reset-password");
      setToken("");
      setComplete(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset your password.");
    } finally {
      setLoading(false);
    }
  }

  // The token lives in the URL fragment, which is only readable after mount, so
  // this branch is the form's real loading state. A skeleton shaped like the two
  // fields and the submit keeps the card's height stable across the swap — a
  // lone centred spinner meant the panel visibly grew when the form arrived.
  if (token === null) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2" aria-hidden>
            <div className="skeleton h-3 w-28 rounded-micro" />
            <div className="skeleton h-9 w-full rounded-field coarse:h-11" />
          </div>
        ))}
        <div className="skeleton h-9 w-full rounded-field coarse:h-11" aria-hidden />
      </div>
    );
  }

  if (complete) {
    return (
      <div className="space-y-5 text-center" role="status">
        <CheckCircle2 className="mx-auto size-9 text-success motion-safe:animate-pop-in" aria-hidden />
        <div className="space-y-1.5">
          {/* text-heading, not text-xl — see the same note in forgot-password-form. */}
          <h2 className="font-serif text-heading font-medium">Password updated</h2>
          <p className="text-body text-muted-foreground">Your new password is ready. You can sign in now.</p>
        </div>
        <Button asChild className="w-full">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  if (!token) {
    return (
      // Given the same shape as the two terminal states above (icon, h2, body).
      // This is the only branch in the component that is actually a FAILURE, and
      // it was the one with the least structure — a bare muted sentence with no
      // icon, no heading and no destructive tint, so the state that needs to be
      // read carefully was the quietest thing the card could render.
      <div className="space-y-5 text-center" role="alert">
        <TriangleAlert className="mx-auto size-9 text-destructive motion-safe:animate-pop-in" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="font-serif text-heading font-medium">This link no longer works</h2>
          <p className="text-body text-muted-foreground">
            This reset link is missing, invalid, or has already been used.
          </p>
        </div>
        <Button asChild className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          required
          minLength={8}
          maxLength={200}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type="password"
          required
          minLength={8}
          maxLength={200}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="Enter it again"
          autoComplete="new-password"
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading} aria-busy={loading}>
        {/* motion-safe:, matching the majority convention — see the note in
            auth-form.tsx. The button is disabled and aria-busy either way. */}
        {loading && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
        Choose new password
      </Button>
    </form>
  );
}
