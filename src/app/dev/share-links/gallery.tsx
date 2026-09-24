"use client";

import * as React from "react";
import { ReportShareButton } from "@/components/share/report-share-dialog";
import { LinksAdmin } from "@/components/admin/links-admin";
import type { AdminShareReport, AdminShareRow } from "@/lib/share-moderation";

const TOKEN = "dEvToKeN0123456789abcdefghijklmn";
const now = Date.now();
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

const LIVE: AdminShareRow = {
  id: "dev-share-live",
  token: TOKEN,
  url: `/share/${TOKEN}`,
  kind: "ARTIFACT",
  title: "Bank account verification",
  status: "live",
  views: 412,
  createdAt: ago(30),
  snapshotAt: ago(30),
  revokedAt: null,
  takenDownAt: null,
  takenDownBy: null,
  takedownReason: null,
  owner: { id: "dev-user-1", email: "someone@example.test", name: "Someone", bannedAt: null },
  openReports: 2,
};
const DOWN: AdminShareRow = {
  ...LIVE,
  id: "dev-share-down",
  token: "dEvToKeNtakenDown456789abcdefghij",
  url: "/share/dEvToKeNtakenDown456789abcdefghij",
  kind: "CHAT",
  title: "Free gift card generator",
  status: "taken-down",
  views: 97,
  takenDownAt: ago(5),
  takenDownBy: "owner@example.test",
  takedownReason: "Collects card numbers under a fake giveaway.",
  openReports: 0,
};
const REPORTS: AdminShareReport[] = [
  {
    id: "dev-report-1",
    reason: "phishing",
    detail: "Asks for my online banking password and then a one-time code.",
    contact: "visitor@example.test",
    status: "open",
    createdAt: ago(2),
    resolvedAt: null,
    resolvedBy: null,
    shareToken: TOKEN,
    shareTitle: LIVE.title,
    share: LIVE,
  },
  {
    id: "dev-report-2",
    reason: "other",
    detail: "",
    contact: null,
    status: "open",
    createdAt: ago(9),
    resolvedAt: null,
    resolvedBy: null,
    shareToken: "dEvToKeNgone0123456789abcdefghij",
    shareTitle: "Deleted chat",
    share: null,
  },
];

/*
 * The canned answers. Only this page's requests are answered here; everything
 * else goes to the network untouched.
 */
if (typeof window !== "undefined" && !(window as unknown as { __junoLinksShim?: boolean }).__junoLinksShim) {
  (window as unknown as { __junoLinksShim?: boolean }).__junoLinksShim = true;
  const original = window.fetch.bind(window);
  const json = (body: unknown, status = 200) =>
    new Promise<Response>((resolve) =>
      setTimeout(() => resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })), 350)
    );
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/share/report") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { contact?: string };
      return body.contact === "limit@example.test"
        ? json({ error: "Too many reports from this address. Try again later." }, 429)
        : json({ ok: true });
    }
    if (url.pathname === "/api/admin/shares") return json({ shares: url.searchParams.get("q") ? [LIVE, DOWN] : [] });
    if (url.pathname === "/api/admin/shares/reports") {
      return json({ reports: REPORTS, total: REPORTS.length, page: 1, pageSize: 25 });
    }
    if (/\/api\/admin\/shares\/[^/]+\/takedown$/.test(url.pathname) && method === "POST") {
      return json({ share: { ...LIVE, status: "taken-down", takenDownAt: new Date().toISOString(), takenDownBy: "you", takedownReason: "dev" } });
    }
    if (/\/api\/admin\/shares\/[^/]+\/restore$/.test(url.pathname)) return json({ share: { ...DOWN, status: "live", takenDownAt: null } });
    if (/\/api\/admin\/shares\/reports\/[^/]+$/.test(url.pathname)) return json({ ok: true });
    return original(input, init);
  };
}

export function ShareLinksGallery() {
  return (
    <div className="flex flex-col gap-10 py-8">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4" data-section="report">
        <h1 className="text-title font-semibold">Share page footer</h1>
        <p className="text-body text-muted-foreground">
          The Report link as it sits in the public page&rsquo;s footer. An email of limit@example.test answers 429.
        </p>
        <div className="flex h-12 items-center justify-between gap-3 border-y border-border/60">
          <span className="font-mono text-caption text-muted-foreground">Made with Juno</span>
          <span className="flex items-center gap-4">
            <ReportShareButton token={TOKEN} />
            <span className="text-caption text-muted-foreground">Create your own account</span>
          </span>
        </div>
      </section>
      <section data-section="admin">
        <LinksAdmin />
      </section>
    </div>
  );
}
