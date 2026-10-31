/**
 * Which face the composer's one primary button wears: checking, stop, send or
 * voice.
 *
 * Voice takes the slot only when there is NOTHING to send — no words, no file
 * on the row (ready or still uploading), no clarification answer. It used to
 * take it whenever a send was not possible right now, and "not possible right
 * now" includes "a file is still uploading" and "the quota is spent": typing a
 * message while a file uploaded left the slot saying "Start voice
 * conversation", and the press a person meant as Send opened a call. A draft
 * that cannot go yet keeps the send face, disabled, and the button names what
 * it is waiting for.
 */
export type ComposerPrimaryFaceName = "checking" | "stop" | "send" | "voice";

export interface ComposerPrimaryFaceInput {
  /** The chat is running its pre-send check. */
  checking: boolean;
  /** The field steers a live run instead of sending a message. */
  steerMode: boolean;
  /** An answer is streaming (or a stop is in flight). */
  busy: boolean;
  /** A run the field steers is going on its own. */
  standaloneRun: boolean;
  /** The draft has words in it (trimmed). */
  hasText: boolean;
  /** Something besides words is waiting to go: a file (uploading or ready) or a clarification answer. */
  hasOtherDraft: boolean;
  /** A send would go out right now. */
  canSend: boolean;
  /** A voice conversation can be started from this composer. */
  voiceAvailable: boolean;
}

export function composerPrimaryFace(input: ComposerPrimaryFaceInput): ComposerPrimaryFaceName {
  if (input.checking) return "checking";
  if (input.steerMode && input.hasText) return "send";
  if (input.busy || input.standaloneRun) return "stop";
  const somethingToSend = input.hasText || input.hasOtherDraft;
  return input.canSend || somethingToSend || !input.voiceAvailable ? "send" : "voice";
}
