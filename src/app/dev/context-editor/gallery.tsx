"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import type { SendOptions } from "@/hooks/use-chat";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import { BOOTSTRAP } from "../composer-landing/fixture";
import { loadMentionFixtures } from "../composer-landing/mention-fixtures";

/*
 * The REAL chat composer and its context field, signed out, with synthetic
 * context (mention-fixtures.ts). Type @, choose a row, click a token, send:
 * the panel under it shows the draft the composer holds and the request it
 * sent (text plus token ranges), so the editor's behaviour can be checked
 * without an account. Dev-only (page.dev.tsx).
 */
export function ContextEditorGallery() {
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const [sent, setSent] = React.useState<{ text: string; options?: SendOptions } | null>(null);
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 bg-background p-6 text-foreground">
        <h1 className="font-serif text-page-title">Context editor</h1>
        <p className="text-ui text-muted-foreground">
          The production composer with synthetic files, apps and agents. Type @, choose one, click it, then send.
        </p>
        <Composer
          conversationId={null}
          model={model}
          onModelChange={setModel}
          onSend={(text, _attachments, options) => {
            setSent({ text, options });
            return { accepted: true };
          }}
          isBusy={false}
          status="idle"
          onStop={() => {}}
          reasoningEffort={effort}
          onReasoningChange={setEffort}
          onToggleWebSearch={() => {}}
          webSearchEnabled
          onToggleConnector={() => {}}
          frame="inline"
          loadMentions={(query) => loadMentionFixtures(query)}
        />
        {sent ? (
          <pre aria-label="Sent request" data-sent-request="" className="overflow-auto rounded-card bg-secondary p-4 text-caption">
            {JSON.stringify({ text: sent.text, context: sent.options?.context ?? [] }, null, 2)}
          </pre>
        ) : null}
      </main>
    </AppProvider>
  );
}
