import Link from "next/link";
import { ArrowRight, Globe, Laptop, Smartphone } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Plate } from "@/components/landing/plate";
import { ProductShot, hasProductShot } from "@/components/landing/product-shot";
import { Reveal, RevealItem, RevealList } from "@/components/landing/reveal";
import { Section } from "@/components/landing/section";

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

const MAC_SHOT = "mac-code-session";
const PHONE_SHOT = "ios-chat";

export function Platforms() {
  const mac = hasProductShot(MAC_SHOT);
  const phone = hasProductShot(PHONE_SHOT);
  return (
    <Section
      id="apps"
      heading="Start anywhere. Pick up everywhere."
      lede="One account across the web, your Mac and your iPhone. Conversations, projects and memory follow you."
    >
      <RevealList className="mt-10 grid gap-4 lg:grid-cols-12 lg:grid-rows-[auto_auto]">
        <RevealItem index={0} className="stage flex flex-col rounded-stage lg:col-span-8 lg:row-span-2">
          <Plate name="valley" sizes="(min-width: 1024px) 800px, 100vw" imageClassName="object-[60%_40%]" />
          <div className="relative p-6 sm:p-8">
            <GlyphTile icon={Laptop} />
            <h3 className="mt-4 text-title text-foreground">Juno for Mac</h3>
            <p className="mt-2 max-w-md text-body text-foreground/80">
              A native app with Juno Code built in. It reads your repository, runs your tests and asks before it
              changes anything.
            </p>
            <Button asChild variant="secondary" className="mt-5">
              <Link href="/download">
                Download for Mac
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
          {mac ? (
            <div className="relative mt-auto pl-6 sm:pl-10">
              <div className="stage-window overflow-hidden rounded-tl-panel">
                <ProductShot
                  name={MAC_SHOT}
                  alt="Juno Code on Mac: a session fixing a failing test, with the diff beside the transcript"
                  width={2400}
                  height={1500}
                  sizes="(min-width: 1024px) 760px, 95vw"
                />
              </div>
            </div>
          ) : (
            <div className="min-h-40 flex-1 lg:min-h-72" />
          )}
        </RevealItem>

        <RevealItem index={1} className="stage flex flex-col rounded-stage lg:col-span-4 lg:row-span-2">
          <Plate name="path" dim sizes="(min-width: 1024px) 400px, 100vw" imageClassName="object-[50%_70%]" />
          <div className="relative p-6 sm:p-8">
            <GlyphTile icon={Smartphone} />
            <h3 className="mt-4 text-title text-foreground">Juno for iPhone</h3>
            <p className="mt-2 max-w-[15rem] text-body text-foreground/80">
              Voice, camera and your projects in your pocket. Coming to the App Store.
            </p>
          </div>
          {phone ? (
            <div className="relative mx-auto mt-auto w-3/5 max-w-60">
              <div className="stage-window overflow-hidden rounded-t-stage">
                <ProductShot
                  name={PHONE_SHOT}
                  alt="Juno for iPhone: a conversation with the composer at the bottom"
                  width={1179}
                  height={2556}
                  sizes="240px"
                />
              </div>
            </div>
          ) : (
            <div className="min-h-40 flex-1" />
          )}
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
            <Link href="/sign-up">Start with Juno</Link>
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}

function GlyphTile({ icon: Icon }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }) {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-field bg-card/80 text-foreground shadow-sm ring-1 ring-foreground/5 backdrop-blur">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}
