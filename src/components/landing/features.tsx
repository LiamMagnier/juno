import { ShieldCheck } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Card } from "@/components/ui/card";
import { staggerDelay } from "@/lib/motion";
import { Section } from "@/components/landing/section";

/**
 * Feature strip — editorial numbered entries, not icon-card confetti. Every
 * line here ships today; nothing aspirational.
 */

interface Feature {
  title: string;
  body: string;
  link?: { href: string; label: string };
}

const FEATURES: Feature[] = [
  {
    title: "Realtime voice",
    body: "Talk with any model — live, interruptible, transcribed both ways. Voice notes drop straight into chat.",
  },
  {
    title: "Artifacts & canvas",
    body: "Code, documents, diagrams and small apps render live beside the conversation, versioned as they evolve.",
  },
  {
    title: "Projects & memory",
    body: "Group related work, attach files, and let Juno carry context across conversations — when you want it to.",
  },
  {
    title: "Code mode & native apps",
    body: "Native macOS and iOS apps with a full coding agent: diffs, terminal, tests, and on the Mac, real computer use.",
    link: { href: "/downloads/Juno.dmg", label: "Download for macOS" },
  },
  {
    title: "Connectors (MCP)",
    body: "Plug your own tools in over the Model Context Protocol — drives, docs, dashboards, whatever speaks it.",
  },
  {
    title: "Deep Research",
    body: "Approve the search plan, follow source coverage live, steer the run, and receive a citation-checked report.",
  },
];

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="What's inside"
      heading="One workspace, properly equipped."
      lede="The tools around the models matter as much as the models. These all ship today."
    >
      {/* Dotted rules, not solid ones: DottedDivider is the product's rule motif
          (roadmap, submit dialog) and the landing already uses it for the
          flagship divider and the receipt's leader. */}
      <ol className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ title, body, link }, i) => (
          <li
            key={title}
            style={staggerDelay(i)}
            className="border-t border-dotted border-border pb-8 pt-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            <span className="font-mono text-caption text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 font-serif text-heading font-medium">{title}</h3>
            <p className="mt-1.5 text-body text-muted-foreground">{body}</p>
            {link && (
              // `group` + a transform on the glyph only: the arrow leans out on
              // hover/focus, which is a second affordance for the pointer and the
              // ONLY one a keyboard gets — hover was carrying this alone. transform
              // and colour only, never layout, and both are dropped under
              // motion-reduce.
              <a
                href={link.href}
                className="group mt-2.5 inline-flex items-center gap-1 rounded-xs text-body underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
              >
                {link.label}
                <ActionIcons.external
                  className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:translate-x-px group-hover:-translate-y-px group-focus-visible:translate-x-px group-focus-visible:-translate-y-px motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 motion-reduce:group-hover:translate-y-0"
                  aria-hidden
                />
              </a>
            )}
          </li>
        ))}
      </ol>

      {/* Privacy gets its own row — it's a commitment, not a bullet point.
          Card, not a hand-rolled panel, so this is literally the same primitive
          the signed-in product is built from: `rounded-card` (14px), the damped
          hairline and the scoped transition, decided once in card.tsx. (This
          comment used to claim 24px and a `.surface-raised` pickup; Card sets
          neither — the radius is 14 and the sheen it names lives on the dark
          override below.)
          No bg override: this carried bg-secondary/50 while the page's only other
          Card (the receipt in metering.tsx) sat on plain bg-card, so the two read
          as different materials — and the dark lit edge below is drawn against
          bg-card, so the override was muting the very highlight it depends on.
          Setting the row apart is variant="elevated"'s job, not a second ground. */}
      {/* The dark override is not decoration. `elevated` resolves to
          --shadow-lift, which on the dark theme is pure black ink — invisible on
          a black ground, so the one row meant to stand apart read as flat as the
          dotted list above it. Depth on black comes from the lightness ladder, a
          hairline, and a 1px INSET top highlight (never an outer light, which is
          the halo the theme just removed); this is the same treatment
          `.dark .composer-surface` uses in globals.css. */}
      <Card
        variant="elevated"
        className="mt-2 flex flex-col gap-4 px-6 py-6 dark:border-border dark:shadow-[inset_0_1px_0_hsl(var(--sheen)),0_1px_2px_hsl(0_0%_0%/0.5),0_18px_44px_-30px_hsl(0_0%_0%/0.9)] sm:flex-row sm:items-center sm:gap-5"
      >
        <ShieldCheck className="size-6 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h3 className="font-serif text-heading font-medium">Hosted in France, private by design</h3>
          <p className="mt-1 text-body text-muted-foreground">
            EU infrastructure, GDPR by default, messages encrypted at rest — and your conversations are never used to
            train models.
          </p>
        </div>
      </Card>
    </Section>
  );
}
