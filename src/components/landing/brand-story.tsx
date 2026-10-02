import Image from "next/image";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { LandingColumn } from "./section";
import { Reveal } from "./reveal";

export function BrandStory() {
  return (
    <section aria-labelledby="alevr-origin">
      <LandingColumn contentClassName="py-16 sm:py-24">
        <div className="alevr-brand-story">
          <Reveal className="alevr-origin-copy">
            <div className="alevr-origin-symbols" aria-hidden="true"><span>ℵ</span><ContinuumMark size={64} /></div>
            <h2 id="alevr-origin" className="mt-10 max-w-lg font-serif text-display font-medium tracking-tight">Knowledge that keeps expanding.</h2>
            <p className="mt-5 max-w-md text-body-lg leading-relaxed text-muted-foreground">Alevr is inspired by aleph, used in mathematics for infinite cardinalities. The idea is simple: understanding can keep growing.</p>
            <p className="mt-4 max-w-md text-body leading-relaxed text-muted-foreground">Our Continuum mark holds an open path. A question becomes a conversation. A conversation becomes something you can build on.</p>
          </Reveal>
          <Reveal className="relative aspect-square overflow-hidden rounded-menu" amount={0.2}>
            <Image src="/brand/home-continuity.webp" alt="A continuous silver ribbon with an open center" fill sizes="(max-width:767px) 100vw, 45vw" className="object-cover" />
          </Reveal>
        </div>
      </LandingColumn>
    </section>
  );
}
