/**
 * What a Juno tool call's audit row may hold of its arguments (SPEC §3.3
 * item 7).
 *
 * `ToolInvocation.args` is plain, unencrypted JSON, while message text is
 * encrypted at rest. A saved chat's `web_search` query, `calculate`
 * expression or `run_code` program is message content by another name, so the
 * row must never hold it raw: a database dump would otherwise hand over what
 * the encryption protects. The row keeps what an audit needs — which tool,
 * how many arguments, their shape — and each text value becomes a keyed hash
 * and a length. Equal values hash equally within a deployment (so repeated
 * calls can be correlated) and no value can be read back. A URL keeps only its
 * host, as the runner's egress audit does.
 *
 * What stays raw: numbers, booleans, and a string that is one of the members
 * the tool's own schema enumerates (`action: "read"`, `recency: "week"`),
 * which the tool defined and the user did not write.
 *
 * Pure apart from reading the auth secret; the secret can be injected.
 */

import { createHmac } from "node:crypto";

import { env } from "@/lib/env";
import type { PortableProperty, ToolSpec } from "@/lib/tools/types";

export type AuditValue =
  | number
  | boolean
  | null
  | string
  | { hmac: string; len: number }
  | { host: string; hmac: string; len: number }
  | { items: number }
  | AuditValue[];

export interface JunoToolAuditArgs {
  tool: string;
  /** How many arguments the call carried. */
  n: number;
  keys: Record<string, AuditValue>;
}

/** How many array items are kept (hashed) before the rest are only counted. */
const MAX_ARRAY_ITEMS = 20;
/** Argument keys past this are dropped: the model does not get to write a large row. Undeclared keys
 *  are only counted, under `_undeclared`. */
const MAX_KEYS = 32;

/** The keyed hash every Juno audit value goes through (the crypto.ts / connector-token.ts pattern). */
export function auditHmac(value: string, secret: string = env.authSecret): string {
  return createHmac("sha256", `juno:tool-audit:${secret}`).update(value).digest("base64url");
}

function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
}

function auditValue(value: unknown, property: PortableProperty | undefined, secret: string, depth: number): AuditValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (property?.type === "string" && property.enum?.includes(value)) return value;
    const host = hostOf(value);
    const hashed = { hmac: auditHmac(value, secret), len: value.length };
    return host ? { host, ...hashed } : hashed;
  }
  if (Array.isArray(value)) {
    if (depth > 2) return { items: value.length };
    const items = property?.type === "array" ? property.items : undefined;
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => auditValue(item, items, secret, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...kept, { items: value.length - MAX_ARRAY_ITEMS }] : kept;
  }
  // A nested object says nothing an audit needs that its size does not; its
  // values are hashed-only anyway, so only its key count is kept.
  if (typeof value === "object") return { items: Object.keys(value as Record<string, unknown>).length };
  return null;
}

/**
 * The audit row's `args` for one Juno tool call: `{ tool, n, keys }`, with
 * every free-text value hashed and every URL reduced to its host.
 */
export function auditArgsForJunoTool(
  spec: Pick<ToolSpec, "id" | "input">,
  args: Record<string, unknown>,
  opts: { secret?: string } = {},
): JunoToolAuditArgs {
  const secret = opts.secret ?? env.authSecret;
  const entries = Object.entries(args ?? {});
  const keys: Record<string, AuditValue> = {};
  let undeclared = 0;
  for (const [key, value] of entries.slice(0, MAX_KEYS)) {
    // A key name is model-written too: only the schema's own names are kept.
    if (!Object.prototype.hasOwnProperty.call(spec.input.properties, key)) {
      undeclared += 1;
      continue;
    }
    keys[key] = auditValue(value, spec.input.properties[key], secret, 0);
  }
  if (undeclared > 0) keys._undeclared = undeclared;
  return { tool: spec.id, n: entries.length, keys };
}
