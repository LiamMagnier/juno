import Link from "next/link";
import { ArrowRight, Globe, Laptop, Smartphone } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Reveal, RevealItem, RevealList } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Where Juno runs, as three cells of different weight: the Mac app is the
 * deepest product (Chat and Code in one window), the iPhone app is the
 * companion, the browser is the zero-install door. Three cells for three
 * things; the Mac cell spans two rows because it carries a real window.
 *
 * Shots come from the native lanes' offscreen renders (product-shot.tsx). A
 * cell whose shot is missing shows its plate and glyph alone, which is a
 * complete composition, not a hole.
 */


export function Platforms() {
  return (
    <Section
      id="apps"
      heading="Start anywhere. Pick up everywhere."
      lede="One account across the web, your Mac and your iPhone. Conversations, projects and memory follow you."
    >
      <RevealList className="mt-10 grid gap-4 lg:grid-cols-12 lg:grid-rows-[auto_auto]">
        <RevealItem index={0} className="stage flex flex-col rounded-stage lg:col-span-8 lg:row-span-2">
          <div className="relative p-6 sm:p-8">
            <GlyphTile icon={Laptop} />
            <h3 className="mt-4 font-serif text-title text-foreground">{`${PRODUCT_NAME} for Mac`}</h3>
            <p className="mt-2 max-w-md text-body text-foreground/80">
              {`A native app with ${PRODUCT_NAME} Code built in. It reads your repository, runs your tests and asks before it changes anything.`}
            </p>
            <Button asChild variant="secondary" className="mt-5">
              <Link href="/download">
                Download for Mac
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </RevealItem>

        <RevealItem index={1} className="stage flex flex-col rounded-stage lg:col-span-4 lg:row-span-2">
          <div className="relative p-6 sm:p-8">
            <GlyphTile icon={Smartphone} />
            <h3 className="mt-4 font-serif text-title text-foreground">{`${PRODUCT_NAME} for iPhone`}</h3>
            <p className="mt-2 max-w-[15rem] text-body text-foreground/80">
              Voice, camera and your projects in your pocket. Coming to the App Store.
            </p>
          </div>
        </RevealItem>
      </RevealList>

      <Reveal className="mt-4">
        <div className="surface-raised flex flex-col gap-5 rounded-stage p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="flex items-start gap-4">
            <GlyphTile icon={Globe} />
            <div>
              <h3 className="text-heading text-foreground">In any browser</h3>
              <p className="mt-1 max-w-lg text-body text-muted-foreground">
                Nothing to install. Sign in and your history is there, on any computer.
              </p>
            </div>
          </div>
          <Button asChild className="shrink-0">
            <Link href="/sign-up">{`Start with ${PRODUCT_NAME}`}</Link>
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}

function GlyphTile({ icon: Icon }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }) {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-field bg-card/80 text-foreground  ">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}
