import * as React from "react";
import { SETTINGS_CARD_CLASS, SettingRowSkeleton, SettingsPaneHeaderSkeleton } from "@/components/settings/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SETTINGS_GROUPS } from "@/components/settings/settings-sections";
// The pane header's skeleton takes its line box from the serif `ed-h2`.
import "@/components/app/editorial.css";

/**
 * The full-window settings page, waiting: the same left column (Back to app,
 * search, sections) and the same pane, so nothing moves when it lands.
 */
export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="fixed inset-0 z-modal flex flex-col bg-background md:flex-row">
      {/* No gap of its own, as the page's column has none: its 2px between
          each part set every row 5.6px low. */}
      <div className="flex shrink-0 flex-col border-b border-border/60 bg-sidebar px-3 pb-3 pt-3 md:h-full md:w-64 md:border-b-0 md:border-r md:pt-4">
        <Skeleton className="mb-3 h-9 w-32 rounded-control md:mb-1" />
        {/* The column's serif title (ed-h3, 22px on a 1.2 line: 26.4px). */}
        <div className="hidden px-2.5 pb-4 pt-5 md:block">
          <Skeleton className="h-[26.4px] w-24 rounded-xs" />
        </div>
        {/* Stacked (under md) the rail is one row, the open section's 44px
            menu; as a column, the 36px search over the groups. */}
        <Skeleton className="h-11 w-full rounded-control md:mb-4 md:h-9" />
        {/* The rail as it draws (settings-rail.tsx): each group's name over
            its rows, twelve rows in three groups. It was ten bare rows, two
            short and with no names, so the column jumped when it landed. */}
        <div className="hidden flex-col gap-0.5 md:flex">
          {SETTINGS_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <p aria-hidden="true" className="px-2.5 pb-1.5 pt-5 text-caption text-muted-foreground first:pt-0">
                {group.label}
              </p>
              {group.ids.map((id) => (
                <Skeleton key={id} className="h-[38px] w-full rounded-control" />
              ))}
            </React.Fragment>
          ))}
        </div>
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
