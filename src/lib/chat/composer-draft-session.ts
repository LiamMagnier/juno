import type { ContextDraft } from "@/lib/chat/context-draft";
import { tokensForText } from "@/lib/chat/context-draft";
import type { ContextToken } from "@/lib/chat/context-tokens";
import { createComposerSubmissionGuard } from "@/lib/chat/composer-submission";
import { createComposerUploadSession } from "@/lib/chat/composer-upload-session";

export interface ComposerDraftSnapshot extends ContextDraft {
  revision: number;
}

/**
 * A draft belongs to a conversation view, not to its landing/docked field.
 * This session lives only in that view's memory: it never touches storage,
 * the account, or the network. In particular, an incognito draft survives the
 * first-send layout handoff without becoming a persisted draft.
 */
export function createComposerDraftSession(scope: string) {
  let snapshot: ComposerDraftSnapshot = { text: "", tokens: [], revision: 0 };
  const listeners = new Set<() => void>();
  const sameTokens = (next: readonly ContextToken[]) => snapshot.tokens.length === next.length &&
    snapshot.tokens.every((token, index) => {
      const other = next[index];
      return token.kind === other.kind && token.id === other.id && token.label === other.label &&
        token.range?.start === other.range?.start && token.range?.end === other.range?.end &&
        token.meta?.icon === other.meta?.icon && token.meta?.subtitle === other.meta?.subtitle;
    });
  const replace = (text: string, tokens: ContextToken[]) => {
    if (snapshot.text === text && sameTokens(tokens)) return;
    snapshot = { text, tokens: [...tokens], revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  };
  return {
    scope,
    submissions: createComposerSubmissionGuard(),
    uploads: createComposerUploadSession(),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setText(text: string) {
      replace(text, tokensForText(text, snapshot.tokens));
    },
    // The editor publishes tokens before its text callback. Do not validate
    // them against the previous string; setText validates the matching pair.
    setTokens(tokens: ContextToken[]) {
      replace(snapshot.text, tokens);
    },
    clearIfCurrent(revision: number): boolean {
      if (snapshot.revision !== revision) return false;
      replace("", []);
      return true;
    },
  };
}

export type ComposerDraftSession = ReturnType<typeof createComposerDraftSession>;
