/*
 * A TypeScript port of how a SHIPPED native build (Mac/iOS 1.6.0, build 87)
 * reads the chat stream: `ChatSSEParser` and `decodeEvent` in
 * `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeChatAPIClient.swift`
 * (the `switch envelope.type` at :1132-1231, the wire structs at :1550-1690,
 * the parser at :1692-1760).
 *
 * It follows SWIFT'S behaviour, not the OpenAPI document's:
 *  - an unknown frame `type` throws (`default: throw malformedResponse`), and
 *    so does a known one whose required fields fail validation;
 *  - Codable IGNORES unknown keys, so `reasoning.part`, `delta.round` and
 *    `activity.event.seq` decode fine even though the YAML says
 *    `additionalProperties: false`;
 *  - a field decoded with `decodeIfPresent` throws when it is present with the
 *    wrong JSON type, while one decoded with `try?` (`message`, `event`,
 *    `approval`) quietly becomes absent;
 *  - one SSE event may carry at most 5 MiB of data (`maximumEventBytes`).
 *
 * Used by `native-stream-conformance.test.ts`: every profile-1 turn the server
 * can produce must decode here without a throw (INV-1 to INV-6).
 */

export class NativeMalformedResponse extends Error {
  constructor(reason: string) {
    super(`malformedResponse: ${reason}`);
  }
}

export class NativeEventTooLarge extends Error {
  constructor(kind: "line" | "payload") {
    super(kind === "line" ? "eventLineTooLarge" : "eventPayloadTooLarge");
  }
}

export const NATIVE_MAX_EVENT_BYTES = 5 * 1024 * 1024;
export const NATIVE_MAX_LINE_BYTES = 5 * 1024 * 1024;

export interface NativeSource {
  title: string;
  url: string;
  snippet: string;
}

export interface NativeApproval {
  id: string;
  status: string;
  riskClass: string;
  preview: string;
  connectorLabel: string;
  toolName: string;
  action: string;
}

export type NativeServerEvent =
  | { kind: "metadata"; conversationId: string; userMessageId?: string; title: string; generationId?: string }
  | { kind: "title"; conversationId: string; title: string }
  | { kind: "textDelta"; text: string }
  | { kind: "reasoningDelta"; text: string }
  | { kind: "sources"; sources: NativeSource[] }
  | {
      kind: "completed";
      id: string;
      content: string;
      reasoning?: string;
      finishReason: string;
      sources: NativeSource[];
    }
  | { kind: "failed"; message: string; finishReason: string }
  | { kind: "activity"; id: string; activityKind: string; title: string; detail?: string; url?: string }
  | { kind: "approval"; approval: NativeApproval }
  | { kind: "mediaProgress"; stage: string; pct?: number }
  | { kind: "ping" };

// ── SSE framing (ChatSSEParser) ──────────────────────────────────────────────

/** The data payloads of every event in `bytes`, as native splits them. Throws on an oversized event. */
export function parseNativeSse(bytes: Uint8Array): Uint8Array[] {
  const events: Uint8Array[] = [];
  let line: number[] = [];
  let dataLines: Uint8Array[] = [];
  let eventBytes = 0;

  const dispatch = () => {
    if (!dataLines.length) throw new NativeMalformedResponse("empty event");
    const total = dataLines.reduce((sum, part) => sum + part.length, 0) + dataLines.length - 1;
    const payload = new Uint8Array(total);
    let at = 0;
    dataLines.forEach((part, index) => {
      if (index > 0) payload[at++] = 0x0a;
      payload.set(part, at);
      at += part.length;
    });
    dataLines = [];
    eventBytes = 0;
    if (!payload.length) throw new NativeMalformedResponse("empty payload");
    events.push(payload);
  };

  const finishLine = () => {
    if (line[line.length - 1] === 0x0d) line.pop();
    const current = line;
    line = [];
    if (!current.length) {
      if (dataLines.length) dispatch();
      return;
    }
    if (current[0] === 0x3a) return; // a comment
    const separator = current.indexOf(0x3a);
    const fieldBytes = separator === -1 ? current : current.slice(0, separator);
    const field = fieldBytes.length > 16 ? "" : String.fromCharCode(...fieldBytes);
    if (field !== "data") return; // `id:` and anything else are ignored
    let value = separator === -1 ? [] : current.slice(separator + 1);
    if (value[0] === 0x20) value = value.slice(1);
    eventBytes += value.length;
    if (eventBytes > NATIVE_MAX_EVENT_BYTES) throw new NativeEventTooLarge("payload");
    dataLines.push(Uint8Array.from(value));
  };

  for (const byte of bytes) {
    if (byte !== 0x0a) {
      if (line.length >= NATIVE_MAX_LINE_BYTES) throw new NativeEventTooLarge("line");
      line.push(byte);
      continue;
    }
    finishLine();
  }
  if (line.length) finishLine();
  if (dataLines.length) dispatch();
  return events;
}

// ── Codable semantics ────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const encoder = new TextEncoder();
const utf8Length = (value: string) => encoder.encode(value).length;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `decodeIfPresent(String.self)`: absent or null → undefined; any other type throws. */
function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new NativeMalformedResponse(`${key} is not a string`);
  return value;
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new NativeMalformedResponse(`${key} is missing`);
  return value;
}

