import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { SettingRowSkeleton, SettingsPaneHeaderSkeleton } from "@/components/settings/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The settings page in its own shape: the rail well on the left, the pane's
 * heading and a few rows on the right — so nothing jumps when the real
 * sections land.
 *
 * The pane header and the rows come from setting-row.tsx, where the real ones
 * live. This file used to draw the header by hand at three wrong numbers and
 * the pane dropped 7.5px on arrival; see SettingsPaneHeaderSkeleton for the
 * arithmetic. Under it stood four `h-16` cards on `space-y-4` for a pane that
 * has no cards — every section is rows on hairlines — so the placeholder was
 * the outline of a different page than the one that replaced it.
 *
 * The layout keys on the same containers the real page does — the `page`
 * column for rail-beside-pane, the rail's own `@container/rail` for strip or
 * column — not on the window. Keyed to `md:`, a 1024 window with the sidebar
 * out drew the skeleton side by side and then landed a stacked page on it.
 */
export default function SettingsLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading settings">
      <AppPageHeaderSkeleton headingWidth="w-40" />

      <div className="@[48rem]/page:grid @[48rem]/page:grid-cols-[13.5rem_minmax(0,1fr)] @[48rem]/page:gap-10">
        <div className="@container/rail mb-6 @[48rem]/page:mb-0">
          <div className="surface-inset flex flex-col gap-1 overflow-hidden rounded-card p-1.5 @[16rem]/rail:flex-row">
            {[...Array(9)].map((_, i) => (
              // 38px is a `Pressable kind="row"`: a `text-body` line (24) plus
              // `py-1.5` (12) plus the 1px border each side. In the stacked
              // layout the rail sits ABOVE the pane, so a row that is off by
              // any amount here moves everything under it by the difference.
              <Skeleton
                key={i}
                className="h-[38px] w-full shrink-0 rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in @[16rem]/rail:w-28"
                style={staggerDelay(i, "tight")}
              />
            ))}
          </div>
        </div>
        <div className="min-w-0 max-w-3xl">
          <SettingsPaneHeaderSkeleton />
          <div className="divide-y divide-border/60">
            {[...Array(4)].map((_, i) => (
              <SettingRowSkeleton
                key={i}
                className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "base")}
              />
            ))}
          </div>
        </div>
      </div>
    </AppPage>
  );
}
