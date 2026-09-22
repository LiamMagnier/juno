import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { SettingRowSkeleton, SettingsPaneHeaderSkeleton } from "@/components/settings/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-sections";

/**
 * The settings page in its own shape: the rail on the left, the pane's
 * heading and a few rows on the right, so nothing jumps when the real
 * sections land.
 *
 * The header matches the real one exactly: a heading with no back row and no
 * lede (`AppPageHeaderSkeleton` draws neither by default), so the page does
 * not lift when it arrives. The pane header and the rows come from
 * setting-row.tsx, where the real ones live, and stand rows on hairlines in
 * for rows on hairlines: the pane draws no cards, so its placeholder draws
 * none either.
 *
 * No stagger: the skeleton is a picture of the page about to arrive, not a
 * sequence, and a deal-in that is still playing when the content lands is
 * motion for nothing.
 *
 * The layout keys on the same containers the real page does: the `page`
 * column for rail-beside-pane, the rail's own `@container/rail` for strip or
 * column. Keyed to `md:`, a 1024 window with the sidebar out drew the
 * skeleton side by side and then landed a stacked page on it.
 */
export default function SettingsLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading settings">
      <AppPageHeaderSkeleton headingWidth="w-40" lede={false} />

      <div className="@[48rem]/page:grid @[48rem]/page:grid-cols-[13.5rem_minmax(0,1fr)] @[48rem]/page:gap-12">
        <div className="@container/rail mb-7 @[48rem]/page:mb-0">
          <div className="flex flex-col gap-0.5 overflow-hidden @[16rem]/rail:flex-row @[16rem]/rail:gap-1">
            {SETTINGS_SECTIONS.map((section) => (
              // 38px is a `Pressable kind="row"`: a `text-body` line (24) plus
              // `py-1.5` (12) plus the 1px border each side. In the stacked
              // layout the rail sits ABOVE the pane, so a row that is off by
              // any amount here moves everything under it by the difference.
              <Skeleton
                key={section.id}
                className="h-[38px] w-full shrink-0 rounded-control @[16rem]/rail:w-28"
              />
            ))}
          </div>
        </div>
        <div className="min-w-0 max-w-2xl">
          <SettingsPaneHeaderSkeleton />
          <div className="divide-y divide-border/60">
            {[...Array(4)].map((_, i) => (
              <SettingRowSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </AppPage>
  );
}
