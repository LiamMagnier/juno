import { PublicAction } from "@/components/public/public-motion";
import { LandingColumn } from "./section";
import { Reveal } from "./reveal";

export function Closing() {
  return (
    <section className="alevr-closing">
      <LandingColumn contentClassName="py-16 sm:py-24">
        <Reveal><h2 className="max-w-2xl font-serif text-display font-medium tracking-tight sm:text-hero">Make room for your next idea.</h2><p className="mt-5 max-w-md text-body-lg text-muted-foreground">A free account gives you room to try Alevr.</p><div className="mt-8"><PublicAction href="/sign-up">Create account</PublicAction></div></Reveal>
      </LandingColumn>
    </section>
  );
}
