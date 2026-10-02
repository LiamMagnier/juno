import { AudioLines, EyeOff, FileText, Lock, ShieldCheck, SlidersHorizontal, type IconComponent } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import { LandingColumn } from "./section";
import { Reveal, RevealItem, RevealList } from "./reveal";

/** Capabilities explain actual work, rather than duplicating an app window. */
export function Features() {
  return (
    <section aria-labelledby="alevr-capabilities">
      <LandingColumn contentClassName="pb-16 sm:pb-24">
        <Reveal><h2 id="alevr-capabilities" className="max-w-xl font-serif text-display font-medium tracking-tight">Your work, with more possibilities.</h2></Reveal>
        <RevealList className="alevr-capabilities mt-10" amount={0.12}>
          <RevealItem index={0} className="alevr-capability">
            <FileText className="size-6 text-muted-foreground" aria-hidden />
            <h3 className="font-serif text-page-title">A place for what you know.</h3>
            <p className="text-body-lg leading-relaxed text-muted-foreground">Library and Projects bring your files, conversations, and finished work into reach.</p>
            <dl className="alevr-capability-list">
              <div><dt>Bring your context</dt><dd>Work with documents, images, and project files. Keep related conversations together.</dd></div>
              <div><dt>Make something useful</dt><dd>Build documents, diagrams, code, and small apps in the canvas, with versions you can return to.</dd></div>
              <div><dt>Keep it yours</dt><dd>Import your ChatGPT or Claude history. Export your conversations and work when you need them.</dd></div>
            </dl>
          </RevealItem>
          <RevealItem index={1} className="alevr-capability">
            <SlidersHorizontal className="size-6 text-muted-foreground" aria-hidden />
            <h3 className="font-serif text-title">Make Alevr work your way.</h3>
            <p className="text-body leading-relaxed text-muted-foreground">Customize instructions, connect your apps, and add skills. Set the context and permissions that each task needs.</p>
          </RevealItem>
          <RevealItem index={2} className="alevr-capability">
            <div className="flex gap-4 text-muted-foreground"><AudioLines className="size-6" aria-hidden /><AppIcons.research className="size-6" aria-hidden /></div>
            <h3 className="font-serif text-title">More ways to find an answer.</h3>
            <p className="text-body leading-relaxed text-muted-foreground">Speak in realtime, explore sources with Deep Field research, or use tools to work through a problem.</p>
          </RevealItem>
        </RevealList>
      </LandingColumn>
    </section>
  );
}

const PRIVACY: { icon: IconComponent; title: string; body: string }[] = [
  { icon: ShieldCheck, title: "Hosted in France", body: "EU infrastructure, GDPR by default." },
  { icon: Lock, title: "Encrypted at rest", body: "Messages are encrypted in the database." },
  { icon: EyeOff, title: "Never used for training", body: "Your conversations stay yours." },
];
export function Privacy() {
  return (
    <section aria-labelledby="alevr-privacy">
      <LandingColumn contentClassName="py-16 sm:py-20">
        <Reveal><h2 id="alevr-privacy" className="font-serif text-display font-medium tracking-tight">Private by design.</h2></Reveal>
        <RevealList as="ul" className="mt-10 grid gap-8 sm:grid-cols-3">
          {PRIVACY.map(({ icon: Icon, title, body }, i) => <RevealItem as="li" key={title} index={i}><Icon className="size-5 text-muted-foreground" aria-hidden /><h3 className="mt-5 text-heading">{title}</h3><p className="mt-2 text-body text-muted-foreground">{body}</p></RevealItem>)}
        </RevealList>
      </LandingColumn>
    </section>
  );
}
