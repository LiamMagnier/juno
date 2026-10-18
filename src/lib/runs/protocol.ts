import { z } from "zod";

/**
 * The wire shapes of `/api/runs/stop` and `/api/runs/approval`. Kept apart
 * from the routes so the tests and any other client read the same schema.
 */
const identifier = z.string().trim().min(1).max(200);

export const liveRunRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), deviceId: identifier, sessionId: identifier }),
  z.object({ kind: z.literal("work"), runId: identifier }),
]);

export const runStopSchema = z.object({ run: liveRunRefSchema });

export const runApprovalSchema = z.object({
  run: liveRunRefSchema,
  approvalId: identifier,
  approve: z.boolean(),
  // Work only, where it is required and checked by the decision route.
  actionDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
