import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { ActivitySkeleton } from "@/components/activity/activity-view";

/** The header, then the grouped rows at the height the real list settles at. */
export default function ActivityLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading your activity">
      <AppPageHeaderSkeleton headingWidth="w-28" />
      <ActivitySkeleton />
    </AppPage>
  );
}
