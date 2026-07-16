"use client";

import { useEffect, useMemo } from "react";

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

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">Signing you in to Juno…</h1>
        <p className="text-sm text-muted-foreground">You can return to the app.</p>
        <a className="inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground" href={deepLink}>
          Open Juno
        </a>
      </div>
    </main>
  );
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

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">Signing you in to Juno…</h1>
        <p className="text-sm text-muted-foreground">You can return to the app.</p>
        <a className="inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground" href={deepLink}>
          Open Juno
        </a>
      </div>
    </main>
  );
}
