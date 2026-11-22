import { CodeComposer } from "@/components/code/code-composer";
import type { CodePrefill } from "@/lib/code-prefill";

export function CodeLanding({ prefill, project }: { prefill: CodePrefill; project?: { id: string; name: string } }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto">
      <div className="page-gutter mx-auto my-auto flex w-full max-w-[46rem] flex-col gap-6 pb-10 pt-8 sm:gap-8">
        <h1 className="chat-home__title text-balance text-center font-serif font-normal text-foreground">What will you build?</h1>
        <div className="relative isolate w-full">
          <CodeComposer key={project?.id ?? "unscoped"} prefill={prefill} project={project} />
        </div>
      </div>
    </div>
  );
}
