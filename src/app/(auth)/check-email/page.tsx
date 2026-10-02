import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Check your email", robots: { index: false, follow: false } };

export default function CheckEmailPage() {
  return <div className="space-y-6">
    <h1 className="font-serif text-display font-medium tracking-tight">Check your email</h1>
    <p role="status" className="text-body leading-relaxed text-muted-foreground">We sent you a sign-in link. Open it in your email to continue. If it hasn’t arrived, check your spam folder.</p>
    <Button asChild variant="secondary" className="w-full"><Link href="/sign-in">Back to sign in</Link></Button>
  </div>;
}
