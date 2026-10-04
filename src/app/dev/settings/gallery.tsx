"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AppProvider } from "@/components/app/app-provider";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { Pressable } from "@/components/ui/pressable";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { SettingsModal } from "@/components/settings/settings-modal";
import { choiceTriggerClass } from "@/components/settings/choice-menu";
import { menuRowClass } from "@/components/ui/menu-recipe";
import {
  resolveSettingsSection,
  settingsHref,
  type SettingsSectionId,
} from "@/components/settings/settings-sections";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { checkUsername } from "@/lib/username";
import type { AppBootstrap } from "@/types/app";
import { cn } from "@/lib/utils";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 22, 15, 0, 0);

const BOOTSTRAP: AppBootstrap = {
  user: { id: "dev-user", name: "Liam", email: "liam@example.com", image: null, username: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: "anthropic:claude-opus-5-5",
    personality: "concise",
    customInstructions:
      "I'm a product engineer. Keep answers short, lead with the answer, and show code before explaining it.",
    responseLanguage: "auto",
    uiLocale: "auto",
    memoryEnabled: true,
    memorySensitiveTopics: ["finances"],
    memoryBackgroundLearning: true,
    backgroundProviderMode: "same_provider",
    voiceId: "marin",
    favoriteModels: ["anthropic:claude-opus-5-5", "openai:gpt-6-sol", "google:gemini-3.1-pro-preview", "moonshot:kimi-k3"],
    emailBudgetAlerts: true,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {
    spentMicroUsd: 18_420_000,
    budgetMicroUsd: 50_000_000,
    eurPerUsd: 0.92,
    reservedMicroUsd: 120_000,
    capSource: "plan",
    capDisabled: false,
    userCapEur: null,
    planBudgetMicroUsd: 50_000_000,
    windows: {
      session: { pct: 0.32, spentMicroUsd: 1_200_000, budgetMicroUsd: 3_750_000, resetsAtMs: NOW + 3 * 3_600_000 + 12 * 60_000 },
      weekly: { pct: 0.61, spentMicroUsd: 8_000_000, budgetMicroUsd: 13_000_000, resetsAtMs: NOW + 2 * DAY_MS },
    },
    billing: { renewsAtMs: NOW + 11 * DAY_MS, cancelAtPeriodEnd: false },
  },
  conversations: [],
  folders: [],
  features: {
    billing: true,
    purchasablePlans: ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"],
    purchasableAnnualPlans: ["PRO"],
    serverStt: true,
    serverTts: true,
    ttsProvider: "google",
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: true,
    providers: Object.keys(PROVIDERS) as Provider[],
    isOwner: false,
  },
};

function host(overrides: Record<string, unknown>) {
  return {
    id: "host-1",
    deviceId: "device-1",
    displayName: "Liam’s MacBook Pro",
    platform: "macOS 27.2",
    appVersion: "3.4.0",
    protocolVersion: 4,
    enabled: true,
    allowsFileWork: true,
    allowsBrowser: true,
    allowsComputerUse: false,
    allowsShell: true,
    allowsBackground: true,
    capabilities: {},
    capabilitiesVersion: 1,
    allowedApps: [],
    blockedApps: [],
    allowedDomains: [],
    approvalPolicy: "balanced",
    state: "idle",
    lastSeenAt: new Date(NOW - 40_000).toISOString(),
    activeRunCount: 0,
    queuedRunCount: 0,
    revokedAt: null,
    createdAt: new Date(NOW - 40 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - DAY_MS).toISOString(),
    ...overrides,
  };
}

function breakdown() {
  const start = Math.floor(NOW / DAY_MS) * DAY_MS - 29 * DAY_MS;
  const shape = [4, 9, 0, 12, 18, 7, 0, 0, 22, 31, 14, 9, 3, 0, 11, 26, 38, 19, 8, 0, 0, 16, 21, 29, 12, 5, 0, 9, 24, 17];
  const daily = shape
    .map((requests, i) => ({ dayMs: start + i * DAY_MS, requests, totalTokens: requests * 5400, costMicroUsd: requests * 61_000 }))
    .filter((d) => d.requests > 0);
  const requests = daily.reduce((n, d) => n + d.requests, 0);
  return {
    range: { startMs: start, endMs: NOW, days: 30 },
    totals: { requests, promptTokens: 0, completionTokens: 0, totalTokens: requests * 5400, costMicroUsd: requests * 61_000 },
    surfaces: [],
    models: [],
    sources: [],
    daily,
    activeDays: daily.length,
    currentStreakDays: 3,
    longestStreakDays: 9,
    pace: { lastHour: 1, last24h: 17 },
  };
}

function fixtureFor(url: URL, method: string, hostsParam: string | null): unknown | undefined {
  const path = url.pathname;
  if (path === "/api/settings" && method === "PATCH") return { ok: true };
  if (path === "/api/settings") {
    return { settings: { actionApprovalPolicy: "ask_for_important_actions", lockdownMode: false, blockedConnectors: ["notion"] } };
  }
  if (path === "/api/connectors") {
    return {
      connectors: [
        { id: "github", kind: "oauth", label: "GitHub", description: "", capability: "Repositories", configured: true, connected: true, accountLabel: "lmagnier", connectedAt: new Date(NOW - 90 * DAY_MS).toISOString() },
        { id: "apple-calendar", kind: "local", label: "Calendar", description: "", capability: "Events", configured: true, connected: true, accountLabel: "iCloud", connectedAt: null },
        { id: "slack", kind: "oauth", label: "Slack", description: "", capability: "Messages", configured: true, connected: true, accountLabel: "juno-team", connectedAt: null },
        { id: "linear", kind: "oauth", label: "Linear", description: "", capability: "Issues", configured: true, connected: false, accountLabel: null, connectedAt: null },
      ],
    };
  }
  if (path === "/api/work/hosts") {
    if (hostsParam === "0") return { hosts: [] };
    return {
      hosts: [
        host({ state: "online", activeRunCount: 1 }),
        host({ id: "host-2", deviceId: "device-2", displayName: "Studio Mac mini", state: "offline", lastSeenAt: new Date(NOW - 3 * DAY_MS).toISOString() }),
      ],
    };
  }
  if (path === "/api/share") {
    return {
      shares: [
        { id: "s1", kind: "CHAT", url: "https://juno.example/share/s1", title: "Pricing page rewrite", snapshotAt: new Date(NOW - 4 * DAY_MS).toISOString(), views: 23 },
        { id: "s2", kind: "ARTIFACT", url: "https://juno.example/share/s2", title: "Quarterly usage dashboard", snapshotAt: new Date(NOW - 18 * DAY_MS).toISOString(), views: 1 },
      ],
    };
  }
  if (path === "/api/profile/usage/breakdown") return breakdown();
  if (path === "/api/account/username") return usernameFixture(url, method);
  if (path === "/api/account/mfa") {
    return { enabled: true, pending: false, enabledAt: new Date(NOW - 60 * DAY_MS).toISOString(), recoveryCodesRemaining: 8, hasPassword: true };
  }
  return undefined;
}

/**
 * The username field's server, for its states: these names are taken, any
 * other valid one is available, and a save answers with the name it was sent.
 * `?username=` on the page sets the account's current one.
 */
const TAKEN_USERNAMES = new Set(["maren", "alex", "liam", "tomas"]);
let pendingUsername: string | null = null;
function usernameFixture(url: URL, method: string): unknown {
  if (method === "PATCH") return { ok: true, username: pendingUsername, handle: pendingUsername };
  const check = url.searchParams.get("check");
  if (check === null) return { username: null, handle: "liam" };
  const result = checkUsername(check);
  if (!result.ok) return { username: check, available: false, problem: result.problem, message: result.message };
  pendingUsername = result.username;
  return TAKEN_USERNAMES.has(result.username)
    ? { username: result.username, available: false, problem: "taken", message: "That username is taken." }
    : { username: result.username, available: true };
}

/**
 * Answers the sections' requests from fixtures, so the real components render
 * without an account. Installed on first render of this dev page only.
 */
let installed = false;
function installFixtures(hostsParam: string | null) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      const body = fixtureFor(url, (init?.method ?? "GET").toUpperCase(), hostsParam);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (body !== undefined) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Not in the fixture" }), { status: 404 });
    }
    return realFetch(input, init);
  };
  // The app provider opens the account's sync stream; there is no account here.
  class SilentEventSource {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  (window as unknown as { EventSource: unknown }).EventSource = SilentEventSource;
}

