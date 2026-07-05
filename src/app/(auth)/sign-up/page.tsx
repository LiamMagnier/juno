import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { getCurrentUser } from "@/lib/session";
import { isGoogleConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Create account",
  description: "Create your Juno account and start chatting with the best AI models in seconds.",
};

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/chat");

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-balance font-serif text-3xl font-medium tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">Start chatting with Juno in seconds.</p>
      </div>
      <Suspense fallback={null}>
        <AuthForm mode="signup" googleEnabled={isGoogleConfigured()} />
      </Suspense>
    </div>
  );
}
