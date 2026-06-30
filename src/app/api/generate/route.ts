import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { resolveModel } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getUserPlan, consumeMessage, refundMessage } from "@/lib/usage";
import { planRank } from "@/lib/plans";
import { generateImage } from "@/lib/image-gen";
import { buildObjectKey, putObject } from "@/lib/storage";
import { serializeMessage } from "@/lib/serializers";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  conversationId: z.string().cuid().optional(),
  prompt: z.string().trim().min(1).max(4000),
  model: z.string(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { prompt, model: modelId } = parsed.data;

  const model = resolveModel(modelId);
  if (!model || model.modality === "chat") {
    return NextResponse.json({ error: "That model can't generate media." }, { status: 400 });
  }
  if (!isProviderConfigured(model.provider)) {
    return NextResponse.json({ error: `${model.name} isn't configured — add its API key.` }, { status: 400 });
  }

  const plan = await getUserPlan(user.id);
  if (planRank(plan) < planRank(model.minPlan)) {
    return NextResponse.json({ error: `${model.name} requires the ${model.minPlan} plan.` }, { status: 402 });
  }

  // Video generation is asynchronous (long-running operations) — not wired yet.
  if (model.modality === "video") {
    return NextResponse.json(
      { error: "Video generation is coming soon — it's on the roadmap. Try an image model for now." },
      { status: 400 }
    );
  }

  const rl = await rateLimit({ key: `generate:${user.id}`, limit: plan === "OWNER" ? 1000 : 30, windowSec: 3600 });
  if (!rl.success) return NextResponse.json({ error: "You're generating a lot — give it a minute." }, { status: 429 });

  // Verify / create the conversation up front (so we can fail fast with JSON).
  let conversationId = parsed.data.conversationId ?? null;
  let isNew = false;
  if (conversationId) {
    const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const quotaRes = await consumeMessage(user.id, plan);
  if (!quotaRes.allowed) {
    return NextResponse.json({ error: "You've reached your monthly limit.", quota: quotaRes.quota }, { status: 402 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: Parameters<typeof encodeChunk>[0]) => controller.enqueue(encodeChunk(chunk));
      try {
        if (!conversationId) {
          const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "New image";
          const convo = await prisma.conversation.create({
            data: { userId: user.id, title, model: model.id },
            select: { id: true, title: true },
          });
          conversationId = convo.id;
          isNew = true;
        }

        const userMsg = await prisma.message.create({
          data: { conversationId: conversationId!, role: "USER", content: prompt },
          select: { id: true },
        });

        const title = isNew ? prompt.replace(/\s+/g, " ").trim().slice(0, 60) : "";
        send({ type: "meta", conversationId: conversationId!, userMessageId: userMsg.id, title });

        // Generate + store the image.
        const img = await generateImage(model, prompt);
        const key = buildObjectKey(user.id, `juno-${model.providerModel}.${img.ext}`);
        await putObject(key, img.bytes, img.mimeType);

        const assistant = await prisma.message.create({
          data: {
            conversationId: conversationId!,
            role: "ASSISTANT",
            model: model.id,
            content: "",
            attachments: {
              create: {
                userId: user.id,
                conversationId: conversationId!,
                kind: "IMAGE",
                fileName: `${model.name} — ${title || "image"}.${img.ext}`.slice(0, 120),
                mimeType: img.mimeType,
                size: img.bytes.length,
                storageKey: key,
              },
            },
          },
          include: { attachments: true },
        });

        await prisma.conversation.update({ where: { id: conversationId! }, data: { lastMessageAt: new Date() } });

        const message = await serializeMessage(assistant);
        send({ type: "done", message, artifacts: [], memoryUpdated: false, quota: quotaRes.quota });
      } catch (err) {
        // The generation failed after metering — refund the message.
        const quota = await refundMessage(user.id, plan).catch(() => quotaRes.quota);
        const msg = err instanceof Error ? err.message : "Image generation failed.";
        send({ type: "error", message: msg, quota });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
