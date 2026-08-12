/**
 * Failure translation for the Chat service.
 *
 * ## Why every error here is user-facing
 *
 * The renderer never sees an exception. `chatInvoke` resolves to
 * `{ok: false, error: string}` and the surface renders that string verbatim —
 * `use-chat.ts` puts it straight into an `error` stream frame. So the `message`
 * on anything this module throws IS the sentence a person reads. There is no
 * second, friendlier layer above it to hide a stack trace behind.
 *
 * That makes the mapping below load-bearing rather than cosmetic. The transport
 * raises precise, correct errors (`UnauthorizedError`, `NetworkError`,
 * `ContractMismatchError`, …) whose messages are written for a developer
 * reading a log. `describeFailure` turns each one into a sentence that names
 * what happened and what the person can do about it.
 *
 * **Signed-out is the normal state during development.** `NotSignedInError`
 * therefore gets the clearest sentence of the lot and is explicitly not
 * laundered into "something went wrong": a chat surface that says "Something
 * went wrong" when nobody is signed in has told the developer nothing and the
 * user something false.
 *
 * ## Logging
 *
 * `logFields` is the only shape that may reach the log. It carries a status, an
 * envelope code and a server request id — exactly what a bug report needs — and
 * never a message body, an attachment name, a path or a token. The logger
 * redacts at the sink as well; this is the first of the two controls, not the
 * only one.
 */

import {
  ApiError,
  CancelledError,
  ContractMismatchError,
  MalformedResponseError,
  NetworkError,
  TimeoutError,
  UnauthorizedError,
} from '../auth/transport.js';

/**
 * Anything this service throws at an IPC caller.
 *
 * `retryable` is advisory metadata for main's own decisions (should the turn's
 * terminal frame offer a retry). It does not cross IPC — the contract's
 * `error` frame carries its own `retryable` flag, which the stream path sets.
 */
export class ChatServiceError extends Error {
  override readonly name: string = 'ChatServiceError';

  constructor(
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

/** A second turn was started for a conversation that is already generating. */
export class TurnInFlightError extends ChatServiceError {
  override readonly name = 'TurnInFlightError';

  constructor(readonly conversationId: string) {
    super(
      'Juno is still answering in this conversation. Stop that response before starting another.',
      false,
    );
  }
}

/** No account is signed in. Its own type so callers can special-case the empty state. */
export class SignedOutError extends ChatServiceError {
  override readonly name = 'SignedOutError';

  constructor() {
    super('Sign in to your Juno account to use chat.', false);
  }
}

/**
 * Structural test for `session.ts`'s `NotSignedInError` without importing it.
 *
 * `session.ts` owns the auth state machine and this module has no business
 * depending on it; matching on the name keeps the direction of the dependency
 * one-way. The name is part of that class's public surface (it is `readonly`
 * and set explicitly), so this is a stable check, not a heuristic.
 */
function isNotSignedIn(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotSignedInError';
}

/**
 * Turn any failure into one a person can act on.
 *
 * Already-translated `ChatServiceError`s pass through untouched: they were
 * written at the call site that knew the most about the operation, and a second
 * pass would only make them vaguer.
 */
export function describeFailure(error: unknown, operation: string): ChatServiceError {
  if (error instanceof ChatServiceError) return error;
  if (isNotSignedIn(error)) return new SignedOutError();

  if (error instanceof UnauthorizedError) {
    return new ChatServiceError('Your Juno session is no longer valid. Sign in again.', false);
  }

  if (error instanceof ApiError) return fromApiError(error, operation);

  if (error instanceof TimeoutError) {
    return new ChatServiceError(`Juno took too long to ${operation}. Check your connection and try again.`);
  }
  if (error instanceof NetworkError) {
    return new ChatServiceError(
      `Juno could not reach the server to ${operation}. Check your connection and try again.`,
    );
  }
  if (error instanceof CancelledError) {
    return new ChatServiceError(`Juno stopped trying to ${operation}.`, false);
  }
  if (error instanceof ContractMismatchError || error instanceof MalformedResponseError) {
    /* Both already say the true thing in words a person can act on — one names
       which side needs updating, the other names the request that misbehaved. */
    return new ChatServiceError(error.message, false);
  }

  return new ChatServiceError(`Juno could not ${operation}.`);
}

function fromApiError(error: ApiError, operation: string): ChatServiceError {
  /* The backend's own sentence is preferred wherever it wrote one for a person:
     quota, budget and rate-limit messages name numbers this process does not
     have. `Juno returned HTTP 500.` is the transport's placeholder for "no
     parseable body", and is replaced. */
  const serverSentence = error.message.startsWith('Juno returned HTTP ') ? null : error.message;

  switch (error.status) {
    case 400:
      return new ChatServiceError(serverSentence ?? `Juno refused to ${operation}.`, false);
    case 402:
    case 429:
      return new ChatServiceError(serverSentence ?? 'Juno is rate limiting this account. Try again shortly.');
    case 403:
      return new ChatServiceError(serverSentence ?? `You do not have access to ${operation}.`, false);
    case 404:
      return new ChatServiceError('That conversation no longer exists.', false);
    case 409:
      return new ChatServiceError(serverSentence ?? 'That conversation is busy. Try again in a moment.');
    case 413:
      return new ChatServiceError(serverSentence ?? 'That file is too large to upload.', false);
    case 503:
      return new ChatServiceError(serverSentence ?? 'Juno is temporarily unavailable. Try again shortly.');
    default:
      break;
  }
  if (error.status >= 500) {
    return new ChatServiceError(serverSentence ?? `Juno had a problem and could not ${operation}.`);
  }
  return new ChatServiceError(serverSentence ?? `Juno could not ${operation}.`, error.retryable);
}

/**
 * The only shape of an error that may be logged.
 *
 * Never the message of an arbitrary error: a backend sentence can quote a
 * conversation title, and a Node error can quote a path. Status, code and
 * request id are enough to find the request in the backend's access log and
 * carry nothing about its content.
 */
export function logFields(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      kind: error.name,
      status: error.status,
      code: error.code ?? 'none',
      requestId: error.requestId ?? 'none',
    };
  }
  if (error instanceof Error) return { kind: error.name };
  return { kind: 'unknown' };
}
