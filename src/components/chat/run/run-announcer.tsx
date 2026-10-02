"use client";

import * as React from "react";

import { formatPhrase } from "@/lib/i18n-phrase";
import { createAnnouncerQueue, researchAnnouncementKey, type AnnouncerQueue } from "@/lib/run/announcer";
import { RUN_COPY } from "@/lib/run/presentation";
import { researchPhases, subscribeResearchPhases, subscribeRunAnnouncements } from "@/lib/run/store";
import type { ResearchPhase } from "@/types/research";

/*
 * The chat's one polite live region (SPEC §7.12, DECISIONS U6): phase
 * boundaries of the streaming message, and Research phases published through
 * `publishResearchPhase`, spaced at least 3 s apart; waiting jumps the queue.
 *
 * The run blocks say what their run did (`announceRun`); this region decides
 * what is spoken, and when. There is no assertive region: priority is timing
 * only. Its text is already in the reader's language (the phrase runtime
 * built it), so it is marked for AutoTranslate to leave alone.
 */

export interface RunAnnouncerProps {
  /** renderKey of the message that is streaming, or null. */
  streamingRenderKey: string | null;
  /** The Activity panel covers the transcript (sheet mode): approvals are announced as in the panel. */
  panelCoversChat: boolean;
}

export function RunAnnouncer({ streamingRenderKey, panelCoversChat }: RunAnnouncerProps) {
  const coversRef = React.useRef(panelCoversChat);
  React.useEffect(() => {
    coversRef.current = panelCoversChat;
  }, [panelCoversChat]);
  const [message, setMessage] = React.useState("");
  const queueRef = React.useRef<AnnouncerQueue | null>(null);
  React.useEffect(() => {
    const queue = createAnnouncerQueue((text) => setMessage(text));
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, []);

  // The message a run's announcements are accepted from: the streaming one, and the last one
  // that streamed, whose "done" arrives as it stops streaming.
  const [current, setCurrent] = React.useState<string | null>(streamingRenderKey);
  if (streamingRenderKey !== null && streamingRenderKey !== current) setCurrent(streamingRenderKey);

  React.useEffect(
    () =>
      subscribeRunAnnouncements((renderKey, announcement) => {
        if (renderKey !== current) return;
        const text = coversRef.current && announcement.panelText ? announcement.panelText : announcement.text;
        queueRef.current?.push({ ...announcement, text });
      }),
    [current],
  );

  // Research runs of the open conversation: their phases arrive by polling and are published here.
  React.useEffect(() => {
    const seen = new Map<string, ResearchPhase>(researchPhases().map((p) => [p.runId, p.phase]));
    return subscribeResearchPhases(() => {
      for (const published of researchPhases()) {
        const previous = seen.get(published.runId) ?? null;
        seen.set(published.runId, published.phase);
        const said = researchAnnouncementKey(published.runId, previous, published.phase);
        if (!said) continue;
        queueRef.current?.push({ key: said.key, text: formatPhrase(RUN_COPY[said.copy]), urgent: said.urgent, once: said.once });
      }
    });
  }, []);

  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-no-auto-translate>
      {message}
    </span>
  );
}
