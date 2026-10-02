"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import LibraryPage from "@/app/(app)/library/page";
import ProjectsPage from "@/app/(app)/projects/page";
import ProjectDetailPage from "@/app/(app)/projects/[id]/page";
import ArtifactsPage from "@/app/(app)/artifacts/page";
import ConnectionsPage from "@/app/(app)/connections/page";
import AutomationsPage from "@/app/(app)/automations/page";
import SettingsPage from "@/app/(app)/settings/page";
import { AgentsHome } from "@/components/agents/agents-home";
import { CompareView } from "@/components/compare/compare-view";
import { AppPage } from "@/components/app/app-page";
import { MemoryManager } from "@/components/memory/memory-manager";
import { SkillsLibraryPage } from "@/components/skills/skills-library-page";
import { openNotifications } from "@/components/notifications/notifications-transport";
import { ITEMS as LIBRARY_ITEMS, DELETED_ITEMS, STORAGE } from "@/app/dev/library/gallery";
import { richMemories, SUMMARY, PROJECT_SUMMARIES } from "@/app/dev/memory/gallery";
import { FIXTURE_LIBRARY, FIXTURE_EMPTY_LIBRARY } from "@/app/dev/skills/fixtures";
import {
  AGENTS,
  ARTIFACTS,
  CONNECTORS,
  CUSTOM_CONNECTORS,
  NOTIFICATIONS,
  PROJECTS,
  PROJECT_DETAIL,
  PROJECT_MEMORY,
  RECENTS,
  SCHEDULES,
  bootstrap,
  searchResult,
} from "./fixtures";

import type { PageName, PageState } from "./pages";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

/**
 * The routes the pages read, answered from fixtures. `state` decides what the
 * PAGE'S OWN data looks like; the shell's reads (sidebar projects, the
 * notifications dot) always answer, so the frame stays the same between
 * states and only the column changes.
 */
