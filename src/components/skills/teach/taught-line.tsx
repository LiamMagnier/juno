"use client";

import * as React from "react";
import Link from "next/link";
import { GraduationCap } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { taughtOrigin } from "@/lib/skills/teach";

/*
 * On a skill's page: where a taught skill came from, and the way back into
 * the Teach editor, which saves its next version: "Review and turn on" while
 * it is off (the Teach review is where switching on is confirmed), "Teach it
 * again" once it is on.
 *
 *   🎓 Taught in a chat · 3 days ago · Open the chat          [Teach it again]
 *
 * Reads only the version's provenance (`taught.*`), which grants nothing; a
 * skill without it draws nothing here.
 */
export function TaughtLine({
  skillId,
  provenance,
  enabled,
  canReteach,
}: {
  skillId: string;
  provenance: Record<string, string> | null | undefined;
  enabled: boolean;
  /** A skill you own (not installed from a repository). */
  canReteach: boolean;
}) {
  const origin = taughtOrigin(provenance);
  if (!origin) return null;
  const when = origin.at ? workTimeAgo(origin.at) : null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-field bg-muted/60 px-3.5 py-2.5 text-caption text-muted-foreground">
      <GraduationCap className="size-4 shrink-0 text-ink-tertiary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {origin.via === "conversation" ? "Taught in a chat" : "Taught step by step"}
        {when ? ` · ${when}` : ""}
        {origin.conversationId ? (
          <>
            {" · "}
            <Link href={`/chat/${origin.conversationId}`} className="underline underline-offset-2 hover:text-foreground">
              Open the chat
            </Link>
          </>
        ) : null}
        {!enabled ? " · Off until you switch it on" : ""}
      </span>
      {canReteach ? (
        <Button asChild size="sm" variant="outline" className="h-7">
          <Link href={`/skills/teach?skill=${encodeURIComponent(skillId)}`}>{enabled ? "Teach it again" : "Review and turn on"}</Link>
        </Button>
      ) : null}
    </div>
  );
}
