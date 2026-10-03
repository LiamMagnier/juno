import { SETTINGS_CARD_CLASS, SettingRowSkeleton, SettingsPaneHeaderSkeleton } from "@/components/settings/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-sections";
// The pane header's skeleton takes its line box from the serif `ed-h2`.
import "@/components/app/editorial.css";

/**
 * The full-window settings page, waiting: the same left column (Back to app,
 * search, sections) and the same pane, so nothing moves when it lands.
 */
export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="fixed inset-0 z-modal flex flex-col bg-background md:flex-row">
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/60 bg-sidebar px-3 pb-3 pt-3 md:h-full md:w-64 md:border-b-0 md:border-r md:pt-4">
        <Skeleton className="mb-3 h-9 w-32 rounded-control md:mb-1" />
        {/* The column's serif title (ed-h3, 22px on a 1.2 line). */}
        <div className="hidden px-2.5 pb-4 pt-5 md:block">
          <Skeleton className="h-[26px] w-24 rounded-xs" />
        </div>
        <Skeleton className="mb-4 h-9 w-full rounded-control" />
        {SETTINGS_SECTIONS.map((section) => (
          <Skeleton key={section.id} className="hidden h-[38px] w-full rounded-control md:block" />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[44rem] px-5 pb-24 pt-8 sm:px-10 md:pt-16">
          <SettingsPaneHeaderSkeleton />
          <div className={SETTINGS_CARD_CLASS}>
            {[...Array(4)].map((_, i) => (
              <SettingRowSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
