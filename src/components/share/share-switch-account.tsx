"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { signOutToSignIn } from "@/lib/sign-out";

/**
 * "Use another account" on a share page that was not shared with the account
 * signed in: sign out, then sign in again and come straight back to the page.
 */
export function ShareSwitchAccount({ returnTo, variant = "default" }: { returnTo: string; variant?: "default" | "secondary" }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void signOutToSignIn(returnTo).catch(() => setBusy(false));
      }}
    >
      Use another account
    </Button>
  );
}
