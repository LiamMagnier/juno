import { NextResponse, after } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan, consumeMessage, refundMessage } from "@/lib/usage";
import { canUseModel, PLANS } from "@/lib/plans";
import { isModelId, getModel, DEFAULT_MODEL, MAX_OUTPUT_TOKENS, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured, configuredProviders, PROVIDERS } from "@/lib/providers";
import { isOwnerEmail } from "@/lib/owner";
import { buildSystemPrompt } from "@/lib/anthropic";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import { getMemoryProfile, saveAutoMemories, autoExtractMemories, maybeConsolidate } from "@/lib/memory";
import { persistArtifacts } from "@/lib/artifacts-store";
import { parseArtifacts, parseMemories } from "@/lib/message-content";
import { serializeMessage } from "@/lib/serializers";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";
import { truncate } from "@/lib/utils";
import type { StreamChunk, ClientSource, ClientActivityEvent } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

const HISTORY_LIMIT = 24;

const WEB_SEARCH_NUDGE =
  "Web search is ENABLED for this message. You have a live web search tool that returns current, real-world results with citations — use it to answer with up-to-date information and cite your sources. Do NOT claim you lack internet access, real-time data, or the ability to browse; you can search right now.";

const bodySchema = z.object({
  conversationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  message: z.string().max(50_000).optional(),
  attachmentIds: z.array(z.string().cuid()).max(10).optional(),
  model: z.string().optional(),
  regenerate: z.boolean().optional(),
  voiceMode: z.boolean().optional(),
  canvasEnabled: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  privateMode: z.boolean().optional(),
  privateHistory: z
    .array(
      z.object({
        role: z.enum(["USER", "ASSISTANT"]),
        content: z.string().max(50_000),
      })
    )
    .max(HISTORY_LIMIT)
    .optional(),
});

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function searchToolLabel(provider: ModelInfo["provider"]) {
  if (provider === "anthropic") return "Claude web search";
  if (provider === "google") return "Google Search grounding";
  if (provider === "xai") return "Grok Live Search";
  return "native web search";
}

