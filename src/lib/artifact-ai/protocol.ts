/**
 * `window.alevr`: what an artifact's own code may ask the app for.
 *
 * A REACT or HTML artifact runs in the canvas sandbox (an opaque-origin frame,
 * src/components/canvas/sandbox-frame.tsx), so it has no cookies, no session
 * and no way to reach the app's API. Two things a real app needs are lent to
 * it through the frame's postMessage bridge instead:
 *
 *   window.alevr.complete({ prompt, system?, maxTokens?, onText? })
 *     text from a model, on the VIEWER's account and the viewer's default
 *     background model (src/lib/artifact-ai/complete.ts);
 *   window.alevr.storage.get / set / delete / list
 *     JSON values kept per artifact AND per viewer (src/lib/artifact-ai/storage.ts).
 *
 * The frame never holds a credential. It posts a request to its parent; the
 * parent (src/lib/artifact-ai/bridge-host.ts) checks that the message came from
 * its own frame, on this frame's channel, in a shape this file accepts, and
 * makes the call itself with the page's session. The routes check everything
 * again, because anything can call a route.
 *
 * Pure and dependency-free: the in-frame script builder, the parent's host and
 * the routes all import the same names and limits from here.
 */

/** The two routes the parent calls on the frame's behalf. */
export const ARTIFACT_RUNTIME_COMPLETE_PATH = "/api/artifact-runtime/complete";
export const ARTIFACT_RUNTIME_STORAGE_PATH = "/api/artifact-runtime/storage";

/** Frame → parent: a call. */
export const ALEVR_REQUEST = "alevr:request";
/** Parent → frame: a call's result or error. */
export const ALEVR_RESPONSE = "alevr:response";
/** Parent → frame: a piece of a completion's text, for a call that asked to stream. */
export const ALEVR_CHUNK = "alevr:chunk";

export const ALEVR_METHODS = [
  "complete",
  "cancel",
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.list",
] as const;
export type AlevrMethod = (typeof ALEVR_METHODS)[number];

/*
 * ── LIMITS ──────────────────────────────────────────────────────────────────
 *
 * A completion: the prompt an app can send in one call (about 25k tokens) and
 * what it may ask back. The background models are the cheap tier, so the
 * figure that bounds the cost is the reply cap, not the prompt.
 */
export const COMPLETE_MAX_PROMPT_CHARS = 100_000;
export const COMPLETE_MAX_SYSTEM_CHARS = 20_000;
export const COMPLETE_DEFAULT_MAX_TOKENS = 1024;
export const COMPLETE_MAX_TOKENS = 4096;

/*
 * Storage. 20 MB per artifact for each viewer, the figure Claude's artifacts
 * offer; at most 5 MB in one value and 1,000 keys in one artifact's store.
 * The account-wide ceiling is the abuse cap: a shared page cannot make every
 * signed-in visitor keep 20 MB for each of a thousand artifacts.
 */
export const STORAGE_MAX_KEY_CHARS = 200;
export const STORAGE_MAX_VALUE_BYTES = 5 * 1024 * 1024;
export const STORAGE_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const STORAGE_MAX_ACCOUNT_BYTES = 100 * 1024 * 1024;
export const STORAGE_MAX_KEYS = 1000;

/**
 * Calls one frame may have open at once. A loop in an app should meet "busy"
 * in the frame, not a wall of requests at the server.
 */
export const BRIDGE_MAX_INFLIGHT_COMPLETIONS = 4;
export const BRIDGE_MAX_INFLIGHT_STORAGE = 16;

/** What a failed call's `error.code` can be, in the frame and on the wire. */
export const ALEVR_ERROR_CODES = [
  "invalid_request",
  "unavailable",
  "sign_in_required",
  "consent_denied",
  "busy",
  "rate_limited",
  "budget_exceeded",
  "model_unavailable",
  "storage_full",
  "too_large",
  "policy_violation",
  "aborted",
  "failed",
] as const;
export type AlevrErrorCode = (typeof ALEVR_ERROR_CODES)[number];

