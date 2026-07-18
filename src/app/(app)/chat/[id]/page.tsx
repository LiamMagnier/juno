import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getConversationThread } from "@/lib/queries";
import { ChatView } from "@/components/chat/chat-view";
import { CodeSessionView } from "@/components/code/code-session-view";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ artifact?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { artifact } = await searchParams;
  const thread = await getConversationThread(user.id, id);
  if (!thread) notFound();

  // Juno Code sessions get the code surface: same message rendering, but the
  // composer drives remote tasks on the user's Mac instead of /api/chat.
  if (thread.conversation.kind === "code") {
    return <CodeSessionView conversation={thread.conversation} initialMessages={thread.messages} />;
  }

  return (
    <ChatView
      conversationId={thread.conversation.id}
      initialMessages={thread.messages}
      initialArtifacts={thread.artifacts}
      initialModel={thread.conversation.model}
      projectId={thread.conversation.projectId ?? undefined}
      initialConnectors={thread.conversation.activeConnectors}
      initialArtifactIdentifier={typeof artifact === "string" && artifact ? artifact : undefined}
    />
  );
}