function route(path: string, url: URL, method: string, state: PageState, page: PageName): Promise<Response> | null {
  const own = (body: unknown, emptyBody: unknown) => {
    if (state === "loading") return new Promise<Response>(() => {});
    if (state === "error") return json({ error: "failed" }, 500);
    return json(state === "empty" ? emptyBody : body);
  };
  const shell = page === "projects" || page === "project" ? null : true;

  // Custom MCP servers: the add dialog's check, and a server's own page. A
  // pasted address containing "open" answers as a server with no sign-in,
  // "nothing" as unreachable, so each refusal can be seen.
  if (path === "/api/connectors/custom/probe") {
    return new Promise<Response>((resolve) => {
      void (async () => {
        const body = JSON.parse(String(pendingBody.get(path) ?? "{}")) as { url?: string };
        await new Promise((r) => setTimeout(r, 1100));
        const raw = (body.url ?? "").trim();
        const href = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
        const host = new URL(href).host;
        if (raw.includes("open")) {
          resolve(await json({ ok: false, reason: "no_auth", message: "That server doesn't ask you to sign in. For now Juno only adds servers that sign in with OAuth, so your account stays yours." }));
        } else if (raw.includes("nothing")) {
          resolve(await json({ ok: false, reason: "unreachable", message: "Juno couldn't reach an MCP server at that address. Check the URL and try again." }));
        } else {
          const label = host.replace(/^(mcp|api|www)\./, "").split(".")[0] ?? host;
          resolve(await json({ ok: true, url: href, host, authHost: `auth.${host.replace(/^mcp\./, "")}`, suggestedName: label.charAt(0).toUpperCase() + label.slice(1), existing: null }));
        }
      })();
    });
  }
  const custom = path.match(/^\/api\/connectors\/custom\/([^/]+)(\/tools)?$/);
  if (custom) {
    const id = decodeURIComponent(custom[1]);
    const current = CUSTOM_CONNECTORS[id];
    if (!current) return json({ error: "not_found" }, 404);
    if (custom[2]) {
      return new Promise<Response>((resolve) => setTimeout(() => resolve(json({ connector: current })), 700));
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(pendingBody.get(path) ?? "{}")) as Partial<typeof current>;
      Object.assign(current, patch);
      return json({ connector: current });
    }
    if (method === "GET") return json({ connector: current });
  }
  if (path === "/api/settings") return json({ settings: { blockedConnectors: [] } });

  if (method !== "GET") return json({ ok: true });

  if (path === "/api/projects") return shell ? json({ projects: PROJECTS }) : own({ projects: PROJECTS }, { projects: [] });
  if (path.startsWith("/api/projects/") && path.endsWith("/memory")) return json(PROJECT_MEMORY);
  if (path.startsWith("/api/projects/")) return own(PROJECT_DETAIL, { ...PROJECT_DETAIL, conversations: [], files: [] });
  if (path === "/api/library") {
    const deleted = url.searchParams.get("deleted") === "1" || url.searchParams.get("deleted") === "true" || url.searchParams.get("includeDeleted") === "true";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = (deleted ? DELETED_ITEMS : LIBRARY_ITEMS).filter((item) => item.fileName.toLowerCase().includes(q));
    const counts = {
      all: items.length,
      IMAGE: items.filter((i) => i.kind === "IMAGE").length,
      FILE: items.filter((i) => i.kind === "FILE").length,
    };
    return own(
      { items, total: items.length, nextCursor: null, counts, storage: STORAGE },
      { items: [], total: 0, nextCursor: null, counts: { all: 0, IMAGE: 0, FILE: 0 }, storage: { ...STORAGE, usedBytes: 0 } }
    );
  }
  if (path === "/api/library/made") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    // An agent made two of them (its thread), and two are a task's files, so
    // the byline, the deck and the unvalidated-file line can all be seen.
    const madeBy = (id: string) => {
      const owner = AGENTS.find((agent) => agent.id === id);
      return owner ? { id: owner.id, name: owner.name, avatar: owner.avatar } : undefined;
    };
    const items = [
      ...ARTIFACTS.map((item, index) => ({ kind: "artifact", id: item.id, title: item.title, type: item.type, version: item.version, href: `/a/${item.id}`, conversationId: item.conversationId, projectId: null, createdAt: item.createdAt, updatedAt: item.updatedAt, preview: item.preview ?? null, agent: index === 2 ? madeBy("ag-3") : index === 0 ? madeBy("ag-2") : undefined })),
      { kind: "deliverable", id: "d-1", title: "October board update", type: "PRESENTATION", version: 2, href: "/api/work/artifacts/d-1/download", conversationId: "c-3", projectId: null, createdAt: ARTIFACTS[1].createdAt, updatedAt: ARTIFACTS[1].updatedAt, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", validated: true, agent: madeBy("ag-2") },
      { kind: "deliverable", id: "d-2", title: "Q3 forecast against Stripe revenue", type: "SPREADSHEET", version: 1, href: "/api/work/artifacts/d-2/download", conversationId: "c-1", projectId: null, createdAt: ARTIFACTS[3].createdAt, updatedAt: ARTIFACTS[3].updatedAt, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", validated: false },
    ];
    return own({ items: items.filter((item) => item.title.toLowerCase().includes(q)), nextCursor: null }, { items: [], nextCursor: null });
  }
  if (path === "/api/approvals/grants") return own({ grants: [] }, { grants: [] });
  if (path === "/api/settings") return json({ settings: { ...bootstrap().settings, actionApprovalPolicy: "ask_for_any_change", blockedConnectors: [], lockdownMode: false } });
  if (/^\/api\/attachments\/[^/]+\/preview$/.test(path)) return json({ text: "Development fixture.\nThis document preview uses sample content for visual review.", thumbnailUrl: null });
  if (path === "/api/artifacts") {
    if (url.searchParams.get("deleted") === "1") return json({ items: [{ id: "a-9", title: "Old pricing draft", deletedAt: ARTIFACTS[0].updatedAt, purgeAt: new Date(Date.now() + 20 * 86_400_000).toISOString() }] });
    if (url.searchParams.get("projectId")) return json({ items: ARTIFACTS.slice(0, 2) });
    return own({ items: ARTIFACTS }, { items: [] });
  }
  if (path === "/api/connectors") {
    if (page !== "connections") return json({ connectors: CONNECTORS, composioConfigured: false });
    return own({ connectors: CONNECTORS, composioConfigured: false }, { connectors: [], composioConfigured: false });
  }
  if (path === "/api/agents") return page === "agents" ? own({ agents: AGENTS }, { agents: [] }) : json({ agents: AGENTS });
  if (path === "/api/work/schedules") return own({ schedules: SCHEDULES }, { schedules: [] });
  if (path === "/api/memory") {
    return own(
      { memories: richMemories(), summary: SUMMARY, projectSummaries: PROJECT_SUMMARIES },
      { memories: [], summary: null, projectSummaries: [] }
    );
  }
  if (path === "/api/memory/backfill") return json({ remaining: 0 });
  if (path === "/api/memory/edits") return json({ edits: [] });
  if (path === "/api/skills") return own(FIXTURE_LIBRARY, FIXTURE_EMPTY_LIBRARY);
  if (path === "/api/notifications/count") return json({ unreadCount: 2, urgent: false });
  if (path === "/api/notifications") {
    if (page !== "notifications") return json({ notifications: NOTIFICATIONS, unreadCount: 2, nextBefore: null });
    return own({ notifications: NOTIFICATIONS, unreadCount: 2, nextBefore: null }, { notifications: [], unreadCount: 0, nextBefore: null });
  }
  if (path === "/api/recents") return page === "search" ? own({ items: RECENTS, recents: RECENTS }, { items: [], recents: [] }) : json({ items: RECENTS });
  if (path === "/api/search") return own(searchResult(url.searchParams.get("q") ?? ""), { query: "", groups: [], total: 0, coverage: [], partial: false });
  if (path === "/api/work/sessions") return json({ sessions: [] });
  if (path === "/api/code/tasks") return json({ tasks: [] });
  if (path === "/api/code/devices") return json({ devices: [] });
  if (path === "/api/conversations") return json({ conversations: [] });
  // Shell reads that have nothing to show here; answered so the console only
  // lists routes a page actually needs.
  if (path === "/api/announcements" || path === "/api/account/verification" || path === "/api/models") return json({}, 404);
  return null;
}

