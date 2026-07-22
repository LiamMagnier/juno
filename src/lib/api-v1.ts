import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { NativeAuthError } from "@/lib/native-auth";

export const CONTRACT_VERSION = "1.2.0";

export class ApiV1Error extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiV1Error";
  }
}

export function apiV1Json(body: unknown, init: ResponseInit = {}, requestId = `req_${randomUUID()}`) {
  const headers = new Headers(init.headers);
  headers.set("X-Juno-Request-Id", requestId);
  headers.set("X-Juno-Contract-Version", CONTRACT_VERSION);
  return NextResponse.json(body, { ...init, headers });
}

export function apiV1Error(error: unknown, requestId = `req_${randomUUID()}`) {
  let code = "server_unavailable";
  let message = "Juno could not complete this request.";
  let status = 500;
  let retryable = true;
  if (error instanceof NativeAuthError) {
    ({ code, message, status } = error);
    retryable = false;
  } else if (error instanceof ApiV1Error) {
    ({ code, message, status, retryable } = error);
  } else if (error instanceof ZodError) {
    code = "invalid_request";
    message = "The request body is invalid.";
    status = 400;
    retryable = false;
  }
  return apiV1Json({
    error: { code, message, requestId, retryable, retryAfterMs: null,
      ...(error instanceof ApiV1Error && error.details ? { details: error.details } : {}) },
  }, { status }, requestId);
}
