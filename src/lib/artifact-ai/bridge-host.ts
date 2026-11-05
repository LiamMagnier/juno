import {
  ALEVR_CHUNK,
  ALEVR_RESPONSE,
  ARTIFACT_RUNTIME_COMPLETE_PATH,
  ARTIFACT_RUNTIME_STORAGE_PATH,
  BRIDGE_MAX_INFLIGHT_COMPLETIONS,
  BRIDGE_MAX_INFLIGHT_STORAGE,
  errorCodeForResponse,
  isAlevrErrorCode,
  parseBridgeRequest,
  type AlevrBridgeRequest,
  type AlevrErrorCode,
  type AlevrRuntimeTarget,
  type CompletionStreamEvent,
} from "@/lib/artifact-ai/protocol";

/**
 * The parent's half of `window.alevr`: what the page that frames a preview
 * does with the frame's calls.
 *
 * The caller hands this every message whose `source` is ITS frame's
 * `contentWindow` (useAlevrBridge does, in src/components/canvas); messages
 * from anywhere else never get here. Then, per call:
 *
 *   1. `parseBridgeRequest` checks the channel and the shape. A wrong channel
 *      is dropped unanswered; a malformed call is refused.
 *   2. With no target (an unsaved artifact, a preview with no artifact behind
 *      it) the call is refused as "unavailable": the app has nothing to bill
 *      or store against.
 *   3. On a shared or published page, the visitor is asked once per page
 *      view before the first call leaves the page (`askConsent`). The
 *      artifact is a stranger's code; it does not get to spend the visitor's
 *      usage or write into their account without them saying yes.
 *   4. The call goes to the route with the page's own session (same-origin
 *      `fetch`), and the answer is posted back to the frame on its channel.
 *
 * No React and no DOM beyond `fetch`, so the tests drive it directly.
 */

export type ConsentAnswer = "granted" | "denied" | "sign_in";

export interface AlevrBridgeHostOptions {
  /** This frame's channel, as written into its bridge script. */
  channel: string;
  /** Which artifact the calls are about; null refuses every call. */
  target: AlevrRuntimeTarget | null;
  /** Deliver a message to the frame (`contentWindow.postMessage(message, "*")`). */
  post: (message: Record<string, unknown>) => void;
  fetch: typeof fetch;
  /**
   * Asked before the first call on a page that is not the viewer's own (a
   * shared or published link). Absent on the owner's surfaces. Asked at most
   * once per host: the answer stands for the rest of the page view.
   */
  askConsent?: () => Promise<ConsentAnswer>;
}

export interface AlevrBridgeHost {
  /** One message from the frame (already checked to come from it). */
  handle(data: unknown): void;
  /** Abort every call in flight; later answers are dropped. */
  dispose(): void;
}

class BridgeError extends Error {
  constructor(
    readonly code: AlevrErrorCode,
    message: string
  ) {
    super(message);
  }
}

const UNAVAILABLE_MESSAGE = "AI and storage work once this artifact is saved and opened in the app.";
const CONSENT_DENIED_MESSAGE = "You chose not to let this app use AI or save data on your account.";
const SIGN_IN_MESSAGE = "Sign in to use this app's AI and saved data. It runs on your own account.";

