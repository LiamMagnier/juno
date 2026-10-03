"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ProfileView, type ProfileIdentity } from "@/components/profile/profile-view";
import { addDays, computeStreaks, rankModels, todayIn, type ActivityDay, type ProfileActivity } from "@/lib/profile-activity";

const IDENTITY: ProfileIdentity = { id: "fixture-user-maren", name: "Maren Okafor", handle: "maren.okafor", image: null };

/** A seeded generator, so the fixture is the same picture on every load. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heavy(today: string): ProfileActivity {
  const rand = mulberry32(7);
  const all: ActivityDay[] = [];
  for (let i = 400; i >= 0; i--) {
    const date = addDays(today, -i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    // Busier on weekdays, a slow summer, a busy autumn, a few quiet stretches.
    const month = Number(date.slice(5, 7));
    const season = month >= 7 && month <= 8 ? 0.35 : month >= 9 ? 1.4 : 1;
    const active = rand() < (weekday === 0 || weekday === 6 ? 0.35 : 0.78) * (i > 330 ? 0.4 : 1);
    if (!active) continue;
    const base = Math.exp(rand() * 3.2) * 90_000 * season;
    const spike = rand() < 0.03 ? 8 + rand() * 6 : 1;
    all.push({ date, tokens: Math.round(base * spike) });
  }
  const lifetimeTokens = all.reduce((s, d) => s + d.tokens, 0);
  const peakDay = all.reduce<ActivityDay | null>((p, d) => (!p || d.tokens > p.tokens ? d : p), null);
  const models = rankModels([
    { model: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", tokens: lifetimeTokens * 0.41, requests: 3120 },
    { model: "anthropic:claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", tokens: lifetimeTokens * 0.22, requests: 4410 },
    { model: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "openai", tokens: lifetimeTokens * 0.14, requests: 980 },
    { model: "google:gemini-3-pro", label: "Gemini 3 Pro", provider: "google", tokens: lifetimeTokens * 0.09, requests: 610 },
    { model: "deepseek:deepseek-v4", label: "DeepSeek V4", provider: "deepseek", tokens: lifetimeTokens * 0.06, requests: 402 },
    { model: "mistral:mistral-large-3", label: "Mistral Large 3", provider: "mistral", tokens: lifetimeTokens * 0.035, requests: 210 },
    { model: "xai:grok-5", label: "Grok 5", provider: "xai", tokens: lifetimeTokens * 0.025, requests: 120 },
    { model: "moonshot:kimi-k3", label: "Kimi K3", provider: "moonshot", tokens: lifetimeTokens * 0.02, requests: 88 },
  ]);
  return {
    timeZone: "Europe/Paris",
    today,
    memberSince: `${addDays(today, -400)}T09:00:00.000Z`,
    lifetimeTokens,
    peakDay,
    longestTask: { ms: (98 * 60 + 12) * 1000, kind: "work" },
    streak: computeStreaks(
      all.map((d) => d.date),
      today
    ),
    activeDays: all.length,
    days: all.filter((d) => d.date >= addDays(today, -378)),
    models,
    modelCount: 8,
  };
}

function empty(today: string): ProfileActivity {
  return {
    timeZone: "Europe/Paris",
    today,
    memberSince: `${today}T09:00:00.000Z`,
    lifetimeTokens: 0,
    peakDay: null,
    longestTask: null,
    streak: { current: 0, longest: 0 },
    activeDays: 0,
    days: [],
    models: [],
    modelCount: 0,
  };
}

export function ProfileGallery() {
  const params = useSearchParams();
  const fixture = params.get("fixture") ?? "heavy";
  const dark = params.get("theme") === "dark";
  const today = React.useMemo(() => todayIn("Europe/Paris"), []);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const activity = fixture === "new" ? empty(today) : fixture === "loading" || fixture === "error" ? null : heavy(today);
  const identity = fixture === "new" ? { ...IDENTITY, id: "fixture-new", name: "Tomas Lindqvist", handle: "tomas" } : IDENTITY;

  return (
    <div className="h-dvh bg-background text-foreground">
      <ProfileView key={`${fixture}-${dark}`} identity={identity} activity={activity} failed={fixture === "error"} onRetry={() => {}} editHref="#" />
      <nav className="fixed bottom-3 right-3 z-10 flex gap-1 rounded-menu border border-border/60 bg-background/90 p-1 text-caption backdrop-blur" aria-label="Fixtures">
        {["heavy", "new", "loading", "error"].map((f) => (
          <Link key={f} href={`?fixture=${f}${dark ? "&theme=dark" : ""}`} className="rounded-control px-2 py-1 hover:bg-accent" aria-current={f === fixture ? "page" : undefined}>
            {f}
          </Link>
        ))}
        <Link href={`?fixture=${fixture}${dark ? "" : "&theme=dark"}`} className="rounded-control px-2 py-1 hover:bg-accent">
          {dark ? "light" : "dark"}
        </Link>
      </nav>
    </div>
  );
}
