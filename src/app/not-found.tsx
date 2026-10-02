import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PublicState } from "@/components/public/public-frame";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <PublicState title="This page isn’t here" description="The link may be out of date, or the address may have a typo. Nothing in your account has changed.">
      <Button asChild><Link href="/chat">Back to chat</Link></Button>
      <Button asChild variant="secondary"><Link href="/">Go to the home page</Link></Button>
    </PublicState>
  );
}
