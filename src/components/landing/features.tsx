import { ArrowRight, AudioLines, FileUp, ShieldCheck, type IconComponent } from "@/components/ui/icons";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Card } from "@/components/ui/card";
import { Reveal, RevealItem, RevealList } from "@/components/landing/reveal";
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
 *
 * Each row hangs its glyph in the margin: the SAME drawing the product uses
 * for that feature behind the sign-in wall (the registries in
 * src/lib/app-icons.ts), at the row size, in muted ink. Title and body share
 * one left edge beside it, so the glyphs read as a column you can scan and the
 * text as a column you can read. The rows are not links, so a hover only
 * brings the glyph's ink up to the text's: an acknowledgement of where the
 * pointer is, never a fill or a lift that would promise a click.
 */

interface Feature {
  title: string;
  body: string;
  icon: IconComponent;
  link?: { href: string; label: string; file?: boolean };
}

const FEATURES: Feature[] = [
  {
    title: "Realtime voice",
    // The waveform the composer's voice-mode button draws, not the microphone:
    // in the product the mic is dictation, a different feature.
    icon: AudioLines,
    body: "Talk with any model — live, interruptible, transcribed both ways. Voice notes drop straight into chat.",
  },
  {
    title: "Artifacts & canvas",
    icon: AppIcons.artifacts,
    body: "Code, documents, diagrams and small apps render live beside the conversation, versioned as they evolve.",
  },
  {
    title: "Projects & memory",
    icon: AppIcons.projects,
    body: "Group related work, attach files, and let Juno carry context across conversations — when you want it to.",
  },
  {
    title: "Deep Research",
    icon: AppIcons.research,
    body: "Approve the search plan, follow source coverage live, steer the run, and receive a citation-checked report.",
  },
  {
    title: "Code mode & native apps",
    icon: AppIcons.code,
    body: "Juno Code on your Mac inspects diffs, runs tests and works in an isolated worktree. It shows what an action will touch and asks before it acts — and a project moves from browser to Mac to phone without turning local access into a black box.",
    link: { href: "/download", label: "Download for macOS", file: false },
  },
  {
    title: "Connectors",
    icon: AppIcons.connections,
    body: "Plug your own tools in — drives, docs, dashboards, anything that speaks the Model Context Protocol. A tool a project declares can't run until you approve that exact command.",
  },
  {
    title: "Bring your history",
    // The mark Settings → Data & privacy draws on its import drop zone
    // (import-history.tsx), which is where this row sends people.
    icon: FileUp,
    body: "Import a ChatGPT or Claude export from Settings → Data & privacy. Titles and dates come across intact, re-uploading never duplicates a conversation, and nothing goes to a third party — the archive is read on Juno's own server and discarded once stored.",
  },
  {
    title: "Export everything",
    icon: ActionIcons.download,
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
      {/* Dealt on the base rung as the list comes into view: eight rows, the
          contract's cap, so the last one lands ~0.3s after the first. */}
      <RevealList as="dl" className="mt-10 grid gap-x-12 sm:grid-cols-2">
        {FEATURES.map(({ title, body, link, icon: Icon }, i) => (
          <RevealItem key={title} index={i} className="group/feature border-t border-border/60 py-5">
            <dt className="flex items-center gap-2 text-heading">
              <Icon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/feature:text-foreground"
              />
              {title}
            </dt>
            {/* pl-6: the glyph (16) plus its gap (8), so the body hangs on the
                title's left edge rather than under the glyph. */}
            <dd className="mt-1.5 pl-6 text-body text-muted-foreground">
              {body}
              {link && (
                // The arrow nudges the way it points on hover and on keyboard
                // focus: that is the glyph's own articulation (`nudge-r`,
                // globals.css), played because it sits inside an <a>, and it is
                // the ONLY affordance a keyboard gets beyond the outline. It is
                // an arrow, not the external mark: /download is a page on Juno,
                // not a place outside it. Still a plain <a> rather than <Link>:
                // `file` decides whether the href is an asset to save or a page
                // to open, and both spellings live here.
                <a
                  href={link.href}
                  download={link.file || undefined}
                  className="mt-2 flex w-fit items-center gap-1.5 rounded-xs text-body font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:decoration-primary/50 focus-visible:text-primary focus-visible:decoration-primary/50"
                >
                  {link.label}
                  <ArrowRight className="size-3.5" aria-hidden />
                </a>
              )}
            </dd>
          </RevealItem>
        ))}
      </RevealList>

      {/* Privacy gets its own row — it's a commitment, not a bullet point. The
          elevated Card (`surface-raised-lg`) is what sets it apart from the
          list above; the icon sits in the app's inset icon tile. */}
      <Reveal className="mt-8">
        <Card variant="elevated" className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6">
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
      </Reveal>
    </Section>
  );
}
