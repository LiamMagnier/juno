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
 */
export default function SettingsLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading settings">
      <AppPageHeaderSkeleton headingWidth="w-40" />

      <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
        <div className="surface-inset mb-6 flex gap-1 rounded-card p-1.5 md:mb-0 md:flex-col">
          {[...Array(9)].map((_, i) => (
            // 37.5px is a `Pressable kind="row"`: a `text-ui` line (19.5) plus
            // `py-2` (16) plus the 1px border each side. Below `md:` the rail
            // sits ABOVE the pane, so a `h-9` row here moved everything under
            // it by the difference.
            <Skeleton
              key={i}
              className="h-[37.5px] w-28 shrink-0 rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in md:w-full"
              style={staggerDelay(i, "tight")}
            />
          ))}
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
