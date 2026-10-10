/**
 * "Continue on iPhone / Mac" from the web (docs/code-v2/REMOTE-CONTROL.md §Hand-off).
 */
export type HandoffTarget = "ios" | "macos";

/** Sends the open thread to the account's iPhone or Mac (POST /api/sync/handoff); resolves to the message to show. */
export async function continueOn(
  target: HandoffTarget,
  thread: { kind: "chat" | "code"; id: string; deviceId?: string; title?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const place = target === "ios" ? "iPhone" : "Mac";
  try {
    const res = await fetcher("/api/sync/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ target, ...thread }),
    });
    if (res.ok) return { ok: true, message: `Sent to your ${place}. Open the notification there to continue.` };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: body.error ?? `Alevr could not reach your ${place}.` };
  } catch {
    return { ok: false, message: `Alevr could not reach your ${place}.` };
  }
}

