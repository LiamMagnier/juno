import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getConversationThread } from "@/lib/queries";
import { CodeV2Client } from "./client";

export const dynamic = "force-dynamic";

/**
 * `/code/[id]`: an Alevr Code session in the v2 workspace (docs/code-v2/
 * DESIGN.md). The conversation's history is loaded here, on the server, so the
 * thread paints with its turns; everything live (the env server on the user's
 * Mac, or the CodeTask path) attaches on the client.
 *
 * Only code sessions with a project render here. A chat, or a code session
 * that never had a project (answered by the chat pipeline), goes to /chat/[id].
 */
export default async function CodeSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const thread = await getConversationThread(user.id, id);
  if (!thread) notFound();
  const c = thread.conversation;
  if (c.kind !== "code" || !(c.codeWorkspacePath || c.codeWorkspaceKey)) redirect(`/chat/${id}`);
  return (
    <CodeV2Client
      conversation={{
        id: c.id,
        title: c.title,
        codeWorkspaceName: c.codeWorkspaceName ?? null,
        codeWorkspacePath: c.codeWorkspacePath ?? null,
        codeWorkspaceKey: c.codeWorkspaceKey ?? null,
      }}
      initialMessages={thread.messages}
    />
  );
}
