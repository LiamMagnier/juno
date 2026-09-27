import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import {
  accountBackgroundProvider,
  loadBackgroundProviderPolicy,
  runUtilityPrompt,
} from "@/lib/memory";
import {
  hireDraftReply,
  hireDraftSystemPrompt,
  hireDraftUserMessage,
  parseHireDraft,
  parseHireDraftReply,
  type HireDraftFields,
  type HireDraftResult,
} from "@/lib/agents/hire-draft";
import { AGENT_STYLES } from "@/lib/agents/domain";
import { AGENT_EYES, AGENT_MARKS, AGENT_SHAPES, AGENT_TONES } from "@/lib/agents/avatar";
import { WORK_PERMISSION_POLICIES } from "@/lib/work/domain";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * One turn of the hire conversation (docs/design/AGENTS.md §5.1, talk-first).
 *
 * The person's free text becomes a structured draft. The model does the
 * writing; the deterministic parser is the floor when it cannot be reached, so
 * "call her Quill" still amends the name even if the provider is down. Billing
 * and provider privacy match every other background utility call.
 */

const avatarSchema = z
  .object({
    shape: z.enum(AGENT_SHAPES),
    tone: z.enum(AGENT_TONES),
    eyes: z.enum(AGENT_EYES),
    mark: z.enum(AGENT_MARKS),
  })
  .nullable()
  .optional();

const draftSchema = z.object({
  name: z.string().max(40).nullable().optional(),
  role: z.string().max(80).nullable().optional(),
  style: z.enum(AGENT_STYLES).nullable().optional(),
  avatar: avatarSchema,
  instructions: z.string().max(6_000).nullable().optional(),
  approvalMode: z.enum(WORK_PERMISSION_POLICIES).nullable().optional(),
  connectorIds: z.array(z.string().min(1).max(120)).max(32).nullable().optional(),
  firstGoal: z.string().max(140).nullable().optional(),
  template: z.string().max(40).nullable().optional(),
});

const requestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  draft: draftSchema.default({}),
  turns: z
    .array(
      z.object({
        role: z.enum(["user", "juno"]),
        content: z.string().max(2_000),
      })
    )
    .max(12)
    .default([]),
});

function toDraft(value: z.infer<typeof draftSchema>): HireDraftFields {
  return {
    name: value.name?.trim() || null,
    role: value.role?.trim() || null,
    style: value.style ?? null,
    avatar: value.avatar ?? null,
    instructions: value.instructions?.trim() || null,
    approvalMode: value.approvalMode ?? null,
    connectorIds: value.connectorIds ?? null,
    firstGoal: value.firstGoal?.trim() || null,
    template: value.template?.trim() || null,
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A hire conversation is a handful of turns. A burst is a script.
  const limit = await rateLimit({ key: `agents:hire-draft:${user.id}`, limit: 40, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "That is a lot of draft updates at once. Try again in a little while." },
      { status: 429 }
    );
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That message could not be read." }, { status: 400 });
  }

  const draft = toDraft(parsed.data.draft);
  const message = parsed.data.message;
  // The floor first: the conversation always has something to show.
  const local = parseHireDraft(message, draft);
  const fallback: HireDraftResult = {
    draft: local.draft,
    changed: local.changed,
    reply: hireDraftReply(local.draft, local.changed),
  };

  try {
    const [policy, conversationProvider] = await Promise.all([
      loadBackgroundProviderPolicy(user.id),
      accountBackgroundProvider(user.id),
    ]);
    const { result, deniedByPolicy } = await runUtilityPrompt<HireDraftResult | null>({
      system: hireDraftSystemPrompt(),
      userMsg: hireDraftUserMessage({
        message,
        draft,
        turns: parsed.data.turns,
      }),
      maxTokens: 1_200,
      label: "agent-hire-draft",
      userId: user.id,
      parse: (text) => parseHireDraftReply(text, { message, draft }),
      policy,
      conversationProvider,
    });

    if (result) return NextResponse.json(result);
    if (deniedByPolicy) return NextResponse.json(fallback);
    return NextResponse.json(fallback);
  } catch (err) {
    console.error("[hire-draft] generation failed", { err });
    return NextResponse.json(fallback);
  }
}
