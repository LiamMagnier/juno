import type { getCurrentUser } from "@/lib/session";

/*
 * Shared types for the chat turn pipeline (docs/rework/program/ORCHESTRATION.md).
 *
 * Every pipeline stage returns either its resolution or the `Response` that
 * ends the request. The orchestrator in src/app/api/chat/route.ts checks
 * `instanceof Response` after each stage, so a refusal can never be mistaken
 * for a value and a stage can never "half refuse".
 */

/** The signed-in user a turn runs as. */
export type TurnUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** A stage's result: its value, or the response that ends the request. */
export type StageResult<T> = T | Response;

export function isRefusal<T>(result: StageResult<T>): result is Response {
  return result instanceof Response;
}
