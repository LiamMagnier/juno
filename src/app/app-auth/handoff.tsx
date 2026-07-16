"use client";

import { useEffect, useMemo } from "react";

export function AppAuthHandoff({ code, state, nonce }: { code: string; state: string; nonce: string }) {
  const deepLink = useMemo(() => {
    const query = new URLSearchParams({ code, state, nonce });
    return `juno://auth/callback?${query}`;
  }, [code, state, nonce]);

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
