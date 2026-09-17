import { requireUser } from "@/lib/session";
import { CodeComposer } from "@/components/code/code-composer";

export const dynamic = "force-dynamic";

/**
 * `/code` — THE LANDING. A greeting and a composer, and nothing else.
 *
 * WHAT THIS REPLACED, AND WHY THE OLD ARGUMENT NO LONGER HOLDS. This route was
 * a list page, and its docblock defended that choice in these terms: landing on
 * the composer says the product is "start a thing" while landing on the list
 * says it is "watch the things you started", and for a surface whose premise is
 * that several agents are working somewhere you cannot see, the second is the
 * true one — because the first "actively hides the run that stopped to ask you a
 * question ten minutes ago behind a text field".
 *
 * That was a real objection and it is answered, not ignored. The run that
 * stopped to ask is now the first row of the sidebar's Needs-you fold, which is
 * on screen on every page of the product rather than only on this one
 * (docs/design/TWO_PRODUCTS.md §3). A list page could only answer the question
 * while you were standing on it; the fold answers it while you are reading a
 * chat, a pull request or another run. So the surveillance the list existed for
 * moved somewhere strictly better, and what was left here was five pieces of
 * chrome — a "Runs" header, the Runs | Pull requests tabs, a search field, an
 * All | Cloud | My Macs filter and a "Wrapped up" fold — stacked above the
 * first row a person actually wanted.
 *
 * THE GREETING IS THE ONE THIS SURFACE ALREADY HAD, and it is worth saying why
 * it is allowed back. `/code/new` opened with "What are we building today,
 * Liam?" at display size and that was removed as a marketing hero — correctly,
 * because it sat under a sticky tab strip and above a page header, so the
 * screen said its own name three times before the field. What made it a hero
 * was the stack around it, not the sentence. With the header, the tabs and the
 * list gone, a serif line and a composer are the entire page, which is what
 * docs/design/TWO_PRODUCTS.md §3 asks for and what `/chat` has always been.
 *
 * WHY IT IS NOT INSIDE `AppPage` + `AppPageHeader`. Every other app route is,
 * and this one is the exception on purpose: a composer pinned to the bottom of
 * the column needs the full height of the shell, which a scrolling content
 * frame does not give it, and a header above a greeting would be the page
 * saying its own name twice (docs/design/PREMIUM_AUDIT.md §3 rule 15). `/chat`
 * is the same shape for the same reason.
 *
 * The greeting is server-rendered from the signed-in account, so it is the
 * first thing painted rather than something that pops in once a client island
 * hydrates. Everything below it is `CodeComposer`, which is a client island
 * because it holds a draft, uploads, two pickers and both submit paths.
 */
export default async function CodePage() {
  const user = await requireUser();
  const firstName = user.name?.trim().split(/\s+/)[0];

  return (
    // `overflow-x-clip` for the same reason the chat greeting has it: nothing
    // in this column may put a horizontal scrollbar over dead space, and the
    // composer's focus ring is wider than the box it belongs to.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-clip">
      <div className="page-gutter mx-auto flex w-full max-w-[44rem] flex-1 flex-col pb-4 pt-6">
        {/*
          The greeting sits in the upper third: the block holding it takes one
          part of the free space and the spacer under it takes two, so the line
          lands a third of the way down at any height without naming a viewport
          unit — `vh` measures the window, and a page inside this shell does not
          have the window (PREMIUM_AUDIT.md §3 rule 11). Both take a `0` basis
          and shrink, so a short window spends its height on the field and the
          greeting rather than on the air between them.
        */}
        <div className="flex min-h-0 flex-[1_1_0] flex-col justify-end">
          <h1 className="text-balance text-center font-serif text-display font-normal text-foreground motion-safe:animate-rise-in">
            What are we building
            {firstName ? (
              <>
                , <span className="italic">{firstName}</span>
              </>
            ) : null}
            ?
          </h1>
        </div>
        <div aria-hidden className="min-h-0 flex-[2_2_0]" />
        <CodeComposer />
      </div>
    </div>
  );
}