function optionalInt(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new NativeMalformedResponse(`${key} is not an Int`);
  return value;
}

function optionalDouble(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") throw new NativeMalformedResponse(`${key} is not a Double`);
  return value;
}

function requiredBool(object: JsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new NativeMalformedResponse(`${key} is not a Bool`);
  return value;
}

/** `try?`: whatever fails becomes absent. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** `CharacterSet.controlCharacters` is Unicode Cc and Cf. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function validText(value: string, maximum: number): boolean {
  return value.length > 0 && utf8Length(value) <= maximum && !CONTROL_OR_FORMAT.test(value);
}

/** `ISO8601DateFormatter` with `.withInternetDateTime`, with or without fractional seconds. */
function parseDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Foundation's `URL(string:)`, conservatively: printable ASCII only, http(s), with a host. */
function parseUrl(value: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

function sourceWire(value: Json): NativeSource {
  if (!isObject(value)) throw new NativeMalformedResponse("source is not an object");
  return { title: requiredString(value, "title"), url: requiredString(value, "url"), snippet: requiredString(value, "snippet") };
}

function sourceList(value: Json | undefined): NativeSource[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new NativeMalformedResponse("sources is not an array");
  return value.map(sourceWire);
}

function decodeSource(wire: NativeSource): NativeSource {
  if (!validText(wire.title, 2_000) || utf8Length(wire.snippet) > 32 * 1024 || !parseUrl(wire.url)) {
    throw new NativeMalformedResponse(`invalid source ${JSON.stringify(wire.title)} ${wire.url}`);
  }
  return wire;
}

interface MessageWire {
  id: string;
  role: string;
  content: string;
  reasoning?: string;
  createdAt: string;
  sources?: NativeSource[];
  finishReason?: string;
}

function messageWire(value: Json): MessageWire {
  if (!isObject(value)) throw new NativeMalformedResponse("message is not an object");
  optionalString(value, "model");
  optionalInt(value, "promptTokens");
  optionalInt(value, "completionTokens");
  optionalDouble(value, "costUsd");
  optionalInt(value, "cacheReadTokens");
  optionalInt(value, "cacheWriteTokens");
  return {
    id: requiredString(value, "id"),
    role: requiredString(value, "role"),
    content: requiredString(value, "content"),
    reasoning: optionalString(value, "reasoning"),
    createdAt: requiredString(value, "createdAt"),
    sources: sourceList(value.sources),
    finishReason: optionalString(value, "finishReason"),
  };
}

function activityWire(value: Json): { id: string; kind: string; title: string; detail?: string; url?: string } {
  if (!isObject(value)) throw new NativeMalformedResponse("event is not an object");
  return {
    id: requiredString(value, "id"),
    kind: requiredString(value, "kind"),
    title: requiredString(value, "title"),
    detail: optionalString(value, "detail"),
    url: optionalString(value, "url"),
  };
}

interface ApprovalWire {
  id: string;
  surface: string;
  sessionId: string;
  conversationId?: string;
  connectorId: string;
  connectorLabel: string;
  toolName: string;
  action: string;
  riskClass: string;
  preview: string;
  detail: JsonObject;
  receiptDigest: string;
  status: string;
  decision?: string;
  canAllowScope: boolean;
  derivedFromUntrusted: boolean;
  expiresAt: string;
  decidedAt?: string;
  completedAt?: string;
  createdAt: string;
}

function approvalWire(value: Json): ApprovalWire {
  if (!isObject(value)) throw new NativeMalformedResponse("approval is not an object");
  const detail = value.detail;
  if (!isObject(detail)) throw new NativeMalformedResponse("approval detail is not an object");
  return {
    id: requiredString(value, "id"),
    surface: requiredString(value, "surface"),
    sessionId: requiredString(value, "sessionId"),
    conversationId: optionalString(value, "conversationId"),
    connectorId: requiredString(value, "connectorId"),
    connectorLabel: requiredString(value, "connectorLabel"),
    toolName: requiredString(value, "toolName"),
    action: requiredString(value, "action"),
    riskClass: requiredString(value, "riskClass"),
    preview: requiredString(value, "preview"),
    detail,
    receiptDigest: requiredString(value, "receiptDigest"),
    status: requiredString(value, "status"),
    decision: optionalString(value, "decision"),
    canAllowScope: requiredBool(value, "canAllowScope"),
    derivedFromUntrusted: requiredBool(value, "derivedFromUntrusted"),
    expiresAt: requiredString(value, "expiresAt"),
    decidedAt: optionalString(value, "decidedAt"),
    completedAt: optionalString(value, "completedAt"),
    createdAt: requiredString(value, "createdAt"),
  };
}

function decodeApproval(wire: ApprovalWire): NativeApproval {
  const ok =
    validText(wire.id, 256) &&
    validText(wire.surface, 80) &&
    validText(wire.sessionId, 256) &&
    validText(wire.connectorId, 200) &&
    validText(wire.connectorLabel, 300) &&
    validText(wire.toolName, 300) &&
    validText(wire.action, 300) &&
    validText(wire.preview, 8 * 1024) &&
    validText(wire.receiptDigest, 200) &&
    parseDate(wire.expiresAt) &&
    parseDate(wire.createdAt) &&
    Object.keys(wire.detail).length <= 100;
  if (!ok) throw new NativeMalformedResponse("invalid approval");
  if (wire.conversationId !== undefined && !validText(wire.conversationId, 256)) throw new NativeMalformedResponse("approval conversation");
  if (wire.decidedAt !== undefined && !parseDate(wire.decidedAt)) throw new NativeMalformedResponse("approval decidedAt");
  if (wire.completedAt !== undefined && !parseDate(wire.completedAt)) throw new NativeMalformedResponse("approval completedAt");
  return {
    id: wire.id,
    status: wire.status,
    riskClass: wire.riskClass,
    preview: wire.preview,
    connectorLabel: wire.connectorLabel,
    toolName: wire.toolName,
    action: wire.action,
  };
}

// ── decodeEvent ──────────────────────────────────────────────────────────────

/** One event payload, decoded as native decodes it. Throws exactly where Swift throws. */
export function decodeNativeEvent(payload: Uint8Array | string): NativeServerEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload));
  } catch {
    throw new NativeMalformedResponse("not JSON");
  }
  if (!isObject(raw as Json)) throw new NativeMalformedResponse("not an object");
  const envelope = raw as JsonObject;

  // EventEnvelopeWire.init(from:), in its own order.
  const type = requiredString(envelope, "type");
  const conversationId = optionalString(envelope, "conversationId");
  const userMessageId = optionalString(envelope, "userMessageId");
  const title = optionalString(envelope, "title");
  const generationId = optionalString(envelope, "generationId");
  const text = optionalString(envelope, "text");
  const stage = optionalString(envelope, "stage");
  const pct = optionalDouble(envelope, "pct");
  const sources = sourceList(envelope.sources);
  const message = attempt(() => (envelope.message === undefined || envelope.message === null ? undefined : messageWire(envelope.message)));
  const messageText = attempt(() => optionalString(envelope, "message"));
  const event = attempt(() => (envelope.event === undefined || envelope.event === null ? undefined : activityWire(envelope.event)));
  const approval = attempt(() => (envelope.approval === undefined || envelope.approval === null ? undefined : approvalWire(envelope.approval)));
  const error = optionalString(envelope, "error");
  const finishReason = optionalString(envelope, "finishReason");

  switch (type) {
    case "meta":
      if (!conversationId || title === undefined || !validText(conversationId, 256) || !validText(title, 1_000)) {
        throw new NativeMalformedResponse("meta");
      }
      return { kind: "metadata", conversationId, userMessageId, title, generationId };
    case "title":
      if (!conversationId || title === undefined || !validText(conversationId, 256) || !validText(title, 1_000)) {
        throw new NativeMalformedResponse("title");
      }
      return { kind: "title", conversationId, title };
    case "delta":
      if (text === undefined || utf8Length(text) > 64 * 1024) throw new NativeMalformedResponse("delta");
      return { kind: "textDelta", text };
    case "reasoning":
      if (text === undefined || utf8Length(text) > 64 * 1024) throw new NativeMalformedResponse("reasoning");
      return { kind: "reasoningDelta", text };
    case "sources":
      if (!sources || sources.length > 100) throw new NativeMalformedResponse("sources");
      return { kind: "sources", sources: sources.map(decodeSource) };
    case "done":
      if (
        !message ||
        !validText(message.id, 256) ||
        message.role !== "ASSISTANT" ||
        utf8Length(message.content) > 4 * 1024 * 1024 ||
        !parseDate(message.createdAt)
      ) {
        throw new NativeMalformedResponse("done");
      }
      return {
        kind: "completed",
        id: message.id,
        content: message.content,
        reasoning: message.reasoning,
        finishReason: finishReason ?? message.finishReason ?? "unknown",
        sources: (message.sources ?? sources ?? []).map(decodeSource),
      };
    case "error": {
      const text = messageText ?? error;
      if (text === undefined || !validText(text, 32 * 1024)) throw new NativeMalformedResponse("error");
      return { kind: "failed", message: text, finishReason: finishReason ?? "error" };
    }
    case "activity":
      if (!event) return { kind: "ping" };
      return { kind: "activity", id: event.id, activityKind: event.kind, title: event.title, detail: event.detail, url: event.url };
    case "approval":
      if (!approval) throw new NativeMalformedResponse("approval");
      return { kind: "approval", approval: decodeApproval(approval) };
    case "progress":
      return { kind: "mediaProgress", stage: stage ?? "generating", ...(pct === undefined ? {} : { pct }) };
    case "ping":
      return { kind: "ping" };
    default:
      throw new NativeMalformedResponse(`unknown frame type "${type}"`);
  }
}

/** A whole stream's bytes, framed and decoded as native would; throws at the first event it refuses. */
export function decodeNativeStream(bytes: Uint8Array): NativeServerEvent[] {
  return parseNativeSse(bytes).map((payload) => decodeNativeEvent(payload));
}
