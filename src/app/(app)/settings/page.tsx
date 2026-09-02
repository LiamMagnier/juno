"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppIcons } from "@/lib/app-icons";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, type SettingsSectionId } from "@/components/settings/settings-sections";

/**
 * `/settings` — the same nine sections the modal shows, in a page frame, with
 * the rail as a sticky left column. `?section=` names the open section so a
 * link into "Models" or "Plan & billing" can be bookmarked and shared, and so
 * the modal's aliases (`?section=usage`) keep working.
 *
 * `useSearchParams` requires a Suspense boundary above it in a client page
 * or Next bails the whole route out of static rendering; the boundary is
 * here rather than in a layout so the page's own skeleton (loading.tsx) can
 * stand in for it.
 */
function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useApp();
  const section = resolveSettingsSection(searchParams.get("section"));

  const hrefFor = (id: SettingsSectionId) => (id === "general" ? "/settings" : `/settings?section=${id}`);
  const select = (id: SettingsSectionId) => router.replace(hrefFor(id), { scroll: false });

  return (
    <AppPage measure="wide">
      <AppPageHeader eyebrow="Settings" heading="Settings" icon={AppIcons.settings} lede={user.email} />
      <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
        <aside className="mb-6 md:mb-0">
          <div className="md:sticky md:top-2">
            <SettingsRail active={section} hrefFor={hrefFor} onSelect={select} />
          </div>
        </aside>
        <div className="min-w-0 max-w-3xl">
          <SettingsPane section={section} />
        </div>
      </div>
    </AppPage>
  );
}

export default function SettingsPage() {
  return (
    <React.Suspense fallback={null}>
      <SettingsPageContent />
    </React.Suspense>
  );
}
