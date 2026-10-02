import Link from "next/link";
import { Globe, Laptop, Smartphone } from "@/components/ui/icons";
import { Section } from "./section";
import { Reveal } from "./reveal";

export function Platforms() {
  return (
    <Section id="apps" heading="Wherever the work takes you." lede="One account for the browser and native apps. Pick up your conversations with their context intact.">
      <Reveal className="alevr-platforms">
        <div className="rounded-menu bg-card p-8 sm:p-10">
          <Laptop aria-hidden className="size-8 text-muted-foreground" />
          <h3 className="font-serif text-page-title">Alevr for Mac</h3>
          <p className="mt-3 max-w-md text-body-lg leading-relaxed text-muted-foreground">Chat and Code in a native workspace. Bring your repository, review changes, and keep your work close.</p>
          <Link className="alevr-text-link mt-6" href="/download">Download for Mac</Link>
        </div>
        <div className="py-4">
          <div><Globe aria-hidden className="size-5 text-muted-foreground" /><h3 className="font-serif text-title">In your browser</h3><p className="mt-3 text-body text-muted-foreground">Nothing to install. Sign in from any computer.</p><Link href="/sign-up" className="alevr-text-link mt-3">Create account</Link></div>
          <div className="border-t border-border pt-7"><Smartphone aria-hidden className="size-5 text-muted-foreground" /><h3 className="font-serif text-title">On your iPhone</h3><p className="mt-3 text-body text-muted-foreground">Voice, camera, and your projects in your pocket. Coming to the App Store.</p></div>
        </div>
      </Reveal>
    </Section>
  );
}