export function isAlevrErrorCode(value: unknown): value is AlevrErrorCode {
  return typeof value === "string" && (ALEVR_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Which artifact a call is about, as the page that frames it knows it: the
 * owner's own surfaces (the canvas, the chat card, `/a/{id}`) by id, a shared
 * or published page by its link token. Never both: a token page has no
 * business naming an id, and the route resolves each kind its own way.
 */
export type AlevrRuntimeTarget = { artifactId: string } | { shareToken: string };

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function isRuntimeTarget(value: unknown): value is AlevrRuntimeTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  if (keys[0] === "artifactId") return typeof v.artifactId === "string" && ARTIFACT_ID.test(v.artifactId);
  if (keys[0] === "shareToken") return typeof v.shareToken === "string" && SHARE_TOKEN.test(v.shareToken);
  return false;
}

/** A stable string for a target, for effect keys and rate-limit buckets. */
export function runtimeTargetKey(target: AlevrRuntimeTarget | null | undefined): string {
  if (!target) return "none";
  return "artifactId" in target ? `a:${target.artifactId}` : `s:${target.shareToken}`;
}

// ── Storage keys and values ─────────────────────────────────────────────────

/** C0, DEL and the C1 block: characters no key should carry into a log line or a list. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** 1–200 characters, none of them a control character. Anything else is a name an app may choose. */
export function isStorageKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= STORAGE_MAX_KEY_CHARS && !hasControlCharacter(key);
}

/** A `list` prefix: empty, or anything a key could start with. */
export function isStoragePrefix(prefix: unknown): prefix is string {
  return typeof prefix === "string" && prefix.length <= STORAGE_MAX_KEY_CHARS && !hasControlCharacter(prefix);
}

/** UTF-8 length, the unit every storage cap is counted in. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What one entry costs against the caps: its key and its JSON text. */
export function storageEntryBytes(key: string, valueJson: string): number {
  return utf8Bytes(key) + utf8Bytes(valueJson);
}

/**
 * A value as the store keeps it: its JSON text. `undefined`, a function, a
 * symbol, a BigInt or a cycle has no JSON form and is refused rather than
 * silently stored as nothing — `delete` is how an app removes a key.
 */
export function serializeStorageValue(value: unknown): { ok: true; json: string } | { ok: false; message: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return { ok: false, message: `This value cannot be saved as JSON (${err instanceof Error ? err.message : String(err)}).` };
  }
  if (typeof json !== "string") return { ok: false, message: "This value cannot be saved as JSON. Use storage.delete to remove a key." };
  return { ok: true, json };
}

/** True when `text` is one JSON value (the routes re-check what the parent serialized). */
export function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ── Requests from the frame ─────────────────────────────────────────────────

const REQUEST_ID = /^[A-Za-z0-9:_-]{1,80}$/;

export type AlevrBridgeRequest =
  | {
      id: string;
      method: "complete";
      params: { prompt: string; system?: string; maxTokens: number; stream: boolean };
    }
  | { id: string; method: "cancel"; params: { id: string } }
  | { id: string; method: "storage.get" | "storage.delete"; params: { key: string } }
  | { id: string; method: "storage.set"; params: { key: string; valueJson: string } }
  | { id: string; method: "storage.list"; params: { prefix: string } };

export type ParsedBridgeMessage =
  | { ok: true; request: AlevrBridgeRequest }
  /** Ours, but malformed. `id` is set when there is a call to answer. */
  | { ok: false; id: string | null; code: AlevrErrorCode; message: string };

/**
 * Read one message from the frame.
 *
 * `null` means "not for the bridge": another of the frame's messages (console,
 * status), or a request on another channel — which is what a document the
 * preview navigated to would send, since it never saw the channel. Those are
 * dropped without an answer. Everything else is either a request this file
 * vouches for or a refusal the caller sends back to the call that made it.
 *
 * The frame is artifact code, so nothing here trusts a field it did not
 * check: every string is typed and bounded, every number is an integer in
 * range, and unknown methods are refused.
 */
