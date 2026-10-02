import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getCurrentUser } from "@/lib/session";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: `Choose a new password for your ${PRODUCT_NAME} account.`,
  referrer: "no-referrer",
};

export default async function ResetPasswordPage() {
  if (await getCurrentUser()) redirect("/chat");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-balance font-serif text-display font-medium tracking-tight">Choose a new password</h1>
        <p className="text-body text-muted-foreground">Use at least eight characters you don’t use elsewhere.</p>
      </div>
      <ResetPasswordForm />
    </div>
  );
}
