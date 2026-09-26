import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Plate } from "@/components/landing/plate";
import { LandingColumn } from "@/components/landing/section";
import { Reveal } from "@/components/landing/reveal";

/**
 * The last thing on the page before the footer: the sea horizon at golden hour
 * and one invitation. The type sits in the plate's open sky, over a soft scrim
 * that runs from the ground colour so the heading holds 4.5:1 in both themes
 * whatever the paint does underneath.
 */
export function Closing() {
  return (
    <section>
      <LandingColumn contentClassName="pb-16 sm:pb-24">
        <Reveal>
          <div className="stage rounded-stage">
            <Plate name="horizon" dim sizes="(min-width: 1280px) 1200px, 100vw" imageClassName="object-[50%_65%]" />
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_30%,hsl(var(--background)/0.55),transparent_75%)]"
            />
            <div className="relative flex min-h-[26rem] flex-col items-center justify-center px-6 py-16 text-center sm:min-h-[30rem]">
              <h2 className="max-w-[18ch] text-balance font-serif text-hero font-medium tracking-tight text-foreground">
                The right model for every task.
              </h2>
              <p className="mt-4 max-w-md text-pretty text-body-lg text-foreground/80">
                Free to start. Every model on a paid plan, metered honestly.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button asChild size="lg">
                  <Link href="/sign-up">
                    Start with Juno
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="secondary">
                  <Link href="/download">Download for Mac</Link>
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </LandingColumn>
    </section>
  );
}
