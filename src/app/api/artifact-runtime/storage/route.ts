import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { isArtifactAiEnabled } from "@/lib/env";
import {
  STORAGE_MAX_KEY_CHARS,
  STORAGE_MAX_VALUE_BYTES,
  isRuntimeTarget,
  serializeStorageValue,
  type AlevrRuntimeTarget,
} from "@/lib/artifact-ai/protocol";
import { resolveRuntimeAccess } from "@/lib/artifact-ai/access";
import { artifactStorage, runtimeAccessDeps } from "@/lib/artifact-ai/server";
import { artifactStorageLimited } from "@/lib/artifact-ai/rate-limits";

export const runtime = "nodejs";

/*
 * POST /api/artifact-runtime/storage — `window.alevr.storage` from an
 * artifact's code (src/lib/artifact-ai/protocol.ts): one of get, set, delete
 * or list, on the store of (this artifact, the signed-in viewer).
 *
 * POST for reads too: every call is a cookie-authenticated request the CSRF
 * origin check covers (src/lib/csrf.ts guards mutating methods), and none of
 * them is a cacheable resource. The page that frames the artifact calls this
 * (bridge-host.ts); the frame has no session to call it with.
 *
 * A value travels as JSON (the body's `value`) and is kept as its JSON text,
 * encrypted (storage.ts). `get` answers with the value spliced back in as JSON,
 * so a 5 MB value is not parsed on the way out.
 */

/** A value at its cap plus the envelope (target, op, key). */
const MAX_BODY_BYTES = STORAGE_MAX_VALUE_BYTES + 16 * 1024;

const target = z.custom<AlevrRuntimeTarget>(isRuntimeTarget, "Unknown artifact.");
const key = z.string().min(1).max(STORAGE_MAX_KEY_CHARS);
const bodySchema = z.discriminatedUnion("op", [
  z.object({ target, op: z.literal("get"), key }),
  z.object({ target, op: z.literal("set"), key, value: z.unknown() }),
  z.object({ target, op: z.literal("delete"), key }),
  z.object({ target, op: z.literal("list"), prefix: z.string().max(STORAGE_MAX_KEY_CHARS).default("") }),
]);

function fail(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(req: Request) {
  // AI-powered artifacts are unreviewed and off unless ARTIFACT_AI_ENABLED=1
  // (src/lib/env.ts): nothing is read, stored or spent, whoever asks.
  if (!isArtifactAiEnabled()) {
    return NextResponse.json({ error: "AI-powered artifacts are not turned on for this server.", code: "not_enabled" }, { status: 404 });
  }
  const user = await getCurrentUser();
  if (!user) return fail(401, "sign_in_required", "Sign in to use this app's saved data. It is kept on your own account.");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return fail(413, "too_large", "This value is larger than 5 MB. Split it across several keys.");
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return fail(413, "too_large", "This value is larger than 5 MB. Split it across several keys.");
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  const body = parsed.data;

  const access = await resolveRuntimeAccess(user.id, body.target, runtimeAccessDeps);
  if (!access.ok) return fail(access.status, access.code, access.error);

  const limited = await artifactStorageLimited(user, body.op === "get" || body.op === "list" ? "read" : "write");
  if (limited) return limited;

  // The viewer's store for this artifact: never the owner's, on a shared link.
  const scope = { artifactId: access.artifactId, userId: access.viewerId };
  switch (body.op) {
    case "get": {
      const result = await artifactStorage.get(scope, body.key);
      if (!result.ok) return fail(result.status, result.code, result.error);
      const payload = result.valueJson === null ? `{"found":false,"value":null}` : `{"found":true,"value":${result.valueJson}}`;
      return new Response(payload, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
    case "set": {
      const serialized = serializeStorageValue(body.value);
      if (!serialized.ok) return fail(400, "invalid_request", serialized.message);
      const result = await artifactStorage.set(scope, body.key, serialized.json);
      if (!result.ok) return fail(result.status, result.code, result.error);
      return NextResponse.json({ ok: true, usedBytes: result.artifactBytes });
    }
    case "delete": {
      const result = await artifactStorage.delete(scope, body.key);
      if (!result.ok) return fail(result.status, result.code, result.error);
      return NextResponse.json({ ok: true, deleted: result.deleted });
    }
    case "list": {
      const result = await artifactStorage.list(scope, body.prefix);
      if (!result.ok) return fail(result.status, result.code, result.error);
      return NextResponse.json({ keys: result.keys }, { headers: { "Cache-Control": "no-store" } });
    }
  }
}
