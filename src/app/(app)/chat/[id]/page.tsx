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
  //
  // Unless the session has no project. Those are the "not in a project"
  // conversations Juno Code offers before you have opened anything — there is
  // no Mac and no repository for the code composer to drive, so it would render
  // a permanently disabled field reading "This session isn't linked to a synced
  // project folder". They are answered by the chat pipeline instead (see the
  // matching condition in /api/chat), so they get the chat surface. The two
  // conditions read the same two columns and must stay inverses.
  const codeSessionHasTarget =
    !!thread.conversation.codeWorkspacePath || !!thread.conversation.codeWorkspaceKey;
  if (thread.conversation.kind === "code" && codeSessionHasTarget) {
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
