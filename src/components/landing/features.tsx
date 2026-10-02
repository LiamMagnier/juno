import { ArrowRight, AudioLines, EyeOff, FileUp, Lock, ShieldCheck, type IconComponent } from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { LandingColumn } from "@/components/landing/section";
import { Reveal, RevealItem, RevealList } from "@/components/landing/reveal";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";

/**
 * What ships, every line of it today. The heading holds its place on the left
 * while the list scrolls past on the right (sticky from `lg`), so the section
 * reads as one statement with its evidence, not a brochure grid.
 *
 * Each glyph is the SAME drawing the product uses for that feature behind the
 * sign-in wall (src/lib/app-icons.ts), in a soft tile. The rows are not links,
 * so a hover only warms the tile: an acknowledgement, never a promise of a click.
 */

interface Feature {
  title: string;
  body: string;
  icon: IconComponent;
  link?: { href: string; label: string };
}

const FEATURES: Feature[] = [
  {
    title: "Realtime voice",
    // The waveform the composer's voice-mode button draws; the mic is dictation.
    icon: AudioLines,
    body: "Talk with any model, live and interruptible, transcribed both ways. Voice notes drop straight into chat.",
  },
  {
    title: "Artifacts and canvas",
    icon: AppIcons.artifacts,
    body: "Code, documents, diagrams and small apps render live beside the conversation, versioned as they change.",
  },
  {
    title: "Projects and memory",
    icon: AppIcons.projects,
    body: `Group related work, attach files, and let ${PRODUCT_NAME} carry context across conversations when you want it to.`,
  },
  {
    title: FEATURE_NAMES.research.label,
    icon: AppIcons.research,
    body: `${FEATURE_NAMES.research.description}: approve the search plan, follow the sources live, steer the run, and get a report with checked citations.`,
  },
  {
    title: `${PRODUCT_NAME} Code`,
    icon: AppIcons.code,
    body: `On your Mac, ${PRODUCT_NAME} Code works in an isolated worktree, runs your tests and shows every diff. It asks before it acts.`,
    link: { href: "/download", label: "Download for Mac" },
  },
  {
    title: "Connectors",
    icon: AppIcons.connections,
    body: "Plug in drives, docs and dashboards over the Model Context Protocol. A tool can't run until you approve that exact command.",
  },
  {
    title: "Bring your history",
    // The mark Settings > Data & privacy draws on its import drop zone.
    icon: FileUp,
    body: `Import a ChatGPT or Claude export. Titles and dates come across intact, and the archive never leaves ${PRODUCT_NAME}'s servers.`,
  },
  {
    title: "Export everything",
    icon: ActionIcons.download,
    body: `JSON, CSV or a full ${PRODUCT_NAME} package, any time. What you bring with you stays yours to take away.`,
  },
];

export function Features() {
  return (
    <section id="features" className="scroll-mt-20">
      <LandingColumn contentClassName="py-16 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-14">
          <Reveal className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <h2 className="max-w-md text-balance font-serif text-display font-medium tracking-tight">
                One workspace, properly equipped.
              </h2>
              <p className="mt-3 max-w-md text-pretty text-body-lg text-muted-foreground">
                The tools around the models matter as much as the models. All of these ship today.
              </p>
            </div>
          </Reveal>
          <RevealList as="dl" className="grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:col-span-7">
            {FEATURES.map(({ title, body, link, icon: Icon }, i) => (
              <RevealItem key={title} index={i} className="group/feature">
                <dt>
                  <span className="flex size-10 items-center justify-center rounded-field bg-secondary text-foreground/75 transition-colors duration-fast ease-out-soft group-hover/feature:bg-primary/10 group-hover/feature:text-primary">
                    <Icon aria-hidden className="size-[18px]" />
                  </span>
                  <span className="mt-4 block text-heading text-foreground">{title}</span>
                </dt>
                <dd className="mt-1.5 text-body text-muted-foreground">
                  {body}
                  {link && (
                    <a
                      href={link.href}
                      className="mt-2.5 flex w-fit items-center gap-1.5 rounded-xs text-body font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:decoration-primary/50 focus-visible:text-primary"
                    >
                      {link.label}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </a>
                  )}
                </dd>
              </RevealItem>
            ))}
          </RevealList>
        </div>
      </LandingColumn>
    </section>
  );
}

/**
 * Privacy as its own band: a commitment, not a ninth feature. Three facts on
 * one line of columns, under one plain heading.
 */
const PRIVACY: { icon: IconComponent; title: string; body: string }[] = [
  { icon: ShieldCheck, title: "Hosted in France", body: "EU infrastructure, GDPR by default." },
  { icon: Lock, title: "Encrypted at rest", body: "Messages are encrypted in the database." },
  { icon: EyeOff, title: "Never used for training", body: "Your conversations stay yours." },
];

export function Privacy() {
  return (
    <section className="scroll-mt-20">
      <LandingColumn contentClassName="pb-16 sm:pb-24">
        <Reveal>
          <div className="surface-raised-lg rounded-stage px-6 py-10 sm:px-12 sm:py-14">
            <h2 className="max-w-xl text-balance font-serif text-display font-medium tracking-tight">
              Private by design.
            </h2>
            <ul className="mt-10 grid gap-8 sm:grid-cols-3">
              {PRIVACY.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-3.5">
                  <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  <div>
                    <p className="text-heading text-foreground">{title}</p>
                    <p className="mt-1 text-body text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </LandingColumn>
    </section>
  );
}
