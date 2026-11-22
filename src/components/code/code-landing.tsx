import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { PageRoot } from "@/components/app/page-root";
import { CodeComposer } from "@/components/code/code-composer";
import { CodeRecentSessions } from "@/components/code/code-landing-actions";
import type { CodePrefill } from "@/lib/code-prefill";
import { BRAND } from "@/lib/brand/names";

export function CodeLanding({ prefill }: { prefill: CodePrefill }) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-clip">
      <div className="page-gutter mx-auto flex w-full max-w-[52rem] flex-1 flex-col pb-10 pt-9 sm:pb-14 sm:pt-16 lg:pt-20">
        <header className="mb-9 sm:mb-11">
          <p className="mb-4 flex items-center gap-1.5 text-muted-foreground">
            <AlevrLockup height={17} tone="muted" decorative />
            <span className="font-serif text-body leading-none">{BRAND.code.label}</span>
            <span className="sr-only">{BRAND.code.title}</span>
          </p>
          <h1 className="chat-home__title text-balance font-serif font-normal text-foreground">What will you build?</h1>
          <p className="mt-3 text-pretty text-ui text-muted-foreground">Choose a workspace and describe what you want to change.</p>
        </header>
        <div className="relative isolate w-full">
          <CodeComposer prefill={prefill} />
        </div>
        <PageRoot><CodeRecentSessions /></PageRoot>
      </div>
    </div>
  );
}
