import assert from "node:assert/strict";
import test from "node:test";
import { DeviceLinkTransport, type FetchLike } from "@/lib/code-v2/env-client";
import { shouldApplyRemoteDraft } from "@/lib/sync/thread-draft-client";
import { formatCodeInput } from "@/lib/code-v2/pairing-code";
import { continueOn } from "@/lib/sync/handoff-client";

/*
 * The web's side of remote control and sync (docs/code-v2/REMOTE-CONTROL.md):
 * a browser without a pair is told where to pair, drafts from other devices
 * never overwrite typing or echo back, the code field formats as typed, and
 * Continue on iPhone / Mac says what happened.
 */

test("device link: a 403 not_paired answer surfaces the server's pairing message", async () => {
  const message = "This device is not allowed to control that Mac. On the Mac, open Alevr › Settings › Connections › Control this Mac remotely, and pair it.";
  const fetcher: FetchLike = async () => new Response(JSON.stringify({ error: message, message, code: "not_paired" }), { status: 403 });
  const transport = new DeviceLinkTransport("mac1", fetcher);
  const got = new Promise<{ code: string; message: string }>((resolve) =>
    transport.onMessage((m) => {
      if (m.type === "response" && !m.ok) resolve(m.error);
    }),
  );
  transport.send({ id: "c1", type: "session.list", params: {} });
  const error = await got;
  assert.equal(error.code, "unsupported");
  assert.equal(error.message, message);
  transport.close();
});

test("drafts: a remote draft applies only when newer, not ours, and the field is not being edited", () => {
  const remote = { draft: "from the Mac", draftBy: "mac", draftUpdatedAt: "2026-10-10T12:00:10Z" };
  const local = { text: "", editing: false, device: "web:abc", lastKnownAt: Date.parse("2026-10-10T12:00:00Z") };
  assert.equal(shouldApplyRemoteDraft(remote, local), true);
  assert.equal(shouldApplyRemoteDraft(remote, { ...local, editing: true }), false, "never over typing in progress");
  assert.equal(shouldApplyRemoteDraft({ ...remote, draftBy: "web:abc" }, local), false, "never our own echo");
  assert.equal(shouldApplyRemoteDraft(remote, { ...local, lastKnownAt: Date.parse("2026-10-10T12:00:20Z") }), false, "never an older draft");
  assert.equal(shouldApplyRemoteDraft(remote, { ...local, text: "from the Mac" }), false, "nothing to change");
  assert.equal(shouldApplyRemoteDraft({ ...remote, draft: "" }, { ...local, text: "sent elsewhere" }), true, "a send elsewhere clears it here");
});

test("pairing code field: formats as typed and drops what cannot be in a code", () => {
  assert.equal(formatCodeInput("k7qm"), "K7QM");
  assert.equal(formatCodeInput("k7qm4mzp"), "K7QM-4MZP");
  assert.equal(formatCodeInput("K7QM-4MZP-EXTRA"), "K7QM-4MZP");
  assert.equal(formatCodeInput("o0i1l u"), "", "ambiguous characters never enter");
});

test("continue on: the thread goes to the handoff route; a refusal is shown as the server words it", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const ok = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ sent: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const sent = await continueOn("ios", { kind: "chat", id: "c1", title: "Trip" }, ok);
  assert.equal(sent.ok, true);
  assert.match(sent.message, /iPhone/);
  assert.deepEqual(calls[0], { url: "/api/sync/handoff", body: { target: "ios", kind: "chat", id: "c1", title: "Trip" } });
  const refused = (async () => new Response(JSON.stringify({ error: "No Mac signed in to Alevr can receive it." }), { status: 404 })) as unknown as typeof fetch;
  const result = await continueOn("macos", { kind: "chat", id: "c1" }, refused);
  assert.deepEqual(result, { ok: false, message: "No Mac signed in to Alevr can receive it." });
});
