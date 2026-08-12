import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";
import { getCurrentUser } from "@/lib/session";
import { isGoogleConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Juno — chat with the best AI models from one thoughtful workspace.",
};

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/chat");

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-balance font-serif text-display">Welcome back</h1>
        <p className="text-body text-muted-foreground">Sign in to continue to Juno.</p>
      </div>
      {/* A real skeleton, not `null`: AuthForm reads useSearchParams, so it
          suspends on first render and the card used to be a heading over empty
          space that jumped to full height when the whole form arrived at once. */}
      <Suspense fallback={<AuthFormSkeleton mode="signin" />}>
        <AuthForm mode="signin" googleEnabled={isGoogleConfigured()} />
      </Suspense>
    </div>
  );
}
