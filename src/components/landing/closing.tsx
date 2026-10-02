import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LandingColumn } from "./section";
import { Reveal } from "./reveal";

export function Closing() {
  return (
    <section className="alevr-closing">
      <LandingColumn contentClassName="py-16 sm:py-24">
        <Reveal><h2 className="max-w-2xl font-serif text-display font-medium tracking-tight sm:text-hero">Start with a conversation.<br />See where it takes you.</h2><p className="mt-5 max-w-md text-body-lg text-muted-foreground">A free account gives you room to try Alevr.</p><Button asChild size="lg" className="mt-8"><Link href="/sign-up">Create account<ArrowRight aria-hidden /></Link></Button></Reveal>
      </LandingColumn>
    </section>
  );
}
