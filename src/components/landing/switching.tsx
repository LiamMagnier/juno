import { Section } from "@/components/landing/section";

/**
 * The import path, said out loud.
 *
 * `POST /api/import` has read ChatGPT and Claude export archives since before
 * this section existed — idempotently, preserving titles and timestamps, with
 * message bodies going through the same encryption-at-rest path as live chats
 * — and nothing on the marketing surface mentioned it. Of the seventeen
 * products surveyed for the 2026-07-31 market study, not one offers an import
 * path from a rival: everybody exports, nobody imports. Portability is
 * one-directional across the whole category.
 *
 * Which makes this the cheapest switching-cost reversal available to anyone
 * here, and it was already built.
 */

const STEPS: { term: string; body: string }[] = [
  {
    term: "Export from where you are",
    body: "ChatGPT and Claude both hand you a ZIP of your history. Ask for it in their settings; it arrives by email.",
  },
  {
    term: "Drop it into Juno",
    body: "Settings → Import history. Titles and dates come across intact, and re-uploading the same archive never duplicates a conversation.",
  },
  {
    term: "Keep reading it here",
    body: "Imported chats are searchable, foldable and shareable like anything else — and encrypted at rest the same way.",
  },
];

export function Switching() {
  return (
    <Section
      id="switching"
      eyebrow="Bring your history"
      heading="Move in without leaving anything behind."
      lede="Your old conversations are yours. Import a ChatGPT or Claude export and pick up where you left off — no retyping, no second tab open for the archive."
    >
      <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-3">
        {STEPS.map((step) => (
          <div key={step.term} className="border-t border-border/60 pt-5">
            <dt className="font-serif text-heading font-medium">{step.term}</dt>
            <dd className="mt-2 text-sm text-muted-foreground">{step.body}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-sm text-muted-foreground">
        Exports up to 100 MB. Nothing is sent to a third party — the archive is read on Juno&apos;s own server and
        discarded once its conversations are stored.
      </p>
    </Section>
  );
}
