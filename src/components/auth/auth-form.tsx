"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function GoogleIcon() {
  return (
    // The four hex fills are Google's brand mark, which may not be recoloured —
    // this is the one place in the tree where a literal colour is correct, and it
    // is why the mark is inlined rather than tinted from a token.
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

export function AuthForm({ mode, googleEnabled }: { mode: "signin" | "signup"; googleEnabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const requestedCallback = params.get("callbackUrl");
  const callbackUrl = React.useMemo(() => {
    if (!requestedCallback || !requestedCallback.startsWith("/") || requestedCallback.startsWith("//")) return "/chat";
    try {
      const parsed = new URL(requestedCallback, "https://juno.invalid");
      if (parsed.origin !== "https://juno.invalid") return "/chat";
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "/chat";
    }
  }, [requestedCallback]);

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Could not create your account.");
        }
      }

      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        throw new Error(mode === "signup" ? "Account created, but sign-in failed. Try signing in." : "Invalid email or password.");
      }
      router.push(callbackUrl);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      {googleEnabled && (
        <>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={googleLoading || loading}
            aria-busy={googleLoading}
            onClick={() => {
              setGoogleLoading(true);
              signIn("google", { callbackUrl });
            }}
          >
            {/* motion-safe:, which is what eleven of the product's nineteen
                spinners already do and these four did not. A control that spins
                forever is the plainest case prefers-reduced-motion exists for,
                and nothing is lost: the button is disabled and aria-busy, so the
                busy state is still both announced and drawn. */}
            {googleLoading ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <GoogleIcon />}
            Continue with Google
          </Button>
          {/* The rule is written explicitly at border-border/60. With no colour
              class it inherited the global `* { border-color: hsl(var(--border)) }`
              at full 21%, so the one hairline INSIDE the card was louder than the
              card's own edge and every damped rule on the surrounding pages.
              `bg-card` on the label, not `bg-background`: the knockout has to
              match the surface it actually sits on, and on the true-black theme
              --background punched a pure-black notch through a 6.5% panel. */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <span className="w-full border-t border-border/60" />
            </div>
            {/* text-label, the product's one label voice (mono, uppercase, 0.10em),
                rather than a bare Tailwind text-xs that appears nowhere else. */}
            <div className="relative flex justify-center">
              <span className="bg-card px-2 font-mono text-label uppercase text-muted-foreground">or</span>
            </div>
          </div>
        </>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        {mode === "signup" && (
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            {mode === "signin" && (
              <Link
                href="/forgot-password"
                className="rounded-xs text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline focus-visible:text-foreground"
              >
                Forgot your password?
              </Link>
            )}
          </div>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </div>
        {/* Disabled while the Google redirect is in flight too. Clicking Continue
            with Google and then Sign in fired a second auth attempt against a
            page that was already navigating away — the Google button already
            guards against the reverse order, and this closes the pair.
            aria-busy so the state is announced, not only drawn. */}
        <Button type="submit" className="w-full" disabled={loading || googleLoading} aria-busy={loading}>
          {loading && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
          {mode === "signup" ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="text-center text-body text-muted-foreground">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="rounded-xs font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline focus-visible:text-primary">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to Juno?{" "}
            <Link href={`/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="rounded-xs font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline focus-visible:text-primary">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
