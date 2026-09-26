"use client";

import * as React from "react";
import { Braces, Compass, Map as MapGlyph, PenTool, type IconComponent } from "@/components/ui/icons";

import { CHAT_COMPOSER_FIELD_ID } from "@/components/chat/composer";
import { Collapse } from "@/components/ui/collapse";
import { StartingTileBody, startingGridClass, startingTileClass } from "@/components/ui/starting-tile";
import { menuRowClass } from "@/components/ui/menu-recipe";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The first move on an empty chat.
 *
 * A new account's first screen was one line of serif and an empty box: nothing
 * to press, and nothing saying what this product is for. Claude puts starter
 * chips here and ChatGPT a pill row, for the same reason: the empty composer
 * is the one moment a user has no idea what to type.
 *
 * A CHIP OPENS EXAMPLES; IT DOES NOT WRITE. Each chip used to drop a sentence
 * opener in the field ("Research and cite sources on "), which helped someone
 * who already knew what to ask and did nothing for someone who did not. Now a
 * chip unfolds three whole example prompts under the row, the way Claude's do,
 * so the row shows what Juno can do instead of how a sentence starts. One
 * chip is open at a time; pressing it again, or Esc, folds the list away.
 *
 * AN EXAMPLE SEEDS, IT NEVER SENDS. Picking one fires the composer's existing
 * `juno:composer-seed` event (composer.tsx), which puts the text in the field
 * with the caret at the end. A suggestion that sends itself spends the user's
 * tokens on a sentence they did not write, and most examples are a starting
 * point to edit rather than the exact question.
 *
 * THE ROW STEPS ASIDE ONCE THERE IS A DRAFT. Chips under a half-written
 * message are suggestions for a message the reader is no longer writing, so
 * the row fades out (and leaves the tab order) while the field holds text,
 * and comes back if it is cleared. It keeps its space while hidden, so the
 * composer above never moves.
 *
 * The four name things Juno is actually good at: research it will cite, code
 * it can go on to run, a draft, and a plan it can carry out as a task. Whether
 * a prompt becomes a chat or a task is the model's call, not the chip's.
 */
/*
 * Each glyph's hover gesture is its own, declared once in icons.tsx
 * (ICONS_AND_MOTION.md §1.3), so a chip plays whatever that drawing plays
 * everywhere else; nothing is assigned here.
 *
 * `STARTER_CHIP_COPY`, not `CHIPS`: the i18n extractor collects every string
 * under a variable whose name ends in "Copy", which is how the example prompts
 * reach the catalog (see scripts/generate-i18n-catalog.mjs).
 */
const STARTER_CHIP_COPY: ReadonlyArray<{
  label: string;
  hint: string;
  icon: IconComponent;
  examples: readonly string[];
}> = [
  {
    label: "Research",
    hint: "With cited sources",
    icon: Compass,
    examples: [
      "What does the latest research say about intermittent fasting? Cite the strongest studies.",
      "Compare the three most popular note-taking apps for a small team, with sources.",
      "Summarise what changed in EU AI regulation this year and link the primary texts.",
    ],
  },
  {
    label: "Write",
    hint: "Emails and drafts",
    icon: PenTool,
    examples: [
      "Draft a short, friendly follow-up email after a job interview.",
      "Write a toast for my sister’s wedding that is warm and under two minutes long.",
      "Turn my rough notes into a clear one-page project update.",
    ],
  },
  {
    label: "Code",
    hint: "Scripts and fixes",
    icon: Braces,
    examples: [
      "Write a Python script that renames photos by the date they were taken.",
      "Build a React table component that sorts by any column.",
      "Explain how this regular expression works, one part at a time.",
    ],
  },
  {
    label: "Plan",
    hint: "Trips and projects",
    icon: MapGlyph,
    examples: [
      "Plan a three-day trip to Lisbon with a mix of food, museums and walks.",
      "Turn my goals for this quarter into a week-by-week plan.",
      "Make a launch checklist for a small product release.",
    ],
  },
];

/**
 * The composer's draft, as far as this row needs to know it: empty or not.
 *
 * Two sources, because the composer changes its text two ways. Typing fires a
 * native `input` event on the field, which bubbles to the document and is
 * read here directly. A programmatic write (a seed, dictation, the clear after
 * a send) fires nothing native, so the composer announces its draft with a
 * `juno:composer-draft` event (`{ empty: boolean }`); this listens for both.
 * A seed from this row sets the state itself, since the row knows it just
 * put text in the field.
 */
