import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { getObjectBytes } from "@/lib/storage";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

let anthropic: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  // maxRetries handles transient 429/5xx/overloaded errors on the initial request.
  if (!anthropic) anthropic = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });
  return anthropic;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Large binary attachments (images / PDFs) are only re-embedded for the most
// recent slice of the conversation. Older ones become a lightweight text
// placeholder so a long chat doesn't re-upload megabytes — and blow the context
// window — on every turn. Extracted document text (cheap) is always kept.
const BINARY_ATTACHMENT_LOOKBACK = 8;

export interface SystemPromptOptions {
  userName?: string | null;
  customInstructions?: string;
  responseLanguage?: string;
  memories?: string[];
  /** Consolidated, deduped memory profile (Markdown). Preferred over `memories`. */
  memorySummary?: string;
  memoryEnabled: boolean;
  canvas: boolean;
  voiceMode?: boolean;
  /** Project name + instructions + reference files, injected when chatting in a project. */
  projectContext?: string;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const parts: string[] = [
    `You are Juno, a thoughtful, warm and capable AI assistant. You help with writing, analysis, coding, math, and creative work. Be clear, accurate and genuinely useful. Today is ${today}.`,
  ];

  if (opts.canvas) {
    parts.push(
      `# Canvas (artifacts)
When you produce substantial, self-contained content the user will want to keep, edit, or reuse — full code files, an HTML page, an SVG, a long document (>15 lines), or a Mermaid diagram — wrap it in an artifact tag instead of a normal code block:

<juno:artifact identifier="kebab-case-id" type="REACT|HTML|CODE|SVG|MARKDOWN|MERMAID" title="Human Title" language="tsx">
...the full content...
</juno:artifact>

Rules:
- Use a short stable "identifier". To revise an existing artifact, REUSE its identifier and output the complete updated content (a new version is saved automatically).
- "type": REACT for a React component (default export, no imports needed beyond react), HTML for a standalone page, SVG for vector graphics, MERMAID for diagrams, MARKDOWN for documents, CODE for any other code (set "language").
- Put a one-line explanation before the artifact. Do not repeat the artifact's content outside the tag.
- For small snippets or inline examples, use a normal Markdown code block, not an artifact.`
    );
  }

  if (opts.memoryEnabled) {
    parts.push(
      `# Memory
You remember things about the user across conversations. Whenever the user reveals a durable fact, preference, or goal worth recalling later — their name, role, location, the tools/languages/frameworks they use, ongoing projects, how they like answers, or anything they explicitly ask you to remember — save it by appending, at the very END of your reply, one or more tags:
<juno:memory>One concise, self-contained fact written in the third person.</juno:memory>
Save proactively, but only durable facts — not one-off task details — and never secrets (passwords, payment info) unless the user explicitly asks. Never mention the tag or that you saved something; the app shows a subtle "memory updated" note on its own. If you already know a fact (it appears below), don't save it again. Examples:
<juno:memory>The user is a frontend engineer who prefers TypeScript and concise, example-first answers.</juno:memory>
<juno:memory>The user is building a meal-planning app called Pantry.</juno:memory>`
    );
    if (opts.memorySummary && opts.memorySummary.trim()) {
      parts.push(`# What you already know about this user\n${opts.memorySummary.trim()}`);
      if (opts.memories && opts.memories.length > 0) {
        parts.push(`# Recent notes (newer than the summary)\n${opts.memories.map((m) => `- ${m}`).join("\n")}`);
      }
    } else if (opts.memories && opts.memories.length > 0) {
      parts.push(`# What you already remember about this user\n${opts.memories.map((m) => `- ${m}`).join("\n")}`);
    }
  }

  if (opts.projectContext && opts.projectContext.trim()) {
    parts.push(opts.projectContext.trim());
  }

  if (opts.customInstructions && opts.customInstructions.trim()) {
    parts.push(`# The user's custom instructions\n${opts.customInstructions.trim()}`);
  }

  if (opts.responseLanguage && opts.responseLanguage !== "auto") {
    parts.push(`# Language\nAlways respond in ${opts.responseLanguage}, regardless of the language of the question.`);
  }

  if (opts.voiceMode) {
    parts.push(
      `# Voice mode
Your reply will be read aloud. Keep it concise and conversational. Do not use Markdown, headings, bullet lists, code blocks, or artifacts. Avoid ellipses and symbols that sound awkward when spoken. Write the way you would speak.`
    );
  }

  return parts.join("\n\n");
}