export function createAlevrBridgeHost(opts: AlevrBridgeHostOptions): AlevrBridgeHost {
  const controllers = new Map<string, AbortController>();
  let completions = 0;
  let storageCalls = 0;
  let disposed = false;
  let consent: Promise<ConsentAnswer> | null = null;

  const respond = (id: string, payload: { ok: true; result: unknown } | { ok: false; code: AlevrErrorCode; message: string }) => {
    if (disposed) return;
    const message =
      payload.ok
        ? { type: ALEVR_RESPONSE, channel: opts.channel, id, ok: true, result: payload.result }
        : { type: ALEVR_RESPONSE, channel: opts.channel, id, ok: false, error: { code: payload.code, message: payload.message } };
    try {
      opts.post(message);
    } catch {
      // The frame went away between the call and its answer.
    }
  };

  const chunk = (id: string, text: string) => {
    if (disposed || !text) return;
    try {
      opts.post({ type: ALEVR_CHUNK, channel: opts.channel, id, text });
    } catch {
      // As above.
    }
  };

  const ensureConsent = async () => {
    if (!opts.askConsent) return;
    consent ??= opts.askConsent().catch(() => "denied" as const);
    const answer = await consent;
    if (answer === "sign_in") {
      // Not remembered: a visitor who signs in in another tab may try again.
      consent = null;
      throw new BridgeError("sign_in_required", SIGN_IN_MESSAGE);
    }
    if (answer !== "granted") throw new BridgeError("consent_denied", CONSENT_DENIED_MESSAGE);
  };

  /**
   * POST a body to a runtime route. `rawValue` is JSON text spliced in as the
   * body's `value` as it is, so a 5 MB value is not parsed and re-serialized
   * just to be sent (`parseBridgeRequest` has already proved it is JSON).
   */
  const post = async (path: string, body: Record<string, unknown>, signal: AbortSignal, rawValue?: string) => {
    const json = JSON.stringify({ target: opts.target, ...body });
    const res = await opts.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawValue === undefined ? json : `${json.slice(0, -1)},"value":${rawValue}}`,
      signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const errorBody: unknown = await res.json().catch(() => null);
      const code = errorCodeForResponse(res.status, errorBody);
      const message =
        errorBody && typeof errorBody === "object" && typeof (errorBody as { error?: unknown }).error === "string"
          ? (errorBody as { error: string }).error
          : "The request failed.";
      throw new BridgeError(code, message);
    }
    return res;
  };

  const runComplete = async (request: Extract<AlevrBridgeRequest, { method: "complete" }>, signal: AbortSignal) => {
    const { prompt, system, maxTokens, stream } = request.params;
    const res = await post(ARTIFACT_RUNTIME_COMPLETE_PATH, { prompt, system, maxTokens }, signal);
    if (!res.body) throw new BridgeError("failed", "The reply could not be read.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let text = "";
    const onLine = (line: string): "done" | null => {
      if (!line.trim()) return null;
      let event: CompletionStreamEvent;
      try {
        event = JSON.parse(line) as CompletionStreamEvent;
      } catch {
        throw new BridgeError("failed", "The reply could not be read.");
      }
      if (event.type === "text" && typeof event.text === "string") {
        text += event.text;
        if (stream) chunk(request.id, event.text);
        return null;
      }
      if (event.type === "error") {
        throw new BridgeError(isAlevrErrorCode(event.code) ? event.code : "failed", typeof event.message === "string" ? event.message : "The request failed.");
      }
      return event.type === "done" ? "done" : null;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (onLine(line) === "done") return text;
        newline = buffered.indexOf("\n");
      }
      if (done) break;
    }
    if (onLine(buffered + decoder.decode()) === "done") return text;
    throw new BridgeError("failed", "The reply ended early.");
  };

  const runStorage = async (request: Exclude<AlevrBridgeRequest, { method: "complete" | "cancel" }>, signal: AbortSignal) => {
    const op = request.method.slice("storage.".length);
    const res =
      request.method === "storage.set"
        ? await post(ARTIFACT_RUNTIME_STORAGE_PATH, { op, key: request.params.key }, signal, request.params.valueJson)
        : await post(ARTIFACT_RUNTIME_STORAGE_PATH, { op, ...request.params }, signal);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new BridgeError("failed", "The reply could not be read.");
    switch (request.method) {
      case "storage.get":
        // A key that was never set reads as null, like a key set to null.
        return body.found === true ? (body.value ?? null) : null;
      case "storage.set":
        return null;
      case "storage.delete":
        return body.deleted === true;
      case "storage.list":
        return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
    }
  };

  const run = async (request: Exclude<AlevrBridgeRequest, { method: "cancel" }>) => {
    const isCompletion = request.method === "complete";
    const controller = new AbortController();
    controllers.set(request.id, controller);
    if (isCompletion) completions++;
    else storageCalls++;
    try {
      await ensureConsent();
      const result =
        request.method === "complete" ? await runComplete(request, controller.signal) : await runStorage(request, controller.signal);
      if (!controller.signal.aborted) respond(request.id, { ok: true, result });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof BridgeError) respond(request.id, { ok: false, code: err.code, message: err.message });
      else respond(request.id, { ok: false, code: "failed", message: "The request could not reach the app. Check the connection and try again." });
    } finally {
      controllers.delete(request.id);
      if (isCompletion) completions--;
      else storageCalls--;
    }
  };

  return {
    handle(data) {
      if (disposed) return;
      const parsed = parseBridgeRequest(data, opts.channel);
      if (!parsed) return;
      if (!parsed.ok) {
        if (parsed.id) respond(parsed.id, { ok: false, code: parsed.code, message: parsed.message });
        return;
      }
      const request = parsed.request;
      if (request.method === "cancel") {
        controllers.get(request.params.id)?.abort();
        return;
      }
      if (controllers.has(request.id)) {
        respond(request.id, { ok: false, code: "invalid_request", message: "A call with this id is already running." });
        return;
      }
      if (!opts.target) {
        respond(request.id, { ok: false, code: "unavailable", message: UNAVAILABLE_MESSAGE });
        return;
      }
      if (request.method === "complete" ? completions >= BRIDGE_MAX_INFLIGHT_COMPLETIONS : storageCalls >= BRIDGE_MAX_INFLIGHT_STORAGE) {
        respond(request.id, { ok: false, code: "busy", message: "Too many calls at once. Wait for one to finish." });
        return;
      }
      void run(request);
    },
    dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };
}
