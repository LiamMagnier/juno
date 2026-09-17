"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, type SettingsSectionId } from "@/components/settings/settings-sections";
import SettingsLoading from "./loading";

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
      <AppPageHeader heading="Settings" lede={user.email} />
      {/* Rail beside pane from 48rem of CONTENT COLUMN, not from a 768px
          window. At a 1024 window with the sidebar out the column is 720, and
          `md:` gave the pane 720 − 216 − 40 = 464px — four Stat cards at 95px
          each. Below 48rem the rail is a strip above the pane, which then has
          the whole column. */}
      <div className="@[48rem]/page:grid @[48rem]/page:grid-cols-[13.5rem_minmax(0,1fr)] @[48rem]/page:gap-10">
        {/* `@container/rail`: the rail reads ITS OWN width to choose between a
            strip and a column (settings-rail.tsx), because it has two parents —
            this page and the settings modal — that go side by side at
            different widths. */}
        <aside className="@container/rail mb-6 @[48rem]/page:mb-0">
          <div className="@[48rem]/page:sticky @[48rem]/page:top-2">
            <SettingsRail active={section} hrefFor={hrefFor} onSelect={select} />
          </div>
        </aside>
        {/* `@container/pane`: the sections' grids read the pane — the width
            they actually have — because the same sections render in the modal
            under a different parent. */}
        <div className="@container/pane min-w-0 max-w-3xl">
          <SettingsPane section={section} />
        </div>
      </div>
    </AppPage>
  );
}

export default function SettingsPage() {
  return (
    // The route's own skeleton, not `null`: on a client-side navigation the
    // segment's loading.tsx is not shown for this boundary, so a null fallback
    // was a blank column for a frame before the rail and pane landed.
    <React.Suspense fallback={<SettingsLoading />}>
      <SettingsPageContent />
    </React.Suspense>
  );
}
