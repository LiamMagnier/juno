"use client";

import { signOutToSignIn } from "@/lib/sign-out";
import { Button } from "@/components/ui/button";

export function SuspendedActions() {
  return (
    <Button variant="outline" className="mt-6 w-full" onClick={() => void signOutToSignIn()}>
      Sign out
    </Button>
  );
}
