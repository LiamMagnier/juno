/**
 * The chat route's hold on a native in-chat research run (SPEC §9.3 B2): it
 * renews the drive's lease while the chat model streams the report, and
 * cancels the run when the stream ends early (Stop, an error, a disconnect).
 *
 * WS0 lands the signatures; WS7 implements them.
 */

/** Renews the run's worker lease for `owner` every 45 s until the returned stop is called. */
export function keepResearchLeaseAlive(_runId: string, _owner: string): () => void {
  throw new Error("not implemented: WS7");
}

export async function cancelResearchRun(_runId: string, _reason: string): Promise<void> {
  throw new Error("not implemented: WS7");
}
