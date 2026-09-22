"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, settingsHref } from "@/components/settings/settings-sections";
import SettingsLoading from "./loading";

/**
 * `/settings`: the same sections the modal shows, in a page frame, with the
 * rail as a sticky left column. `?section=` names the open section so a link
 * into "Models" or "Plan & usage" can be bookmarked and shared, and so the
 * modal's aliases (`?section=usage`, `?section=permissions`) keep working.
 *
 * The header is the page's name and nothing else. It used to carry the
 * account's email as a lede, one of three places the same address was
 * printed on the Account section alone.
 *
 * `useSearchParams` requires a Suspense boundary above it in a client page
 * or Next bails the whole route out of static rendering; the boundary is
 * here rather than in a layout so the page's own skeleton (loading.tsx) can
 * stand in for it.
 */
function SettingsPageContent() {
  const searchParams = useSearchParams();
  const section = resolveSettingsSection(searchParams.get("section"));

  return (
    <AppPage measure="wide">
      <AppPageHeader heading="Settings" />
      {/* Rail beside pane from 48rem of CONTENT COLUMN, not from a 768px
          window: at a 1024 window with the sidebar out the column is 720, and
          the pane needs what the rail leaves. Below 48rem the rail is a strip
          above the pane, which then has the whole column. */}
      <div className="@[48rem]/page:grid @[48rem]/page:grid-cols-[13.5rem_minmax(0,1fr)] @[48rem]/page:gap-12">
        {/* `@container/rail`: the rail reads ITS OWN width to choose between a
            strip and a column, because it has two parents (this page and the
            modal) that go side by side at different widths. */}
        <aside className="@container/rail mb-7 @[48rem]/page:mb-0">
          <div className="@[48rem]/page:sticky @[48rem]/page:top-6">
            <SettingsRail active={section} hrefFor={settingsHref} />
          </div>
        </aside>
        {/* `@container/pane`: the sections' layouts read the pane, the width
            they actually have, because the same sections render in the modal
            under a different parent. */}
        <div className="@container/pane min-w-0 max-w-2xl">
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
