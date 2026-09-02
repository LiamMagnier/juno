import { ShieldCheck } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Card } from "@/components/ui/card";
import { staggerDelay } from "@/lib/motion";
import { Section } from "@/components/landing/section";

/**
 * Feature strip — numbered raised tiles, one line each. Every line here
 * ships today; nothing aspirational.
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
      {/* Raised tiles on the `base` stagger — the same grid recipe the app's
          project and artifact tiles use, so the feature list reads as the
          product rather than as a brochure. */}
      <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ title, body, link }, i) => (
          <li
            key={title}
            style={staggerDelay(i)}
            className="surface-raised flex flex-col rounded-card p-5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            <span className="font-mono text-caption tabular-nums text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-3 text-heading">{title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
            {link && (
              // `group` + a transform on the glyph only: the arrow leans out on
              // hover/focus, which is a second affordance for the pointer and the
              // ONLY one a keyboard gets. Transform and colour only, never
              // layout, and both are dropped under motion-reduce.
              <a
                href={link.href}
                className="group mt-auto inline-flex w-fit items-center gap-1 rounded-xs pt-4 text-sm font-medium underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
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

      {/* Privacy gets its own row — it's a commitment, not a bullet point. The
          elevated Card (`surface-raised-lg`) is what sets it apart from the
          tiles above; the icon sits in the app's inset icon tile. */}
      <Card
        variant="elevated"
        className="mt-4 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6"
      >
        <span className="surface-inset flex size-10 shrink-0 items-center justify-center rounded-field text-muted-foreground">
          <ShieldCheck className="size-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-heading">Hosted in France, private by design</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            EU infrastructure, GDPR by default, messages encrypted at rest — and your conversations are never used to
            train models.
          </p>
        </div>
      </Card>
    </Section>
  );
}