function useComposerDraftEmpty(): [boolean, (empty: boolean) => void] {
  const [empty, setEmpty] = React.useState(true);
  React.useEffect(() => {
    const onDraft = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as { empty?: unknown } | null) : null;
      if (typeof detail?.empty === "boolean") setEmpty(detail.empty);
    };
    const onInput = (event: Event) => {
      const field = event.target;
      if (field instanceof HTMLTextAreaElement && field.id === CHAT_COMPOSER_FIELD_ID) {
        setEmpty(field.value.trim().length === 0);
      }
    };
    window.addEventListener("juno:composer-draft", onDraft);
    document.addEventListener("input", onInput, true);
    // The composer keeps a half-typed draft across a move to a new chat, and
    // no event fires for a draft that was already there, so read it once.
    const field = document.getElementById(CHAT_COMPOSER_FIELD_ID);
    if (field instanceof HTMLTextAreaElement) setEmpty(field.value.trim().length === 0);
    return () => {
      window.removeEventListener("juno:composer-draft", onDraft);
      document.removeEventListener("input", onInput, true);
    };
  }, []);
  return [empty, setEmpty];
}

export function StarterChips({ className }: { className?: string }) {
  const [openLabel, setOpenLabel] = React.useState<string | null>(null);
  const [draftEmpty, setDraftEmpty] = useComposerDraftEmpty();
  const chipRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const id = React.useId();
  const panelId = `${id}-examples`;
  const open = STARTER_CHIP_COPY.find((chip) => chip.label === openLabel) ?? null;
  // The list keeps its last words while it folds away: Collapse holds its
  // children through the exit, and an emptied list would fold as a blank.
  const lastOpen = React.useRef(open);
  React.useEffect(() => {
    if (open) lastOpen.current = open;
  }, [open]);
  const shown = open ?? lastOpen.current;
  const visible = draftEmpty;

  // A draft closes the list along with the row, so it is not still open when
  // the row comes back.
  React.useEffect(() => {
    if (!visible) setOpenLabel(null);
  }, [visible]);

  const closeAndRefocus = () => {
    const label = openLabel;
    setOpenLabel(null);
    if (label) chipRefs.current.get(label)?.focus();
  };

  const seed = (event: React.MouseEvent<HTMLButtonElement>, prompt: string) => {
    // The row's rendered text, not the source string, so a reader using Juno
    // in another language gets the example in the language it was shown in
    // (the auto-translator rewrites the text node, not this array).
    const shown = event.currentTarget.textContent?.trim() || prompt;
    window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: shown }));
    setOpenLabel(null);
    setDraftEmpty(false);
  };

  return (
    <div
      aria-hidden={!visible}
      inert={!visible}
      onKeyDown={(event) => {
        if (event.key === "Escape" && openLabel) {
          event.stopPropagation();
          closeAndRefocus();
        }
      }}
      className={cn(
        // Positioned so the examples can hang below the row without taking
        // part in the landing's vertical centring: an in-flow list would push
        // the greeting and the composer up by half its height every time it
        // opened, moving the field the reader is about to type in.
        "relative mt-4 transition-opacity duration-fast ease-out-soft motion-reduce:transition-none",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        className
      )}
    >
      {/*
       * STARTING POINTS, NOT PILLS (premium pass). Four equal tiles under the
       * composer: a mark in its own small well, the verb, and one line on
       * what it is for. The pill row said "Research / Write / Code / Plan"
       * and left the reader to guess what pressing one would do; a tile has
       * room to say it, which is the difference between a label and a
       * starting point. Each still unfolds three examples below the row and
       * seeds, never sends.
       *
       * Quiet at rest (ground-toned card, hairline), one rung up under the
       * pointer (lift 1px, deeper edge), selected while open. Two columns on
       * a phone, where the hint line drops and the tile becomes a row.
       */}
      <div className={cn(startingGridClass, "max-w-[calc(48rem-2*var(--page-gutter,0px))]")}>
        {STARTER_CHIP_COPY.map((chip, i) => {
          const expanded = openLabel === chip.label;
          return (
            <button
              key={chip.label}
              ref={(node) => {
                if (node) chipRefs.current.set(chip.label, node);
                else chipRefs.current.delete(chip.label);
              }}
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              onClick={() => setOpenLabel(expanded ? null : chip.label)}
              // No `transition-colors` beside `.pressable`: that class already
              // declares the whole transition shorthand (colour, transform,
              // press), and a later transition-* utility would override it.
              className={startingTileClass}
              style={staggerDelay(i, "tight", 120)}
            >
              <StartingTileBody icon={chip.icon} label={chip.label} hint={chip.hint} />
            </button>
          );
        })}
      </div>

      <Collapse open={!!open} className="absolute inset-x-0 top-full" innerClassName="pt-3">
        {shown && (
          <ul
            // Keyed on the chip, so moving from one chip to another fades the
            // new list in rather than swapping its words in place.
            key={shown.label}
            id={panelId}
            aria-label={shown.label}
            className="mx-auto max-w-xl divide-y divide-border/60 duration-fast motion-safe:animate-fade-in"
          >
            {shown.examples.map((prompt) => (
              <li key={prompt} className="py-0.5">
                <button
                  type="button"
                  onClick={(event) => seed(event, prompt)}
                  // Muted at rest and foreground under the pointer, the way a
                  // menu row lights: three prompts in full ink read as a
                  // paragraph competing with the greeting above them.
                  className={cn(
                    menuRowClass,
                    "w-full text-left text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground active:bg-selected"
                  )}
                >
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Collapse>
    </div>
  );
}