/** Convert persisted messages (+ their attachments) into Anthropic message params. */
export async function toAnthropicMessages(messages: MessageForModel[]): Promise<Anthropic.MessageParam[]> {
  const result: Anthropic.MessageParam[] = [];
  // Only the last few messages re-embed heavy binaries; older ones are summarized.
  const binaryFrom = Math.max(0, messages.length - BINARY_ATTACHMENT_LOOKBACK);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "SYSTEM") continue;
    const role = msg.role === "ASSISTANT" ? "assistant" : "user";

    if (role === "assistant" || msg.attachments.length === 0) {
      result.push({ role, content: msg.content || "(no content)" });
      continue;
    }

    const embedBinary = i >= binaryFrom;

    // User message with attachments → multimodal content blocks.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });

    for (const att of msg.attachments) {
      try {
        if (att.kind === "IMAGE" && IMAGE_TYPES.includes(att.mimeType)) {
          if (!embedBinary) {
            blocks.push({ type: "text", text: `[Image "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: Buffer.from(bytes).toString("base64"),
              },
            });
          }
        } else if (att.mimeType === "application/pdf") {
          if (!embedBinary && att.extractedText) {
            blocks.push({ type: "text", text: `Attached file "${att.fileName}" (shared earlier):\n\n${att.extractedText.slice(0, 100_000)}` });
          } else if (!embedBinary) {
            blocks.push({ type: "text", text: `[PDF "${att.fileName}" shared earlier in the conversation.]` });
          } else {
            const { bytes } = await getObjectBytes(att.storageKey);
            blocks.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
            });
          }
        } else if (att.extractedText) {
          blocks.push({
            type: "text",
            text: `Attached file "${att.fileName}":\n\n${att.extractedText.slice(0, 100_000)}`,
          });
        } else {
          blocks.push({ type: "text", text: `[Attached file "${att.fileName}" (${att.mimeType}) — content not readable.]` });
        }
      } catch {
        blocks.push({ type: "text", text: `[Attachment "${att.fileName}" could not be loaded.]` });
      }
    }

    result.push({ role, content: blocks.length ? blocks : msg.content || "(no content)" });
  }

  return result;
}

/**
 * Add an Anthropic prompt-cache breakpoint to the last content block of the last
 * message. Combined with the cached system prompt, this caches the whole growing
 * conversation prefix: each turn reads the previous turn's cache (~0.1x input
 * cost) and only writes the delta — a large saving on long, expensive, or
 * high-thinking chats. Anthropic ignores the marker below its min-cacheable size.
 */
function markConversationCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  const cacheControl = { type: "ephemeral" as const };
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content || "(no content)", cache_control: cacheControl }];
    return;
  }
  const block = last.content[last.content.length - 1];
  // cache_control is honored on text/image/document blocks — exactly what we emit.
  if (block) (block as { cache_control?: typeof cacheControl }).cache_control = cacheControl;
}

/** Stream a completion from Anthropic, yielding text + usage events. */
export interface AnthropicMcpServer {
  type: "url";
  url: string;
  name: string;
  authorization_token: string;
}

export async function* streamAnthropic(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  mcpServers?: AnthropicMcpServer[]
): AsyncGenerator<LlmEvent> {
  const messages = await toAnthropicMessages(history);
  markConversationCacheBreakpoint(messages);
  // Cache the (large, stable) system prompt so it isn't re-billed every turn.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];
  const budget = reasoningEffort ? { low: 1024, medium: 4096, high: 8000, max: 12000 }[reasoningEffort] : 0;
  const useMcp = !!mcpServers && mcpServers.length > 0;
  const stream = await getAnthropic().messages.create(
    {
      model: model.providerModel,
      // max_tokens must exceed the thinking budget; keep room for the answer.
      max_tokens: budget ? budget + maxTokens : maxTokens,
      system: systemBlocks,
      messages,
      stream: true,
      ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      // Claude's native web search server tool — searches + cites inline.
      ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
      // Native MCP connector: Claude calls the linked servers (GitHub/Figma…) itself.
      ...(useMcp ? { mcp_servers: mcpServers } : {}),
    } as Anthropic.Messages.MessageCreateParamsStreaming,
    { signal, ...(useMcp ? { headers: { "anthropic-beta": "mcp-client-2025-04-04" } } : {}) }
  );
  const seen = new Set<string>();
  for await (const event of stream as AsyncIterable<Anthropic.RawMessageStreamEvent>) {
    if (event.type === "message_start") {
      const u = event.message.usage;
      yield {
        type: "usage",
        input: u?.input_tokens,
        cacheRead: u?.cache_read_input_tokens ?? undefined,
        cacheWrite: u?.cache_creation_input_tokens ?? undefined,
      };
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", text: event.delta.text };
    } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      yield { type: "reasoning", text: event.delta.thinking };
    } else if (event.type === "content_block_start" && (event.content_block as { type?: string }).type === "mcp_tool_use") {
      const block = event.content_block as { name?: string; server_name?: string };
      yield { type: "tool", server: block.server_name || "connector", name: block.name || "tool", phase: "call" };
    } else if (event.type === "content_block_start" && event.content_block.type === "web_search_tool_result") {
      const content = (event.content_block as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const sources = content
          .filter((c: { type?: string; url?: string }) => c?.type === "web_search_result" && c?.url && !seen.has(c.url))
          .map((c: { url: string; title?: string }) => {
            seen.add(c.url);
            return { title: c.title || c.url, url: c.url, snippet: "" };
          });
        if (sources.length) yield { type: "sources", sources };
      }
    } else if (event.type === "message_delta") {
      yield { type: "usage", output: event.usage?.output_tokens };
      const stopReason = (event.delta as { stop_reason?: string | null }).stop_reason;
      if (stopReason) yield { type: "finish", reason: normalizeFinishReason(stopReason), raw: stopReason };
    }
  }
}
