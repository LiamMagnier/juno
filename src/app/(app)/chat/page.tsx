import { ChatView } from "@/components/chat/chat-view";

export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; q?: string; research?: string }>;
}) {
  const { project, q, research } = await searchParams;
  return (
    <ChatView
      conversationId={null}
      initialMessages={[]}
      initialArtifacts={[]}
      initialModel=""
      projectId={project}
      initialPrompt={q}
      initialPromptResearch={research === "1"}
    />
  );
}
