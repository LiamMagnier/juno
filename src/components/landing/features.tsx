import { ShieldCheck } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Card } from "@/components/ui/card";
import { Section } from "@/components/landing/section";

/**
 * What ships, as a two-column list on hairlines. Every line here ships
 * today; nothing aspirational.
 *
 * Not tiles and not numbered: the metering and lineup sections above already
 * vary the anatomy (one elevated receipt, one logo strip), and a third grid of
 * `surface-raised` cards with 01/02/03 in the corner was the stock brochure
 * pattern the page is trying not to be. Two former sections live here now as
 * rows — "Bring your history" (the import path) and "Code and continuity"
 * (the Mac app) — because both are features of the workspace, not arguments
 * that needed a heading each.
 */

interface Feature {
  title: string;
  body: string;
  link?: { href: string; label: string; file?: boolean };
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
    title: "Deep Research",
    body: "Approve the search plan, follow source coverage live, steer the run, and receive a citation-checked report.",
  },
  {
    title: "Code mode & native apps",
    body: "Juno Code on your Mac inspects diffs, runs tests and works in an isolated worktree. It shows what an action will touch and asks before it acts — and a project moves from browser to Mac to phone without turning local access into a black box.",
    link: { href: "/downloads/Juno.dmg", label: "Download for macOS", file: true },
  },
  {
    title: "Connectors",
    body: "Plug your own tools in — drives, docs, dashboards, anything that speaks the Model Context Protocol. A tool a project declares can't run until you approve that exact command.",
  },
  {
    title: "Bring your history",
    body: "Import a ChatGPT or Claude export from Settings → Data & privacy. Titles and dates come across intact, re-uploading never duplicates a conversation, and nothing goes to a third party — the archive is read on Juno's own server and discarded once stored.",
  },
  {
    title: "Export everything",
    body: "JSON, CSV or a full Juno package, any time. What you bring with you stays yours to take away.",
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
      <dl className="mt-10 grid gap-x-12 sm:grid-cols-2">
        {FEATURES.map(({ title, body, link }) => (
          <div key={title} className="border-t border-border/60 py-5">
            <dt className="text-heading">{title}</dt>
            <dd className="mt-1.5 text-body text-muted-foreground">
              {body}
              {link && (
                // `group` + a transform on the glyph only: the arrow leans out on
                // hover/focus, which is a second affordance for the pointer and the
                // ONLY one a keyboard gets. Transform and colour only, never
                // layout, and both are dropped under motion-reduce. A plain <a>
                // with `download`, not <Link>: the target is a 22 MB disk image,
                // and a Link prefetches on viewport entry in production.
                <a
                  href={link.href}
                  download={link.file || undefined}
                  className="group mt-2 inline-flex w-fit items-center gap-1 rounded-xs text-body font-medium text-foreground underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary focus-visible:text-primary"
                >
                  {link.label}
                  <ActionIcons.external
                    className="size-3.5 transition-transform duration-fast ease-out-soft group-hover:translate-x-px group-hover:-translate-y-px group-focus-visible:translate-x-px group-focus-visible:-translate-y-px motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 motion-reduce:group-hover:translate-y-0"
                    aria-hidden
                  />
                </a>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {/* Privacy gets its own row — it's a commitment, not a bullet point. The
          elevated Card (`surface-raised-lg`) is what sets it apart from the
          list above; the icon sits in the app's inset icon tile. */}
      <Card
        variant="elevated"
        className="mt-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6"
      >
        <span className="surface-inset flex size-10 shrink-0 items-center justify-center rounded-field text-muted-foreground">
          <ShieldCheck className="size-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-heading">Hosted in France, private by design</h3>
          <p className="mt-1 text-body text-muted-foreground">
            EU infrastructure, GDPR by default, messages encrypted at rest — and your conversations are never used to
            train models.
          </p>
        </div>
      </Card>
    </Section>
  );
}
