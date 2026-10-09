import { Suspense } from "react";
import { notFound } from "next/navigation";
import { SettingsGallery } from "./gallery";

/**
 * Dev-only gallery for Settings: the real rail, pane and sections, fed by
 * fixture data instead of a signed-in account, plus a sheet of every model
 * lab's mark at every size it is drawn.
 *
 *   /dev/settings?section=models           the page frame at one section
 *   /dev/settings?frame=modal&section=...  the modal, open
 *   /dev/settings?frame=logos              the provider marks
 *   /dev/settings?hosts=0                  Devices with no Mac paired
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls and /dev/live-ui.
 */
export default function SettingsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <SettingsGallery />
    </Suspense>
  );
}
