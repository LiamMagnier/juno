"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SuspendedActions() {
  return (
    <Button variant="outline" className="mt-6 w-full" onClick={() => signOut({ callbackUrl: "/sign-in" })}>
      Sign out
    </Button>
  );
}