function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "You're sending messages too quickly. Please slow down." }, { status: 429 });
    }
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const input = parsed.data;

  if (!input.regenerate && !input.message?.trim() && (input.attachmentIds?.length ?? 0) === 0) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }

  const plan = await getUserPlan(user.id);

  // Resolve the model: requested → user default → app default, then ensure the
  // provider is configured and the plan allows it, falling back if not.
  const settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  const requestedId =
    input.model && isModelId(input.model)
      ? input.model
      : settings?.defaultModel && isModelId(settings.defaultModel)
        ? settings.defaultModel
        : DEFAULT_MODEL;

  let modelInfo: ModelInfo | undefined = getModel(requestedId);
  if (!modelInfo || !isProviderConfigured(modelInfo.provider) || !canUseModel(plan, modelInfo.id)) {
    // Fallback must stay plan-aware: only pick a configured model the plan allows.
    modelInfo = MODEL_LIST.find((m) => isProviderConfigured(m.provider) && canUseModel(plan, m.id));
  }
  if (!modelInfo) {
    const msg =
      configuredProviders().length === 0
        ? "No AI model providers are configured. Add at least one provider API key (e.g. ANTHROPIC_API_KEY)."
        : "No AI model is available for your plan. Upgrade, or configure a provider with a model your plan allows.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
  const modelId = modelInfo.id;

  if (input.privateMode) {
    if (input.regenerate) return NextResponse.json({ error: "Regenerate is not available in private chat." }, { status: 400 });

    const privateHistory: MessageForModel[] = (input.privateHistory ?? [])
      .filter((m) => m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content.trim(), attachments: [] }));

    const consumed = await consumeMessage(user.id, plan);
    if (!consumed.allowed) {
      return NextResponse.json(
        { error: "You've reached your monthly message limit. Upgrade your plan to keep chatting.", code: "QUOTA_EXCEEDED" },
        { status: 402 }
      );
    }

    const useWebSearch = !!input.webSearch && PLANS[plan].webSearch && modelInfo.webSearch;
    const baseSystem = buildSystemPrompt({
      userName: user.name,
      customInstructions: settings?.customInstructions ?? "",
      responseLanguage: settings?.responseLanguage ?? "auto",
      memories: [],
      memoryEnabled: false,
      canvas: false,
      voiceMode: input.voiceMode,
      projectContext: "",
    });
    const system = useWebSearch ? `${baseSystem}\n\n${WEB_SEARCH_NUDGE}` : baseSystem;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: StreamChunk) => controller.enqueue(encodeChunk(chunk));
        const activityLog: ClientActivityEvent[] = [];
        const sourceUrls = new Set<string>();
        let activityCounter = 0;
        let full = "";
        let reasoning = "";
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let writingStarted = false;
        const webSources: ClientSource[] = [];

        const sendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => {
          const entry: ClientActivityEvent = {
            ...event,
            id: `activity-${Date.now()}-${activityCounter++}`,
            createdAt: new Date().toISOString(),
          };
          activityLog.push(entry);
          send({ type: "activity", event: entry });
          return entry;
        };

        send({ type: "meta", conversationId: "private", userMessageId: null, title: "Private chat" });
        sendActivity({
          kind: "context",
          title: "Reading private context",
          detail: `${plural(privateHistory.length, "message")} · not stored`,
        });
        sendActivity({
          kind: "model",
          title: "Selected model",
          detail: `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
        });
        if (modelInfo.reasoning && input.reasoningEffort) {
          sendActivity({
            kind: "reasoning",
            title: "Reasoning mode enabled",
            detail: `${input.reasoningEffort[0].toUpperCase()}${input.reasoningEffort.slice(1)} effort`,
          });
        }
        if (useWebSearch) {
          sendActivity({
            kind: "search",
            title: "Preparing web search",
            detail: searchToolLabel(modelInfo.provider),
          });
        } else if (input.webSearch) {
          sendActivity({
            kind: "warning",
            title: "Web search was skipped",
            detail: "This plan or model cannot use native web search.",
          });
        }

        try {
          for await (const ev of streamChat({
            model: modelInfo,
            system,
            history: privateHistory,
            maxTokens: MAX_OUTPUT_TOKENS,
            signal: req.signal,
            reasoningEffort: modelInfo.reasoning ? input.reasoningEffort : undefined,
            webSearch: useWebSearch,
          })) {
            if (ev.type === "text") {
              if (!writingStarted) {
                writingStarted = true;
                sendActivity({ kind: "write", title: "Writing the private answer", detail: "Streaming response text" });
              }
              full += ev.text;
              send({ type: "delta", text: ev.text });
            } else if (ev.type === "reasoning") {
              reasoning += ev.text;
              send({ type: "reasoning", text: ev.text });
            } else if (ev.type === "sources") {
              for (const source of ev.sources) {
                if (!source.url || sourceUrls.has(source.url)) continue;
                sourceUrls.add(source.url);
                webSources.push(source);
                sendActivity({
                  kind: "visit",
                  title: "Visited source",
                  detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                  url: source.url,
                });
              }
              if (webSources.length) send({ type: "sources", sources: webSources });
            } else if (ev.type === "usage") {
              if (ev.input != null) promptTokens = ev.input;
              if (ev.output != null) completionTokens = ev.output;
            }
          }

          if (promptTokens != null || completionTokens != null) {
            sendActivity({
              kind: "usage",
              title: "Token usage recorded",
              detail: [
                promptTokens != null ? `${promptTokens.toLocaleString()} input` : null,
                completionTokens != null ? `${completionTokens.toLocaleString()} output` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            });
          }
          sendActivity({
            kind: "done",
            title: "Finished private response",
            detail: webSources.length ? plural(webSources.length, "source") : "Not saved",
          });

          send({
            type: "done",
            message: {
              id: `private-${Date.now()}`,
              role: "ASSISTANT",
              content: full,
              reasoning: reasoning || undefined,
              model: modelId,
              feedback: null,
              createdAt: new Date().toISOString(),
              attachments: [],
              sources: webSources.length ? webSources : undefined,
              activity: activityLog,
            },
            artifacts: [],
            memoryUpdated: false,
            quota: consumed.quota,
          });
        } catch (err) {
          console.error("[chat] private generation error", err);
          const quota = await refundMessage(user.id, plan).catch(() => consumed.quota);
          sendActivity({
            kind: "warning",
            title: "Generation failed",
            detail: providerErrorMessage(err, PROVIDERS[modelInfo.provider].label),
          });
          send({ type: "error", message: providerErrorMessage(err, PROVIDERS[modelInfo.provider].label), quota });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Load or create the conversation (ownership enforced).
  let conversation = input.conversationId
    ? await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: user.id } })
    : null;
  if (input.conversationId && !conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  if (!conversation) {
    // If starting a chat inside a project, attach it (ownership-checked).
    let projectId: string | null = null;
    if (input.projectId) {
      const proj = await prisma.project.findFirst({ where: { id: input.projectId, userId: user.id }, select: { id: true } });
      projectId = proj?.id ?? null;
    }
    conversation = await prisma.conversation.create({
      data: { userId: user.id, model: modelId, title: truncate(input.message ?? "New chat", 48), projectId },
    });
  }

  let userMessageId: string | null = null;
  let staleAssistantId: string | null = null;

  if (input.regenerate) {
    // Identify the trailing assistant message to replace — but DON'T delete it yet.
    // We only delete it once the new answer streams successfully, so a failed
    // generation never destroys the user's previous good answer.
    const last = await prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
    });
    if (last?.role === "ASSISTANT") staleAssistantId = last.id;
  } else {
    // Append the user's message and link any pre-uploaded attachments.
    const created = await prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: input.message?.trim() ?? "" },
    });
    userMessageId = created.id;

    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await prisma.attachment.updateMany({
        where: { id: { in: input.attachmentIds }, userId: user.id, messageId: null },
        data: { messageId: created.id, conversationId: conversation.id },
      });
    }
  }

  // Enforce the monthly quota (counts every generation).
  const consumed = await consumeMessage(user.id, plan);
  if (!consumed.allowed) {
    if (userMessageId) await prisma.message.delete({ where: { id: userMessageId } }).catch(() => {});
    return NextResponse.json(
      { error: "You've reached your monthly message limit. Upgrade your plan to keep chatting.", code: "QUOTA_EXCEEDED" },
      { status: 402 }
    );
  }

  // Build context from the most recent messages, excluding the answer being regenerated.
  const recent = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    include: { attachments: true },
    take: HISTORY_LIMIT,
  });
  const history = recent.reverse().filter((m) => m.id !== staleAssistantId);

  const memoryEnabled = settings?.memoryEnabled ?? true;
  // Prefer the consolidated summary (deduped, sectioned); fall back to the raw
  // list when no summary exists yet. `recent` holds entries newer than the summary.
  const memoryProfile = memoryEnabled ? await getMemoryProfile(user.id) : { summary: null, recent: [] };

  // Project context: instructions + reference file contents injected into the system prompt.
  let projectContext = "";
  if (conversation.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: conversation.projectId },
      select: { name: true, instructions: true, files: { select: { fileName: true, extractedText: true } } },
    });
    if (project) {
      const sections = [`# Project: ${project.name}`];
      if (project.instructions.trim()) sections.push(`## Project instructions\n${project.instructions.trim()}`);
      const fileTexts = project.files.filter((f) => f.extractedText?.trim());
      if (fileTexts.length) {
        sections.push("## Project reference files");
        for (const f of fileTexts) sections.push(`### ${f.fileName}\n${f.extractedText!.slice(0, 50_000)}`);
      }
      projectContext = sections.join("\n\n");
    }
  }

  // Native web search: the model searches via its own tool/grounding while it
  // streams (Gemini Google Search, Claude web_search, Grok Live Search). We
  // collect the sources it returns from the stream below — no third-party search.
  const useWebSearch = !!input.webSearch && PLANS[plan].webSearch && modelInfo.webSearch;
  let webSources: ClientSource[] = [];

  const baseSystem = buildSystemPrompt({
    userName: user.name,
    customInstructions: settings?.customInstructions ?? "",
    responseLanguage: settings?.responseLanguage ?? "auto",
    memories: memoryProfile.recent,
    memorySummary: memoryProfile.summary ?? undefined,
    memoryEnabled,
    canvas: !input.voiceMode && (input.canvasEnabled ?? true),
    voiceMode: input.voiceMode,
    projectContext,
  });
  const system = useWebSearch ? `${baseSystem}\n\n${WEB_SEARCH_NUDGE}` : baseSystem;
  const conversationId = conversation.id;
  const convoTitle = conversation.title;
  let assistantFull = ""; // captured for background memory extraction

  // Generation + persistence, detached from the request lifecycle: we deliberately
  // do NOT pass req.signal to the model, so if the user navigates away mid-stream
  // the answer keeps generating and is still saved for when they come back.
  const generate = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      // Once the client disconnects the controller is closed; swallow the enqueue
      // error so generation and persistence keep running regardless.
      const send = (chunk: StreamChunk) => {
        try {
          controller.enqueue(encodeChunk(chunk));
        } catch {
          /* client disconnected — keep going so the answer is still saved */
        }
      };
      const activityLog: ClientActivityEvent[] = [];
      const sourceUrls = new Set<string>();
      let activityCounter = 0;
      let full = "";
      let reasoning = "";
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let writingStarted = false;

      const sendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => {
        const entry: ClientActivityEvent = {
          ...event,
          id: `activity-${Date.now()}-${activityCounter++}`,
          createdAt: new Date().toISOString(),
        };
        activityLog.push(entry);
        send({ type: "activity", event: entry });
        return entry;
      };

      send({ type: "meta", conversationId, userMessageId, title: convoTitle });

      const attachmentCount = history.reduce((sum, msg) => sum + msg.attachments.length, 0);
      const contextDetails = [plural(history.length, "message")];
      if (attachmentCount) contextDetails.push(plural(attachmentCount, "attachment"));
      if (memoryEnabled && memoryProfile.recent.length)
        contextDetails.push(plural(memoryProfile.recent.length, "memory", "memories"));
      if (projectContext) contextDetails.push("project context");
      sendActivity({
        kind: "context",
        title: input.regenerate ? "Rebuilding the conversation context" : "Reading the conversation context",
        detail: contextDetails.join(" · "),
      });
      sendActivity({
        kind: "model",
        title: "Selected model",
        detail: `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
      });
      if (modelInfo.reasoning && input.reasoningEffort) {
        sendActivity({
          kind: "reasoning",
          title: "Reasoning mode enabled",
          detail: `${input.reasoningEffort[0].toUpperCase()}${input.reasoningEffort.slice(1)} effort`,
        });
      }
      if (useWebSearch) {
        sendActivity({
          kind: "search",
          title: "Preparing web search",
          detail: searchToolLabel(modelInfo.provider),
        });
      } else if (input.webSearch) {
        sendActivity({
          kind: "warning",
          title: "Web search was skipped",
          detail: "This plan or model cannot use native web search.",
        });
      }

      try {
        for await (const ev of streamChat({
          model: modelInfo,
          system,
          history,
          maxTokens: MAX_OUTPUT_TOKENS,
          // No signal here: keep generating even if the client disconnects mid-stream.
          reasoningEffort: modelInfo.reasoning ? input.reasoningEffort : undefined,
          webSearch: useWebSearch,
        })) {
          if (ev.type === "text") {
            if (!writingStarted) {
              writingStarted = true;
              sendActivity({ kind: "write", title: "Writing the answer", detail: "Streaming response text" });
            }
            full += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "reasoning") {
            reasoning += ev.text;
            send({ type: "reasoning", text: ev.text });
          } else if (ev.type === "sources") {
            for (const source of ev.sources) {
              if (!source.url || sourceUrls.has(source.url)) continue;
              sourceUrls.add(source.url);
              webSources.push(source);
              sendActivity({
                kind: "visit",
                title: "Visited source",
                detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                url: source.url,
              });
            }
            if (webSources.length) send({ type: "sources", sources: webSources });
          } else if (ev.type === "usage") {
            if (ev.input != null) promptTokens = ev.input;
            if (ev.output != null) completionTokens = ev.output;
          }
        }

        // Generation succeeded — now it's safe to drop the answer being regenerated
        // (and only the artifacts that message actually created).
        if (staleAssistantId) {
          await prisma.artifact.deleteMany({ where: { messageId: staleAssistantId } });
          await prisma.message.delete({ where: { id: staleAssistantId } }).catch(() => {});
        }

        // Persist the assistant message.
        const assistant = await prisma.message.create({
          data: {
            conversationId,
            role: "ASSISTANT",
            content: full,
            ...(reasoning ? { reasoning } : {}),
            model: modelId,
            promptTokens,
            completionTokens,
            ...(webSources.length ? { sources: webSources as unknown as Prisma.InputJsonValue } : {}),
            activity: activityLog as unknown as Prisma.InputJsonValue,
          },
          include: { attachments: true },
        });

        // Artifacts + memory side effects.
        const artifacts = await persistArtifacts(conversationId, assistant.id, parseArtifacts(full));
        let memoryUpdated = false;
        if (memoryEnabled) {
          const created = await saveAutoMemories(user.id, parseMemories(full));
          memoryUpdated = created > 0;
        }

        // Touch the conversation; set a title from the first exchange if still default.
        const firstUserText = history.find((m) => m.role === "USER")?.content;
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: new Date(),
            model: modelId,
            ...(convoTitle === "New chat" && firstUserText ? { title: truncate(firstUserText, 48) } : {}),
          },
        });

        if (promptTokens != null || completionTokens != null) {
          sendActivity({
            kind: "usage",
            title: "Token usage recorded",
            detail: [
              promptTokens != null ? `${promptTokens.toLocaleString()} input` : null,
              completionTokens != null ? `${completionTokens.toLocaleString()} output` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
        sendActivity({
          kind: "done",
          title: "Finished response",
          detail: webSources.length ? plural(webSources.length, "source") : undefined,
        });
        const assistantWithActivity = await prisma.message.update({
          where: { id: assistant.id },
          data: { activity: activityLog as unknown as Prisma.InputJsonValue },
          include: { attachments: true },
        });

        assistantFull = full;
        send({
          type: "done",
          message: await serializeMessage(assistantWithActivity),
          artifacts,
          memoryUpdated,
          quota: consumed.quota,
        });
      } catch (err) {
        console.error("[chat] generation error", err);
        // Generation failed: the user got nothing, so refund the consumed message
        // and report the corrected quota so the UI doesn't go stale.
        const quota = await refundMessage(user.id, plan).catch(() => consumed.quota);
        sendActivity({
          kind: "warning",
          title: "Generation failed",
          detail: providerErrorMessage(err, PROVIDERS[modelInfo.provider].label),
        });
        send({ type: "error", message: providerErrorMessage(err, PROVIDERS[modelInfo.provider].label), quota });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed because the client disconnected */
        }
      }
  };

  // Start generating as soon as the response body is read, and keep a handle so
  // we can await it (below) even after the client disconnects.
  let genPromise: Promise<void> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      genPromise = generate(controller);
    },
  });

  // `after` runs once the response is settled — including when the client
  // disconnects. Awaiting genPromise here keeps the serverless function alive
  // until the answer is fully generated and saved, so navigating away no longer
  // loses the reply. Then extract durable memories with a cheap model.
  const extractionModel = memoryEnabled
    ? MODEL_LIST.find((m) => isProviderConfigured(m.provider) && m.minPlan === "FREE") ??
      MODEL_LIST.find((m) => isProviderConfigured(m.provider))
    : undefined;
  after(async () => {
    await genPromise?.catch(() => {});
    if (extractionModel && assistantFull) {
      await autoExtractMemories({
        userId: user.id,
        model: extractionModel,
        history,
        assistantText: assistantFull,
        existing: [memoryProfile.summary ?? "", ...memoryProfile.recent].filter(Boolean),
      }).catch(() => {});
      // Periodically re-summarize so the memory stays tidy and deduped.
      await maybeConsolidate(user.id, extractionModel).catch(() => {});
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
