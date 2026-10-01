import { z } from "zod";

/** Input is a reader decision; a task token cannot answer its own gate. */
export const codeTaskInputSchema = z.union([
  z.object({ type: z.literal("question.answer"), requestId: z.string().min(1).max(200), answer: z.string().trim().min(1).max(32_000) }),
  z.object({ type: z.literal("plan.decide"), requestId: z.string().min(1).max(200), decision: z.enum(["approve", "reject"]), feedback: z.string().max(8000).optional() }),
  z.object({ type: z.literal("approval.decide").optional(), requestId: z.string().min(1).max(200), approve: z.boolean() }),
]);

export function codeTaskInputControl(input: z.infer<typeof codeTaskInputSchema>) {
  if (input.type === "question.answer") return { kind: "question_answer", payload: { requestId: input.requestId, answer: input.answer } };
  if (input.type === "plan.decide") return { kind: "plan_response", payload: { requestId: input.requestId, approve: input.decision === "approve", ...(input.feedback ? { feedback: input.feedback } : {}) } };
  return { kind: "approval_response", payload: { requestId: input.requestId, approve: input.approve } };
}