/** The last body sent to each route, for the few shimmed routes that read one. */
const pendingBody = new Map<string, string>();

function installFixtureFetch(state: PageState, page: PageName): () => void {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      if (typeof init?.body === "string") pendingBody.set(url.pathname, init.body);
      const answer = route(url.pathname, url, method, state, page);
      if (answer) return answer;
      console.warn("[dev/pages] unanswered", method, url.pathname);
      return json({}, 404);
    }
    return real(input, init);
  };
  return () => {
    window.fetch = real;
  };
}

/** Opens a shell surface (the inbox, the palette) once the page is up. */
function Opener({ page }: { page: PageName }) {
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (page === "notifications") openNotifications();
      if (page === "search") window.dispatchEvent(new Event("juno:search"));
    }, 600);
    return () => clearTimeout(timer);
  }, [page]);
  return null;
}

function Page({ page }: { page: PageName }) {
  switch (page) {
    case "library":
      return <LibraryPage />;
    case "projects":
      return <ProjectsPage />;
    case "project":
      return <ProjectDetailPage />;
    case "artifacts":
      return <ArtifactsPage />;
    case "connections":
      return <ConnectionsPage />;
    case "agents":
      return <AgentsHome />;
    case "automations":
      return <AutomationsPage />;
    case "compare":
      return <CompareView />;
    case "settings":
      return <SettingsPage />;
    case "memory":
      return (
        <AppPage measure="reading">
          <MemoryManager />
        </AppPage>
      );
    case "skills":
      return <SkillsLibraryPage />;
    case "notifications":
    case "search":
      return <ProjectsPage />;
  }
}

export function PagesGallery({ page, state }: { page: PageName; state: PageState }) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const restore = installFixtureFetch(state, page);
    setReady(true);
    return restore;
  }, [state, page]);
  const data = React.useMemo(() => bootstrap(), []);
  if (!ready) return null;
  return (
    <AppProvider bootstrap={data}>
      <AppShell>
        <React.Suspense fallback={null}>
          <Page page={page} />
        </React.Suspense>
      </AppShell>
      <Opener page={page} />
    </AppProvider>
  );
}