export function parseBridgeRequest(data: unknown, channel: string): ParsedBridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== ALEVR_REQUEST) return null;
  if (!channel || d.channel !== channel) return null;
  const id = typeof d.id === "string" && REQUEST_ID.test(d.id) ? d.id : null;
  if (!id) return { ok: false, id: null, code: "invalid_request", message: "The request has no usable id." };
  const refuse = (message: string, code: AlevrErrorCode = "invalid_request"): ParsedBridgeMessage => ({
    ok: false,
    id,
    code,
    message,
  });
  if (typeof d.method !== "string" || !(ALEVR_METHODS as readonly string[]).includes(d.method)) {
    return refuse("Unknown method. Use alevr.complete or alevr.storage.");
  }
  const params = d.params && typeof d.params === "object" ? (d.params as Record<string, unknown>) : {};
  const method = d.method as AlevrMethod;

  switch (method) {
    case "complete": {
      const { prompt, system, maxTokens, stream } = params;
      if (typeof prompt !== "string" || !prompt.trim()) return refuse("alevr.complete needs a prompt (a non-empty string).");
      if (prompt.length > COMPLETE_MAX_PROMPT_CHARS) {
        return refuse(`The prompt is longer than ${COMPLETE_MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`, "too_large");
      }
      if (system !== undefined && system !== null && typeof system !== "string") return refuse("`system` must be a string.");
      if (typeof system === "string" && system.length > COMPLETE_MAX_SYSTEM_CHARS) {
        return refuse(`The system prompt is longer than ${COMPLETE_MAX_SYSTEM_CHARS.toLocaleString("en-US")} characters.`, "too_large");
      }
      let tokens = COMPLETE_DEFAULT_MAX_TOKENS;
      if (maxTokens !== undefined && maxTokens !== null) {
        if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > COMPLETE_MAX_TOKENS) {
          return refuse(`\`maxTokens\` must be a whole number from 1 to ${COMPLETE_MAX_TOKENS}.`);
        }
        tokens = maxTokens;
      }
      return {
        ok: true,
        request: {
          id,
          method,
          params: {
            prompt,
            ...(typeof system === "string" && system.trim() ? { system } : {}),
            maxTokens: tokens,
            stream: stream === true,
          },
        },
      };
    }
    case "cancel": {
      const target = typeof params.id === "string" && REQUEST_ID.test(params.id) ? params.id : null;
      if (!target) return refuse("Nothing to cancel.");
      return { ok: true, request: { id, method, params: { id: target } } };
    }
    case "storage.get":
    case "storage.delete": {
      if (!isStorageKey(params.key)) return refuse(storageKeyMessage());
      return { ok: true, request: { id, method, params: { key: params.key } } };
    }
    case "storage.set": {
      if (!isStorageKey(params.key)) return refuse(storageKeyMessage());
      const serialized = serializeStorageValue(params.value);
      if (!serialized.ok) return refuse(serialized.message);
      if (utf8Bytes(serialized.json) > STORAGE_MAX_VALUE_BYTES) {
        return refuse("This value is larger than 5 MB. Split it across several keys.", "too_large");
      }
      return { ok: true, request: { id, method, params: { key: params.key, valueJson: serialized.json } } };
    }
    case "storage.list": {
      const prefix = params.prefix === undefined || params.prefix === null ? "" : params.prefix;
      if (!isStoragePrefix(prefix)) return refuse("`prefix` must be a string of at most 200 characters.");
      return { ok: true, request: { id, method, params: { prefix } } };
    }
  }
}

function storageKeyMessage(): string {
  return `A storage key is a string of 1 to ${STORAGE_MAX_KEY_CHARS} characters with no control characters.`;
}

// ── The completion stream (route → parent) ──────────────────────────────────

/**
 * One NDJSON line of POST /api/artifact-runtime/complete. Refusals before the
 * model is reached are plain HTTP errors with a JSON body; once the stream has
 * started, a failure is its last line.
 */
export type CompletionStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string }
  | { type: "error"; code: AlevrErrorCode; message: string };

/** The error code a refused route call stands for, from its body or else its status. */
export function errorCodeForResponse(status: number, body: unknown): AlevrErrorCode {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (isAlevrErrorCode(code)) return code;
  if (status === 400) return "invalid_request";
  if (status === 401) return "sign_in_required";
  if (status === 402) return "budget_exceeded";
  if (status === 403) return "policy_violation";
  if (status === 404 || status === 409) return "unavailable";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  return "failed";
}

/** A fresh channel for one frame: 128 random bits, base64url. */
export function newBridgeChannel(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
