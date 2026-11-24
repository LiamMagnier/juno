"use client";

import * as React from "react";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import { useWorkSessionFollower, type ConversationWork } from "@/components/chat/use-conversation-work";
import type { ClientWorkSession } from "@/lib/work/serializers";
import type { AgentAvatar } from "@/lib/agents/avatar";

/**
 * One task's card in a conversation that can carry several.
 *
 * Each card follows its own task (one stream, one cursor) and draws it with
 * the unchanged `WorkRunPanel`. It reports what it follows up to the chat view,
 * which needs it beside the composer: the composer answers or steers ONE task
 * (`composerTaskId`), and the face in a crew member's thread reads all of them.
 * The report is the follower's memoised object, so it changes only when the
 * task does.
 */
export function ConversationTaskPanel({
  session,
  actor,
  actorAvatar,
  className,
  onReport,
}: {
  session: ClientWorkSession;
  actor?: string;
  actorAvatar?: AgentAvatar;
  className?: string;
  onReport: (sessionId: string, work: ConversationWork | null) => void;
}) {
  const work = useWorkSessionFollower(session);
  const id = session.id;

  React.useEffect(() => {
    onReport(id, work);
  }, [id, work, onReport]);
  React.useEffect(() => () => onReport(id, null), [id, onReport]);

  if (!work.session) return null;
  return <WorkRunPanel work={work} className={className} actor={actor} actorAvatar={actorAvatar} />;
}
