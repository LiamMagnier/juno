import type { ClientWorkSession } from "@/lib/work/serializers";
import type { WorkTransportFailure } from "@/components/work/work-transport";

/*
 * What one press of Start is, and what to say when it produced nothing.
 *
 * Lifted out of `work-composer.tsx` unchanged. It is the composer's only piece
 * of pure logic — no state, no JSX, no hooks — and it was sitting between the
 * file's opening essay and the component itself, where a reader looking for the
 * surface had to scroll past a hundred lines of failure taxonomy first.
 */

/**
 * One attempt at starting, carried across retries.
 *
 * The two keys are minted once per attempt rather than per press. A press that
 * created the draft and then failed to dispatch must, on the next press, land on
 * the same draft — `POST /sessions` replays an existing id for a repeated key —
 * or every refused start leaves another orphan in the user's task list. Changing
 * the model between presses is safe despite the replay: the model rides the run
 * as well as the session, and the run is dispatched fresh each time.
 *
 * `inputs` is everything the create writes and the dispatch cannot: the goal,
 * the project and the attachment ids. It was the goal alone, and the replay is
 * what turned that into a bug. A file attached after a refused press — or a
 * project picked, or an attachment taken back off — changed nothing the second
 * press sent, because the second press skips the create and the draft still held
 * the first press's list; and then `clear()` wiped the chips on success as
 * though they had been sent. There is no route that edits a session's grants
 * afterwards — `POST /sessions` refuses to re-grant on a replay, on purpose, so
 * that a retry cannot rewrite the grants of a session somebody is already
 * running — so a fresh key, and with it a fresh draft, is the only way to send
 * what is on the screen.
 */
export interface StartAttempt {
  inputs: string;
  sessionKey: string;
  runKey: string;
  session: ClientWorkSession | null;
  confirmExpensive?: boolean;
}

/** A press that started nothing, and whether pressing again could. */
export interface StartFailure {
  message: string;
  /** False for a wall — a state where the button would ask the same question. */
  retryable: boolean;
}

/**
 * What to say about a failed request, and whether to offer a button at all.
 *
 * `work-transport.tsx` separates 400 and 401/403 from `server` so that, in its
 * own words, "the UI can stop offering a button that cannot work"; this is the
 * half that honours it. A 400 is a client this deployment no longer agrees with,
 * a 403 is a plan, a 404 is something the task points at that is gone, and none
 * of the three answer differently the second time. Only a dropped connection and
 * a 5xx get a Try again, because only those two are about the moment rather than
 * the request.
 *
 * The server's sentence wins wherever there is one. It is the only thing in this
 * exchange that knows which model, which plan or which file, and the fallbacks
 * below exist for the routes that answer with a bare code — `requireUser`'s 401
 * is the common one. They say what is known and stop; a fallback that guessed at
 * the cause would be a second, quieter way of getting it wrong.
 */
export function describeFailure(
  failure: WorkTransportFailure,
  phase: "save" | "start"
): StartFailure {
  if (failure.cause === "offline") {
    return {
      retryable: true,
      message:
        phase === "save"
          ? "Couldn’t reach Juno to save this task. Check your connection."
          : "Couldn’t reach Juno to start this task. Check your connection.",
    };
  }
  if (failure.cause === "server") {
    return {
      retryable: true,
      message:
        phase === "save"
          ? "Couldn’t save this task, so nothing was started."
          : "Couldn’t start this task, so nothing is running.",
    };
  }
  if (failure.message !== null) return { retryable: false, message: failure.message };
  if (failure.cause === "not_found") {
    return {
      retryable: false,
      message:
        "Something this task points at is no longer there — an attachment, the project, or the draft itself. Nothing was started.",
    };
  }
  if (failure.cause === "rejected") {
    return {
      retryable: false,
      message:
        "Juno wouldn’t accept this request, and pressing the button again sends the same one. Reloading the page may help.",
    };
  }
  return {
    retryable: false,
    message:
      "Juno turned this down without saying why. You may have been signed out — reload the page to check.",
  };
}
