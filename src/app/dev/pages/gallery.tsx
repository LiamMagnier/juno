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

  if (method !== "GET") return json({ ok: true });

  if (path === "/api/projects") return shell ? json({ projects: PROJECTS }) : own({ projects: PROJECTS }, { projects: [] });
  if (path.startsWith("/api/projects/") && path.endsWith("/memory")) return json(PROJECT_MEMORY);
  if (path.startsWith("/api/projects/")) return own(PROJECT_DETAIL, { ...PROJECT_DETAIL, conversations: [], files: [] });
  if (path === "/api/library") {
    const deleted = url.searchParams.get("deleted") === "1" || url.searchParams.get("deleted") === "true";
    const items = deleted ? DELETED_ITEMS : LIBRARY_ITEMS;
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
  if (path === "/api/artifacts") {
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

function installFixtureFetch(state: PageState, page: PageName): () => void {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
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
