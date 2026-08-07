import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
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
    title: "Learning blocks",
    body: "Answers that teach: step labs, quizzes, timelines and comparisons rendered inline, right in the reply.",
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
          <li key={title} className="border-t border-dotted border-border pb-8 pt-5">
            <span className="font-mono text-caption text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 font-serif text-heading font-medium">{title}</h3>
            <p className="mt-1.5 text-body text-muted-foreground">{body}</p>
            {link && (
              <a
                href={link.href}
                className="mt-2.5 inline-flex items-center gap-1 text-body underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary"
              >
                {link.label}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ol>

      {/* Privacy gets its own row — it's a commitment, not a bullet point.
          Card, not a hand-rolled panel: rounded-lg is the same 24px this used to
          hardcode, so nothing moves, but it picks up .surface-raised — the sheen
          and inner hairline every card in the app is lit by. Without it the
          landing's panels read visibly flatter than anything past the sign-in. */}
      <Card className="mt-2 flex flex-col gap-4 bg-secondary/50 px-6 py-6 sm:flex-row sm:items-center sm:gap-5">
        <ShieldCheck className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
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
