import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The page frame (docs/design/SOFT_UI.md §3): a scroll region and a centred
 * content column at one of three measures. Every app page opens with this
 * plus an `<AppPageHeader>`, which is what retires the five ad-hoc
 * `max-w-*` values the pages had picked independently.
 *
 *   reading  48rem  prose and settings — a line length the eye can hold
 *   wide     64rem  lists, grids, dashboards
 *   full     none   editors and canvases that own the viewport
 *
 * `.app-page-scroll` / `.app-page-content` (globals.css) carry the scroll
 * containment and the responsive gutter; the measure is the only thing that
 * varies per page. Pass `scroll={false}` when the page sits inside a frame
 * that already scrolls (a tab panel, a modal body).
 */
const MEASURE = {
  reading: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
} as const;

export type AppPageMeasure = keyof typeof MEASURE;

export interface AppPageProps extends React.HTMLAttributes<HTMLDivElement> {
  measure?: AppPageMeasure;
  /** Classes for the content column (the measured element). */
  contentClassName?: string;
  /** `false` when an ancestor already scrolls. */
  scroll?: boolean;
}

const AppPage = React.forwardRef<HTMLDivElement, AppPageProps>(
  ({ measure = "wide", scroll = true, className, contentClassName, children, ...props }, ref) => (
    <div ref={ref} className={cn(scroll && "app-page-scroll", className)} {...props}>
      <div className={cn("app-page-content", MEASURE[measure], contentClassName)}>{children}</div>
    </div>
  )
);
AppPage.displayName = "AppPage";

export { AppPage };
