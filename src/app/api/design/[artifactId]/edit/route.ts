import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import type { Plan } from "@prisma/client";
import { PLANS, canUseModel } from "@/lib/plans";
import { getUserPlan } from "@/lib/usage";
import { providerErrorMessage, streamChat } from "@/lib/llm";
import { isAutoModelId } from "@/lib/auto-model";
import { DEFAULT_MODEL, getModel, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { buildDesignEditPrompt, DesignAiError, parseDesignProposal, previewProposal } from "@/lib/design/ai";
import { buildSelectionContext } from "@/lib/design/selection-context";
import { documentFromArtifact, loadOwnedDesignArtifact } from "@/lib/design/store";
import { DesignValidationError } from "@/lib/design/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  /**
   * Which layers the request was made from, and which page they live on.
   *
   * Deliberately ids, not the selection payload the client already built: the
   * context the model is shown is rebuilt here from the stored document, so a
   * client cannot describe the scene as something it is not and talk the model
   * into operating on that description. The ids are the only part a client is
   * entitled to assert, and `previewProposal` re-checks even those by refusing
   * a transaction that strays outside them.
   */
  pageId: z.string().min(1).max(120).optional(),
  selectedNodeIds: z.array(z.string().min(1).max(120)).max(200).default([]),
  /**
   * The revision the editor is showing. A mismatch means a local edit has not
   * landed yet, and the preview this route returns would be computed against a
   * scene the user is no longer looking at.
   */
  baseRevision: z.number().int().min(0),
});

/** The model gets one reply, and it is a JSON operation block — not an essay.
 *  60 operations is the schema's own ceiling; this budget covers it with room
 *  for the summary and adjustments. */
const MAX_OUTPUT_TOKENS = 8_000;

/**
 * Which model edits a design.
 *
 * The conversation that owns the artifact already records the model the user
 * chose, so a design edit runs on the same model their chat does rather than on
 * a second, invisible choice. Auto and models their plan cannot reach fall back
 * to the default; a design edit is a foreground request the user is waiting on,
 * so it never drops to the cheap utility walk that titles and follow-ups use —
 * the operation vocabulary is far too large for those models to hold.
 */
function pickEditModel(plan: Plan, requested: string | null): ModelInfo | null {
  const eligible = (model: ModelInfo) =>
    model.modality === "chat" &&
    !model.comingSoon &&
    !isAutoModelId(model.id) &&
    isProviderConfigured(model.provider) &&
    canUseModel(plan, model.id);

  const chosen = requested && !isAutoModelId(requested) ? getModel(requested) : null;
  if (chosen && eligible(chosen)) return chosen;
  const fallback = getModel(DEFAULT_MODEL);
  if (fallback && eligible(fallback)) return fallback;
  return MODEL_LIST.find(eligible) ?? null;
}

/**
 * Ask Juno for a change to a design, and return it as a *preview*.
 *
 * Nothing here writes. The model returns operations, the operation layer
 * validates them, `previewProposal` applies them to a clone and refuses the
 * whole transaction if a scoped request touched anything outside the selection.
 * What comes back is a transaction the editor can draw on the canvas and throw
 * away; committing it is a second, deliberate act by the user through the
 * ordinary transaction endpoint.
 *
 * Every failure mode is a named `code` rather than a 500, because each one has
 * a different sentence for the person waiting: the model wrote no block, it
 * wrote an operation the schema rejects, it reached outside the selection, or
 * the document moved while it was thinking.
 */
export async function POST(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].canvas) {
    return NextResponse.json({ error: "Your plan does not include the canvas." }, { status: 403 });
  }

  // One generation per request and no streaming, so a held-down key or a stuck
  // client cannot fan out into a queue of full-size model calls.
  const limit = await rateLimit({ key: `design-edit:${user.id}`, limit: 20, windowSec: 60 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many design requests. Give it a moment.", code: "rate-limited" }, { status: 429 });
  }

  const { artifactId } = await params;
  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { prompt, selectedNodeIds, baseRevision } = parsed.data;

  let document;
  try {
    document = documentFromArtifact(artifact);
  } catch (error) {
    if (error instanceof DesignValidationError) {
      return NextResponse.json({ error: error.message, code: "unreadable" }, { status: 422 });
    }
    throw error;
  }

  if (document.revision !== baseRevision) {
    return NextResponse.json(
      {
        error: "Your last change is still saving. Try again in a second.",
        code: "conflict",
        revision: document.revision,
      },
      { status: 409 }
    );
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: artifact.conversationId },
    select: { model: true },
  });
  const model = pickEditModel(plan, conversation?.model ?? null);
  if (!model) {
    return NextResponse.json(
      { error: "No AI model is available for your plan.", code: "no-model" },
      { status: 503 }
    );
  }

  const pageId = parsed.data.pageId ?? document.pages[0].id;
  const live = selectedNodeIds.filter((id) => !!document.nodes[id]);
  const scoped = live.length > 0;
  // The image is what the selection context costs most to build and Juno cannot
  // see it here — the design prompt is text, and `buildDesignEditPrompt` does
  // not forward it. Building it anyway would render an SVG per request for
  // nothing.
  const selection = scoped ? buildSelectionContext(document, pageId, live, { includeImage: false }) : null;

  const system = buildDesignEditPrompt(
    { identifier: artifact.identifier, title: artifact.title, version: artifact.currentVersion },
    document,
    selection,
    { scoped }
  );

  let raw = "";
  try {
    for await (const event of streamChat({
      model,
      system,
      history: [{ role: "USER", content: prompt, attachments: [] }],
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: req.signal,
    })) {
      if (event.type === "text") raw += event.text;
    }
  } catch (error) {
    if (req.signal.aborted) return NextResponse.json({ error: "Cancelled.", code: "aborted" }, { status: 499 });
    console.error("[design:edit] generation failed", { artifactId, model: model.id, error });
    return NextResponse.json({ error: providerErrorMessage(error, model.name), code: "provider" }, { status: 502 });
  }

  try {
    const proposal = parseDesignProposal(raw);
    const previewed = previewProposal(document, proposal, {
      transactionId: `juno-${artifact.id}-${Date.now().toString(36)}`,
      now: new Date().toISOString(),
      scopeTo: scoped ? live : null,
    });

    return NextResponse.json({
      transaction: previewed.transaction,
      // The whole proposed document, so the canvas draws exactly the scene this
      // route validated instead of one the client re-derived. Applying still
      // replays the operations against the live document, so this is only ever
      // what the user *looks* at while deciding.
      preview: previewed.result.document,
      touchedNodeIds: previewed.result.touchedNodeIds,
      selection: previewed.result.selection,
      summaries: previewed.result.summaries,
      inverse: previewed.result.inverse,
      changes: previewed.changes,
      adjustments: proposal.adjustments ?? [],
      note: proposal.note ?? null,
      model: model.name,
    });
  } catch (error) {
    if (error instanceof DesignAiError) {
      // A refusal is the system working: the model wrote something the document
      // model will not accept, and the user is told which, in a sentence they
      // can act on. 422 rather than 500 — nothing is broken.
      return NextResponse.json({ error: error.message, code: "unusable" }, { status: 422 });
    }
    throw error;
  }
}
