import { CodeComposer } from "@/components/code/code-composer";
import type { CodePrefill } from "@/lib/code-prefill";

export function CodeLanding({ prefill, project }: { prefill: CodePrefill; project?: { id: string; name: string } }) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-clip">
      <div className="chat-home page-gutter relative isolate">
        <div className="chat-home__greet text-center">
          <h1 className="chat-home__title text-balance font-serif font-normal text-foreground">What will you build?</h1>
        </div>
        <div className="chat-home__composer relative min-w-0">
          <CodeComposer key={project?.id ?? "unscoped"} prefill={prefill} project={project} />
        </div>
      </div>
    </div>
  );
}
