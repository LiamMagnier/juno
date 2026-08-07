/*
 * How many files each task on the Work home produced.
 *
 * THE PROBLEM. A finished task and a finished task that left three documents
 * behind are the same row. `ClientWorkSession` carries no artifact count and
 * should not — it is the session table denormalised, and a count that lived
 * there would be a number to keep in step with every version of every
 * deliverable. So the count has to be read, and the only question is how
 * expensively.
 *
 * ONE REQUEST, NOT ONE PER ROW. `GET /api/work/artifacts` takes `sessionId` as
 * an OPTIONAL filter: without it the route answers with the account's most
 * recently updated deliverables, each carrying the session it belongs to. That
 * turns "which of these forty tasks produced files" into a single call on the
 * same poll as the session list, rather than forty calls that would put the Work
 * home an order of magnitude above every other page in the app for the sake of a
 * five-word label.
 *
 * WHAT THIS IS ALLOWED TO SAY. The route clamps `limit` to 100 and orders by
 * `updatedAt desc`, so this read sees the newest hundred deliverables and no
 * more. A session missing from the map has not been shown to have no files; it
 * has not been shown to have any. The distinction is the whole reason this
 * returns counts rather than a boolean per session: a row states a count it was
 * given and stays silent otherwise, and nothing in the UI is permitted to render
 * an absence as "produced nothing". An account with more than a hundred
 * deliverables loses the label on its oldest tasks, which is an omission the
 * reader can resolve by opening the task — where the real list lives.
 */

/**
 * How many deliverables to read. The route's own ceiling, asked for in full: a
 * smaller number would only make the silence above start sooner, and this is one
 * request either way.
 */
export const WORK_OUTPUTS_LIMIT = 100;

/**
 * Deliverable counts by session id, or null when the request did not answer.
 *
 * Null rather than an empty map, and the difference is the point. An empty map
 * is "the account has no deliverables", which would correctly remove every
 * label; a failed request knows nothing, and a caller handed an empty map for it
 * would silently strip labels off rows that have files. The caller keeps what it
 * last knew instead — the same treatment the Work home already gives a dropped
 * host list.
 */
export async function fetchWorkOutputCounts(): Promise<ReadonlyMap<string, number> | null> {
  let res: Response;
  try {
    res = await fetch(`/api/work/artifacts?limit=${WORK_OUTPUTS_LIMIT}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }

  const artifacts =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { artifacts?: unknown }).artifacts
      : undefined;
  if (!Array.isArray(artifacts)) return null;

  // Read tolerantly, one entry at a time, like every other reader of a Work
  // response: a row this build cannot make sense of is one label short, not a
  // page that fails to render. Counting rows rather than versions is deliberate
  // — a reader thinks in files, and a spreadsheet rewritten four times is one
  // file, not four.
  const counts = new Map<string, number>();
  for (const entry of artifacts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const sessionId = (entry as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  return counts;
}
