import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getConversationThread, getConversationThreadPage } from "@/lib/queries";
import { ChatView } from "@/components/chat/chat-view";
// Not imported directly: this route renders ONE of two surfaces and the chat
// one is the overwhelming case. See the loader for why the split lives there.
import { CodeSessionViewLazy as CodeSessionView } from "@/components/code/code-session-view-lazy";
import { agentForThread, pendingAgentStarter } from "@/lib/agents/store";
import { loadRoomDetail } from "@/lib/agents/room-store";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `m` is global search landing on the message it matched (see
  // src/lib/search/engine.ts); `artifact` is the library's canvas deep link.
  searchParams: Promise<{ artifact?: string; m?: string; researchRun?: string; q?: string; surface?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { artifact, m, researchRun, q, surface } = await searchParams;
  // The newest page of the conversation, not all of it: older turns load as the
  // reader scrolls back (lib/chat/history-page.ts). A ?m= deep link widens the
  // page to reach its message, so the jump needs no second request.
  const thread = await getConversationThreadPage(user.id, id, { focusMessageId: typeof m === "string" && m ? m : null });
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
  // Alevr Code v2: code sessions live at /code/[id] (the v2 workspace). The
  // old surface stays reachable with ?surface=legacy while v2 rolls out.
  if (thread.conversation.kind === "code" && codeSessionHasTarget && surface !== "legacy") {
    redirect(`/code/${id}`);
  }
  if (thread.conversation.kind === "code" && codeSessionHasTarget) {
    // The legacy Code surface renders its whole transcript; it does not page.
    const whole = await getConversationThread(user.id, id);
    if (!whole) notFound();
    return (
      <CodeSessionView
        conversation={whole.conversation}
        initialMessages={whole.messages}
        initialArtifacts={whole.artifacts}
      />
    );
  }

  // An agent's thread (docs/design/AGENTS.md §5.3) draws the agent above the
  // transcript. Null for every other chat, and for a retired agent's thread,
  // which reads as the ordinary chat it now is.
  const agent = await agentForThread(user.id, thread.conversation.id);
  // A room is an ordinary chat with member agents; its members, turns and the
  // turn waiting to run come with the page, so reloading resumes the plan
  // without a second responder (src/lib/agents/rooms.ts).
  const room = agent ? null : await loadRoomDetail(user.id, thread.conversation.id).catch(() => null);
  // Agents home opens a new agent's empty thread with the job as `?q=`; it is sent
  // as the thread's first message, once. Any other thread ignores it.
  const firstMessage =
    agent && thread.messages.length === 0 && typeof q === "string" && q.trim() ? q.trim().slice(0, 4000) : undefined;

  const chat = (
    <ChatView
      conversationId={thread.conversation.id}
      agent={agent ?? undefined}
      initialPrompt={firstMessage ?? (agent ? await pendingAgentStarter(user.id, agent.id) ?? undefined : undefined)}
      initialMessages={thread.messages}
      initialHistory={thread.history}
      initialArtifacts={thread.artifacts}
      initialModel={thread.conversation.model}
      initialResearchRun={researchRun}
      projectId={thread.conversation.projectId ?? undefined}
      initialConnectors={thread.conversation.activeConnectors}
      initialArtifactIdentifier={typeof artifact === "string" && artifact ? artifact : undefined}
      initialFocusMessageId={typeof m === "string" && m ? m : undefined}
      initialRoom={room}
    />
  );
  return chat;
}
