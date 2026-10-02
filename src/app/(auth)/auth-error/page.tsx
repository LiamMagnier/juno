import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Sign-in couldn’t finish", robots: { index: false, follow: false } };

export default async function AuthErrorPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error === "Verification"
    ? "This sign-in link has expired or has already been used. Request a new link to continue."
    : error === "AccessDenied"
      ? "Sign-in was not completed. You can try again or use a different sign-in method."
      : "We couldn’t complete sign-in. Please try again in a moment.";
  return <div className="space-y-6">
    <h1 className="font-serif text-display font-medium tracking-tight">Sign-in couldn’t finish</h1>
    <p role="alert" className="text-body leading-relaxed text-muted-foreground">{message}</p>
    <Button asChild className="w-full"><Link href="/sign-in">Back to sign in</Link></Button>
  </div>;
}
