import { ChatView } from "@/components/chat/chat-view";

export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; q?: string }>;
}) {
  const { project, q } = await searchParams;
  return (
    <ChatView
      conversationId={null}
      initialMessages={[]}
      initialArtifacts={[]}
      initialModel=""
      projectId={project}
      initialPrompt={q}
    />
  );
}
