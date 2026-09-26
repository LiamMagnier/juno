import { AppPage } from "@/components/ui/app-page";
import { SiteFooter, SiteHeader } from "@/components/landing/site-chrome";

/**
 * Shell for Juno's public engineering writing.
 *
 * The same idea as the legal group — a page outside the app shell, on the
 * app's own frame and type scale — with two differences. The measure is `wide`
 * rather than `reading`, because these pages carry tables and a table at a
 * 48rem measure scrolls sideways on a desktop; the article column inside is
 * held to a reading width by the page itself. And the top bar is sticky, so
 * the way back out of a long essay is always one click away.
 *
 * `lang="en"` is stated rather than inherited: the root layout sets the
 * document language from the reader's locale, and these pages are written in
 * English whatever that locale happens to be.
 */
export default function EngineeringLayout({ children }: { children: React.ReactNode }) {
  return (
    <div lang="en" className="relative min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <AppPage scroll={false} measure="wide" contentClassName="pb-20 pt-10 sm:pt-14">
        {children}
      </AppPage>
      <SiteFooter />
    </div>
  );
}
