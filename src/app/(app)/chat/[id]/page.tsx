import nextDynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getConversationThread } from "@/lib/queries";
import { AgentWorkspaceFrame } from "@/components/agents/agent-workspace-frame";
import { ChatView } from "@/components/chat/chat-view";
import { agentForThread, pendingAgentStarter } from "@/lib/agents/store";

/**
 * Split, not imported. This route renders ONE of two surfaces and the chat one
 * is the overwhelming case, but a static import put the whole Code session
 * view — and, through it, the canvas panel and the design editor's node
 * machinery — into the first load of every conversation page. Measured: 234 kB
 * of the route's 797 kB, downloaded and parsed by everyone who ever opens a
 * chat, to render nothing.
 *
 * No `ssr: false`: a Server Component cannot ask for that, and it should not —
 * a code session still renders its history on the server. `next/dynamic` here
 * only moves the module into its own chunk, fetched when the branch below
 * actually takes it.
 */
const CodeSessionView = nextDynamic(() =>
  import("@/components/code/code-session-view").then((m) => m.CodeSessionView),
);

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `m` is global search landing on the message it matched (see
  // src/lib/search/engine.ts); `artifact` is the library's canvas deep link.
  searchParams: Promise<{ artifact?: string; m?: string; researchRun?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { artifact, m, researchRun } = await searchParams;
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
    // `thread.artifacts` is loaded for every conversation this route renders,
    // code or not — handing it to both surfaces is what stops the code one
    // needing a fetch of its own for rows the page already has.
    return (
      <CodeSessionView
        conversation={thread.conversation}
        initialMessages={thread.messages}
        initialArtifacts={thread.artifacts}
      />
    );
  }

  // An agent's thread (docs/design/AGENTS.md §5.3) draws the agent above the
  // transcript. Null for every other chat, and for a retired agent's thread,
  // which reads as the ordinary chat it now is.
  const agent = await agentForThread(user.id, thread.conversation.id);

  const chat = (
    <ChatView
      conversationId={thread.conversation.id}
      agent={agent ?? undefined}
      initialPrompt={agent ? await pendingAgentStarter(user.id, agent.id) ?? undefined : undefined}
      initialMessages={thread.messages}
      initialArtifacts={thread.artifacts}
      initialModel={thread.conversation.model}
      initialResearchRun={researchRun}
      projectId={thread.conversation.projectId ?? undefined}
      initialConnectors={thread.conversation.activeConnectors}
      initialArtifactIdentifier={typeof artifact === "string" && artifact ? artifact : undefined}
      initialFocusMessageId={typeof m === "string" && m ? m : undefined}
    />
  );
  return agent ? <AgentWorkspaceFrame currentAgentId={agent.id}>{chat}</AgentWorkspaceFrame> : chat;
}
