"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";
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

  if (token === null) {
    return <div className="flex justify-center py-3"><Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  }

  if (complete) {
    return (
      <div className="space-y-5 text-center" role="status">
        <CheckCircle2 className="mx-auto h-9 w-9 text-success" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="font-serif text-xl font-medium">Password updated</h2>
          <p className="text-sm text-muted-foreground">Your new password is ready. You can sign in now.</p>
        </div>
        <Button asChild className="w-full">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="space-y-5 text-center">
        <p className="text-sm text-muted-foreground">This reset link is missing, invalid, or has already been used.</p>
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
      <Button type="submit" className="w-full" disabled={loading}>
        {loading && <Loader2 className="animate-spin" aria-hidden />}
        Choose new password
      </Button>
    </form>
  );
}
