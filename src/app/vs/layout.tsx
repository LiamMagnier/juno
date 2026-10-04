import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";
import "@/components/home/alv-base.css";
import "@/components/home/home.css";
import "@/components/compare-public/vs.css";

/**
 * Public model comparisons. Outside the app shell, on the homepage's frame,
 * so a reader who lands here from a search result is on the same site as the
 * front door. Not /compare: that is the signed-in side-by-side chat tool.
 *
 * `lang="en"` is stated rather than inherited, as on the engineering pages:
 * the copy is written in English whatever the reader's locale.
 */
export default function VsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div lang="en" className="alevr-public alv relative min-h-dvh">
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}
