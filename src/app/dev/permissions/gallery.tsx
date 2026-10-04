"use client";

import * as React from "react";

import { SavedCredentials, type SavedCredentialsData } from "@/components/permissions/saved-credentials";

/*
 * Saved logins (Alevr Secrets) with fixtures, dev only. `?state=empty|full|error`.
 * Same-origin /api requests the section makes are answered here; nothing
 * reaches a server, and no fixture holds a value — the API never returns one.
 */

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const FULL: SavedCredentialsData = {
  credentials: [
    { id: "c1", label: "GitHub — work", hosts: ["github.com", "*.github.com"], hasUsername: true, version: 2, rotatedAt: iso(-3 * 86_400_000), lastUsedAt: iso(-40 * 60_000), createdAt: iso(-20 * 86_400_000) },
    { id: "c2", label: "Supplier portal", hosts: ["portal.acme-supplies.example"], hasUsername: true, version: 1, rotatedAt: null, lastUsedAt: null, createdAt: iso(-2 * 86_400_000) },
  ],
  grants: [
    { id: "g1", credentialId: "c1", credentialLabel: "GitHub — work", taskKey: "work:t1", hosts: ["github.com"], scopes: ["fill:username", "fill:secret"], uses: 2, maxUses: 10, expiresAt: iso(5 * 3_600_000), revokedAt: null, stale: false, createdAt: iso(-3 * 3_600_000) },
    { id: "g2", credentialId: "c2", credentialLabel: "Supplier portal", taskKey: "work:t2", hosts: ["portal.acme-supplies.example"], scopes: ["fill:secret"], uses: 0, maxUses: 10, expiresAt: iso(-3_600_000), revokedAt: null, stale: false, createdAt: iso(-9 * 3_600_000) },
  ],
  events: [
    { id: "e1", credentialLabel: "GitHub — work", taskKey: "work:t1", host: "github.com", scope: "fill:secret", outcome: "granted", reason: null, createdAt: iso(-40 * 60_000) },
    { id: "e2", credentialLabel: "GitHub — work", taskKey: "work:t1", host: "github.com.evil.example", scope: "fill:secret", outcome: "refused", reason: "host_not_allowed", createdAt: iso(-41 * 60_000) },
    { id: "e3", credentialLabel: "GitHub — work", taskKey: "work:t1", host: null, scope: null, outcome: "grant_created", reason: null, createdAt: iso(-3 * 3_600_000) },
    { id: "e4", credentialLabel: "GitHub — work", taskKey: null, host: null, scope: null, outcome: "rotated", reason: null, createdAt: iso(-3 * 86_400_000) },
  ],
};

const TASKS = [
  { id: "t1", title: "Triage open issues on the design repo" },
  { id: "t2", title: "Download this month’s supplier invoices" },
];

function installFixtures(state: string) {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin !== window.location.origin) return original(input, init);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/secrets") {
      if (state === "error") return json({ error: "fixture failure" }, 500);
      return json(state === "empty" ? { credentials: [], grants: [], events: [] } : FULL);
    }
    if (url.pathname === "/api/work/sessions") return json({ sessions: state === "empty" ? [] : TASKS });
    if (url.pathname.startsWith("/api/secrets")) return json({ ok: true });
    return original(input, init);
  };
}

export function PermissionsGallery() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const state = new URLSearchParams(window.location.search).get("state") ?? "full";
    installFixtures(state);
    setReady(true);
  }, []);
  return (
    <main className="mx-auto max-w-[880px] px-4 py-10 sm:px-8">
      {ready ? <SavedCredentials /> : null}
    </main>
  );
}