const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];

function LogoSheet() {
  const sizes = [
    { cls: "size-3.5", label: "14" },
    { cls: "size-4", label: "16" },
    { cls: "size-5", label: "20" },
  ];
  return (
    <div className="space-y-10 p-8">
      <h1 className="text-title">Provider marks</h1>
      <table className="text-ui">
        <thead>
          <tr className="text-left text-caption text-muted-foreground">
            <th className="pb-3 pr-6 font-medium">Lab</th>
            {sizes.map((s) => (
              <th key={s.label} className="pb-3 pr-6 font-medium">
                {s.label}px
              </th>
            ))}
            <th className="pb-3 pr-6 font-medium">Tile 32</th>
            <th className="pb-3 pr-6 font-medium">Tile 44</th>
            <th className="pb-3 pr-6 font-medium">Chip</th>
            <th className="pb-3 pr-6 font-medium">Select</th>
            <th className="pb-3 font-medium">Menu row</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDER_LIST.map((p) => (
            <tr key={p} className="border-t border-border/60">
              <td className="py-2.5 pr-6 text-muted-foreground">{PROVIDERS[p].label.split(" · ")[0]}</td>
              {sizes.map((s) => (
                <td key={s.label} className="py-2.5 pr-6">
                  <ProviderLogo provider={p} className={s.cls} />
                </td>
              ))}
              <td className="py-2.5 pr-6">
                <ProviderLogo provider={p} tile />
              </td>
              <td className="py-2.5 pr-6">
                <ProviderLogo provider={p} tile className="size-11" />
              </td>
              <td className="py-2.5 pr-6">
                <Pressable kind="chip" size="lg" selected={p === "anthropic"}>
                  <ProviderLogo provider={p} className="size-3.5" />
                  Model
                </Pressable>
              </td>
              <td className="py-2.5 pr-6">
                <span className={cn(choiceTriggerClass, "w-44 justify-start")}>
                  <ProviderLogo provider={p} className="size-4 text-foreground" />
                  <span className="truncate">Flagship 5</span>
                </span>
              </td>
              <td className="py-2.5">
                <span className={cn(menuRowClass, "w-44 bg-accent")}>
                  <ProviderLogo provider={p} className="size-4" />
                  <span className="truncate">Flagship 5</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-body text-muted-foreground">
        {PROVIDER_LIST.map((p) => (
          <span key={p} className="inline-flex items-center gap-2 text-foreground">
            <ProviderLogo provider={p} className="size-4" />
            {PROVIDERS[p].label.split(" · ")[0]}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SettingsGallery() {
  const params = useSearchParams();
  const frame = params.get("frame") ?? "page";
  const section = resolveSettingsSection(params.get("section"));
  installFixtures(params.get("hosts"));

  const [modalSection, setModalSection] = React.useState<SettingsSectionId>(section);
  const username = params.get("username");
  const bootstrap = React.useMemo<AppBootstrap>(
    () => ({ ...BOOTSTRAP, user: { ...BOOTSTRAP.user, username: username || null } }),
    [username]
  );

  if (frame === "logos") return <LogoSheet />;

  return (
    <AppProvider bootstrap={bootstrap}>
      {frame === "modal" ? (
        <main className="app-main-canvas min-h-dvh">
          <SettingsModal open onOpenChange={() => {}} section={modalSection} onSectionChange={setModalSection} via="pointer" />
        </main>
      ) : (
        <main className="app-main-canvas min-h-dvh">
          <AppPage measure="wide" scroll={false}>
            <AppPageHeader heading="Settings" />
            <div className="@[48rem]/page:grid @[48rem]/page:grid-cols-[13.5rem_minmax(0,1fr)] @[48rem]/page:gap-12">
              <aside className="@container/rail mb-7 @[48rem]/page:mb-0">
                <div className="@[48rem]/page:sticky @[48rem]/page:top-6">
                  <SettingsRail active={section} hrefFor={(id) => settingsHref(id).replace("/settings", "/dev/settings")} />
                </div>
              </aside>
              <div className="@container/pane min-w-0 max-w-2xl">
                <SettingsPane section={section} />
              </div>
            </div>
          </AppPage>
        </main>
      )}
    </AppProvider>
  );
}
