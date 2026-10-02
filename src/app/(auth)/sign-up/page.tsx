import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";
import { getCurrentUser } from "@/lib/session";
import { isGoogleConfigured } from "@/lib/env";
import { isAppleConfigured, isEmailLinkConfigured } from "@/lib/auth";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = {
  title: "Create account",
  description: `Create your ${PRODUCT_NAME} account and start chatting with the best AI models in seconds.`,
};

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/chat");

  const providers = { googleEnabled: isGoogleConfigured(), appleEnabled: isAppleConfigured(), emailLinkEnabled: isEmailLinkConfigured() };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-balance font-serif text-display font-medium tracking-tight">Create your account</h1>
        <p className="text-body text-muted-foreground">{`Start chatting with ${PRODUCT_NAME} in seconds.`}</p>
      </div>
      {/* A real skeleton, not `null`: AuthForm reads useSearchParams, so it
          suspends on first render and the card used to be a heading over empty
          space that jumped to full height when the whole form arrived at once. */}
      <Suspense fallback={<AuthFormSkeleton mode="signup" {...providers} />}>
        <AuthForm
          mode="signup"
          googleEnabled={isGoogleConfigured()}
          appleEnabled={isAppleConfigured()}
          emailLinkEnabled={isEmailLinkConfigured()}
        />
      </Suspense>
    </div>
  );
}
