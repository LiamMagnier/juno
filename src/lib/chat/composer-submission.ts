/**
 * A send owns the draft revision it started with, never later typing. React
 * state alone cannot serialize two Enter/click events before the busy render,
 * so the composer claims a synchronous ticket before its first await.
 */
export interface ComposerDraftStamp {
  scope: string;
  revision: number;
}

export interface ComposerSubmission extends ComposerDraftStamp {
  readonly id: number;
}

export function submittedDraftIsCurrent(submitted: ComposerDraftStamp, current: ComposerDraftStamp): boolean {
  return submitted.scope === current.scope && submitted.revision === current.revision;
}

export function createComposerSubmissionGuard() {
  let current: ComposerSubmission | null = null;
  let sequence = 0;
  return {
    begin(stamp: ComposerDraftStamp): ComposerSubmission | null {
      if (current?.scope === stamp.scope) return null;
      current = { ...stamp, id: ++sequence };
      return current;
    },
    owns(ticket: ComposerSubmission): boolean {
      return current === ticket;
    },
    finish(ticket: ComposerSubmission): boolean {
      if (current !== ticket) return false;
      current = null;
      return true;
    },
  };
}
