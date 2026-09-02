"use client";

import { useEffect, useMemo } from "react";

import { JunoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * The handoff card: the centred `surface-raised-lg` panel every
 * unauthenticated full-screen state in the product uses (auth, suspended),
 * with the deep link as its one primary action for the case where the
 * automatic redirect does not fire.
 */
function HandoffCard({ deepLink }: { deepLink: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12 text-foreground">
      <div
        role="status"
        className="surface-raised-lg w-full max-w-md rounded-panel p-6 text-center motion-safe:animate-rise-in sm:p-7"
      >
        <JunoMark className="mx-auto size-10" />
        <h1 className="mt-6 text-balance font-serif text-title">Signing you in to Juno…</h1>
        <p className="mt-2 text-body text-muted-foreground">You can return to the app.</p>
        <Button asChild className="mt-6 w-full">
          <a href={deepLink}>Open Juno</a>
        </Button>
      </div>
    </main>
  );
}

/**
 * Legacy handoff for the stable app lineage (build ≤30): hands the session
 * token to the app through the `juno://auth` deep link its
 * ASWebAuthenticationSession watches for. Keep until the native device-session
 * contract ships in the stable app — removing this locks those builds out.
 */
export function LegacyAppAuthHandoff({ token }: { token: string }) {
  const deepLink = useMemo(() => `juno://auth?token=${encodeURIComponent(token)}`, [token]);

  useEffect(() => {
    if (token) window.location.replace(deepLink);
  }, [deepLink, token]);

  return <HandoffCard deepLink={deepLink} />;
}

export function AppAuthHandoff({
  code,
  state,
  nonce,
  redirectUri,
}: {
  code: string;
  state: string;
  nonce: string;
  redirectUri: string;
}) {
  const deepLink = useMemo(() => {
    const query = new URLSearchParams({ code, state, nonce });
    return `${redirectUri}?${query}`;
  }, [code, state, nonce, redirectUri]);

  useEffect(() => {
    window.location.replace(deepLink);
  }, [deepLink]);

  return <HandoffCard deepLink={deepLink} />;
}
