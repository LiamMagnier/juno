import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { getCurrentUser } from "@/lib/session";
import { isEmailEnabled } from "@/lib/email";

export const metadata: Metadata = {
  title: "Forgot password",
  description: "Request a secure password-reset link for your Juno account.",
};

export default async function ForgotPasswordPage() {
  if (await getCurrentUser()) redirect("/chat");

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-balance font-serif text-3xl font-medium tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground">Enter your email and we’ll send you a secure reset link.</p>
      </div>
      <ForgotPasswordForm emailEnabled={isEmailEnabled()} />
    </div>
  );
}
