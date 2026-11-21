import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { PageRoot } from "@/components/app/page-root";
import { CodeComposer } from "@/components/code/code-composer";
import { CodeLandingActions } from "@/components/code/code-landing-actions";
import type { CodePrefill } from "@/lib/code-prefill";
import { BRAND } from "@/lib/brand/names";

export function CodeLanding({ prefill }: { prefill: CodePrefill }) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-clip">
      <div className="page-gutter mx-auto flex w-full max-w-[48rem] flex-1 flex-col justify-center py-8 md:py-10">
        <p className="mb-3 flex items-center justify-center gap-1.5 text-muted-foreground">
          <AlevrLockup height={16} tone="muted" decorative />
          <span className="font-serif text-body leading-none">{BRAND.code.label}</span>
          <span className="sr-only">{BRAND.code.title}</span>
        </p>
        <h1 className="chat-home__title mb-6 text-balance text-center font-serif font-normal text-foreground sm:mb-8">
          What will you build?
        </h1>
        <div className="relative isolate w-full">
          <CodeComposer prefill={prefill} />
        </div>
        <PageRoot><CodeLandingActions /></PageRoot>
      </div>
    </div>
  );
}
