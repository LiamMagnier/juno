"use client";

import { useEffect, useState } from "react";

/**
 * Redirects to the app's custom scheme with the session token. The native
 * ASWebAuthenticationSession watches for `juno://` and completes sign-in; if the
 * app isn't driving this (e.g. opened in a normal browser), we show a manual
 * "Open Juno" link instead.
 */
export function AppAuthHandoff({ token }: { token: string }) {
  const [deepLink, setDeepLink] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const link = `juno://auth?token=${encodeURIComponent(token)}`;
    setDeepLink(link);
    window.location.href = link;
  }, [token]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        color: "#e8e4dd",
        background: "#111010",
        padding: 40,
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: 17, fontWeight: 600 }}>Signing you in to Juno…</p>
      <p style={{ fontSize: 13, opacity: 0.7 }}>
        You can return to the app. If it didn’t open automatically:
      </p>
      {deepLink && (
        <a
          href={deepLink}
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            background: "#c6613f",
            padding: "10px 18px",
            borderRadius: 12,
            textDecoration: "none",
          }}
        >
          Open Juno
        </a>
      )}
    </div>
  );
}
