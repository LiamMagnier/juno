import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getConversationThread } from "@/lib/queries";
import { ChatView } from "@/components/chat/chat-view";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const thread = await getConversationThread(user.id, id);
  if (!thread) notFound();

  return (
    <ChatView
      conversationId={thread.conversation.id}
      initialMessages={thread.messages}
      initialArtifacts={thread.artifacts}
      initialModel={thread.conversation.model}
      projectId={thread.conversation.projectId ?? undefined}
    />
  );
}
