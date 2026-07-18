import { ChatView } from "@/components/chat/chat-view";
import type { ReasoningEffort } from "@/types/chat";

const REASONING_VALUES = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function parseReasoning(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  return REASONING_VALUES.has(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined;
}

export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{
    project?: string;
    q?: string;
    research?: string;
    model?: string;
    reasoning?: string;
  }>;
}) {
  const { project, q, research, model, reasoning } = await searchParams;
  return (
    <ChatView
      conversationId={null}
      initialMessages={[]}
      initialArtifacts={[]}
      // Prefer the model chosen on the project (or any deep-link) page; empty
      // falls through to the account default inside ChatView.
      initialModel={model ?? ""}
      projectId={project}
      initialPrompt={q}
      initialPromptResearch={research === "1"}
      initialReasoningEffort={parseReasoning(reasoning)}
    />
  );
}
