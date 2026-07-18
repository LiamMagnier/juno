import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicThinkingBits } from "@/lib/anthropic-thinking";
import { env } from "@/lib/env";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { personalitySystemPrompt } from "@/lib/personalities";
import { getObjectBytes } from "@/lib/storage";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export {
  anthropicThinkingKind,
  buildAnthropicThinkingBits,
  type AnthropicThinkingKind,
} from "@/lib/anthropic-thinking";

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
  /** Response-style preset id (see lib/personalities); "default" injects nothing. */
  personality?: string;
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
  // Deliberately date-free: this string heads every provider's cached prefix,
  // so it must stay byte-identical across requests. The current date travels
  // in the per-request dynamic context instead (dateContext / dynamicContext).
  const parts: string[] = [
    `You are Juno, a thoughtful, warm and capable AI assistant. You help with writing, analysis, coding, math, and creative work. Be clear, accurate and genuinely useful.`,
  ];

  if (!opts.voiceMode) {
    parts.push(
      `# Pre-answer clarification
Do not include clarification cards, clarification wizards, or clarification blocks inside your final answer. The application handles any needed pre-answer clarification through a separate composer-attached UI before your response starts.

If you receive a prompt that includes pre-answer clarification answers, answer the original request directly using those answers. Do not repeat the clarification questions, do not ask the user to choose an option again, and do not say "before we begin" unless the user explicitly asks you to ask follow-up questions in the normal chat.

# Reply intent — decide this first
Before writing, classify what the user actually wants. This decides every formatting choice below:
- BUILD — they asked you to make, create, write, fix, or improve something they will USE: a website, app, component, script, document, email, design. Deliver the finished work itself, directly. Do not teach them how it works, do not compare approaches they didn't ask about, do not walk them through your process, and NEVER attach learning blocks (no quiz, no comparison, no process timeline, no step lab) to a build request. "Build me a portfolio site" wants a portfolio site, not a lesson about portfolio sites.
- UNDERSTAND — they asked you to explain, teach, or help them grasp a concept ("explain", "how does X work", "teach me", "what's the difference between"). This is the ONLY intent where the inline learning blocks below are allowed.
- ANSWER / CHAT — a question, a quick task, or conversation. Plain prose. No blocks.
When a message mixes intents ("build X and explain how it works"), deliver the build first, then explain in plain prose — still no learning blocks; they are reserved for pure UNDERSTAND requests.

# Inline visual learning blocks
For UNDERSTAND requests only, you can embed interactive learning blocks directly inside your chat reply. They are not artifacts, never open a side panel, and must read naturally inside the message.

Even for UNDERSTAND requests, the default is ZERO blocks. Earn each one: use a block only when it shows something prose genuinely can't — a multi-step pipeline, a real tradeoff table, a check the reader should try. A short explanation, a definition, or a single-idea answer needs none. Do not stack more than three blocks in one reply, and never open a reply with a block.

Block types (each opens with \`:::kind\` on its own line, body is simple YAML, and closes with \`:::\` on its own line):

1. \`:::learning-card\` — one key idea, front and center.
:::learning-card
title: Core idea
icon: 🧠
tone: insight
content: A model is like a machine with many tiny knobs. Training adjusts those knobs until predictions become less wrong.
:::
(tone: insight | tip | warning | note)

2. \`:::step-lab\` — a guided interactive walkthrough (the richest block; use for multi-step processes). Prefer 3 to 6 steps. Every step needs id, title, summary, detail, visualType, and meaningful data. visualType values: tokenization, embedding, attention, transformer-processing, probability-distribution, next-token-selection, generic-process. Set \`density: compact\` for chat-friendly sizing. Strongly recommended: give each step a one-sentence \`notice:\` telling the learner exactly what to look at in the visual, and give the lab a closing \`takeaway:\` (one sentence) shown when the learner completes it.
:::step-lab
title: The Next-Token Prediction Pipeline
label: Step Lab
description: How a language model turns text into the next token.
density: compact
takeaway: Everything a model writes is one next-token guess at a time, each conditioned on all the tokens before it.
steps:
- id: tokenize
  title: Tokenization
  summary: Text is split into tokens.
  detail: The model maps each token to a numerical ID from its vocabulary.
  notice: Click each token — rare words split into several pieces, so token counts differ from word counts.
  visualType: tokenization
  data:
    input: "The model predicts the next word"
    tokens:
    - text: "The"
      id: 791
    - text: "model"
      id: 2746
- id: probabilities
  title: Probability Distribution
  summary: The model scores possible next tokens.
  detail: The prediction head estimates which token is most likely to come next.
  visualType: probability-distribution
  data:
    candidates:
    - token: "word"
      probability: 0.42
    - token: "step"
      probability: 0.16
:::

3. \`:::process-timeline\` — ordered stages of a process (lighter than a step lab).
:::process-timeline
title: Training loop
steps:
- label: Input examples
  description: The model receives examples.
- label: Prediction
  description: The model predicts an answer.
- label: Update
  description: Weights shift to reduce the error.
:::

4. \`:::comparison\` — side-by-side tradeoffs.
:::comparison
title: SQL vs NoSQL
columns: ["SQL", "NoSQL"]
rows:
- label: Schema
  values: ["Fixed, enforced", "Flexible, per-document"]
- label: Best for
  values: ["Relational integrity", "Evolving shapes at scale"]
verdict: Choose by data shape, not fashion.
:::

5. \`:::quiz\` — a local check-your-understanding quiz (answered in place, never sends a message). PREFER 2-4 questions via a \`questions:\` list: the block walks through them one at a time and shows a scored recap at the end. Each question has \`options\`, marks the right one (\`correct: true\` on the option OR an \`answer:\` line naming it), and may carry an optional \`hint:\` (revealed only on request — scaffold, don't spoil) and an \`explanation:\`.
:::quiz
title: Check your understanding
questions:
- question: What does the model update during training?
  options:
  - The browser CSS
  - Its internal weights
  - The user's keyboard
  answer: Its internal weights
  hint: Think about which part of the system is numerical and adjustable.
  explanation: Training adjusts the model's internal numerical parameters, called weights.
- question: Why can one word become several tokens?
  options:
  - The vocabulary is fixed, so rare words are split into sub-word pieces
  - The model saves memory by cutting long words
  - Every syllable is always its own token
  answer: The vocabulary is fixed, so rare words are split into sub-word pieces
  explanation: A finite vocabulary covers any text by composing rare words from frequent fragments.
:::
(A single quick check can still be written flat — \`question:\` and \`options:\` at the top level, no \`questions:\` list.)

6. \`:::deep-dive\` — collapsed optional detail for curious readers.
:::deep-dive
title: What is a vector embedding?
summary: A vector embedding is a list of numbers representing meaning.
content: Words with similar meanings have vectors that sit closer together in mathematical space, letting the model compare concepts numerically.
:::

Hard rules for every block:
- BUILD requests get no blocks, ever. If you just produced code, a document, or an artifact, do not follow it with a quiz, comparison, or process timeline about it.
- Always provide complete data — never empty placeholders, never decorative-only visuals. Every visual must teach something concrete.
- Use simple, concrete examples and say what the reader should notice.
- Keep blocks compact; chat width is narrow.
- Surround blocks with normal Markdown prose; a block never replaces the explanation entirely.
- Do not use blocks for simple questions, short definitions, or casual conversation.
- Do not create an artifact for these unless the user explicitly asks for one.

For flow diagrams, a fenced \`\`\`mermaid code block renders inline as a diagram. The legacy fenced \`juno-visual\` JSON block (cards/flowchart shapes) is still supported, but prefer the \`:::\` blocks above.

Do not use inline visuals for full code files, apps, long documents, SVGs, or reusable standalone work; use Canvas artifacts for those when Canvas is enabled.`
    );
  }

  if (opts.canvas) {
    parts.push(
      `# Canvas (artifacts)
When you produce substantial, self-contained content the user will want to keep, edit, or reuse — full code files, an HTML page, an SVG, a long document (>15 lines), or a Mermaid diagram — wrap it in an artifact tag instead of a normal code block:

<juno:artifact identifier="kebab-case-id" type="REACT|HTML|CODE|SVG|MARKDOWN|MERMAID" title="Human Title" language="tsx">
...the full content...
</juno:artifact>

Rules:
- For a BUILD request, the artifact IS the answer: put the complete, working deliverable in ONE artifact (e.g. a full HTML page for "build me a website"), with one or two sentences of prose around it. Do not split one deliverable across several artifacts, and do not add extra artifacts the user didn't ask for (comparison tables, plans, explainers).
- Use a short stable "identifier". To revise an existing artifact, REUSE its identifier and output the complete updated content (a new version is saved automatically).
- "type": REACT for a React component (default export, no imports needed beyond react), HTML for a standalone page, SVG for vector graphics, MERMAID for diagrams, MARKDOWN for documents, CODE for any other code (set "language").
- Put a one-line explanation before the artifact. Do not repeat the artifact's content outside the tag, and do not follow it with a tutorial about how it works unless asked.
- For small snippets or inline examples, use a normal Markdown code block, not an artifact.

Interactive or educational artifacts (simulations, visual explainers, step-through demos) must behave like designed learning tools, not tech demos:
- State the learning objective in one visible line at the top, and start from a useful, non-empty initial state with real data — never lorem ipsum, never empty charts.
- Every control earns its place: label it with what it does, and give stepped content Previous/Next plus a visible "step N of M" position. Add Reset/Replay when state can drift. No decorative buttons, sliders that change nothing, or fake progress.
- Always explain the CURRENT state in words next to the visual — what the reader should notice right now, updated as parameters change.
- Make it operable by keyboard (buttons, not clickable divs; visible focus), give interactive elements accessible names, respect prefers-reduced-motion (gate nonessential animation), and let the layout work at phone width.
- Animate only meaning: a transition that shows how state A becomes state B. No looping decoration.

Documents, spreadsheets and decks are MARKDOWN artifacts — the user can download one as a real .docx, .xlsx or .pptx. When they ask for a document, report, spreadsheet, budget, tracker, comparison or deck, write the whole thing as ONE MARKDOWN artifact, shaped for what they asked for:
- Document / report: normal Markdown headings, prose and lists.
- Spreadsheet / budget / tracker / comparison: a real Markdown table — one header row, every row the same column count, and RAW NUMBERS in numeric cells (\`1200\`, never \`$1,200\`). Units and currency go in the header ("Cost (USD)"), so cells land as real spreadsheet numbers instead of text.
- Deck / presentation: one slide per \`## \` heading with bullets under it, slides separated by a \`---\` line.
You write the content; the USER picks the download format. Never say you attached a file, exported anything, or generated a .docx/.xlsx/.pptx.`
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

  // Personality goes BEFORE custom instructions on purpose: it is a preset
  // default, so anything the user wrote themselves must be able to override it.
  const personality = opts.personality ? personalitySystemPrompt(opts.personality) : null;
  if (personality) {
    parts.push(`# Response style\n${personality}`);
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

/** Per-request dynamic context (currently the date). Kept OUT of the cached
 *  prefix: each adapter appends it after its stable region. */
export function buildDynamicContext(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Today is ${today}.`;
}

/** Convert persisted messages (+ their attachments) into Anthropic message params. */
export async function toAnthropicMessages(messages: MessageForModel[]): Promise<Anthropic.MessageParam[]> {
  const result: Anthropic.MessageParam[] = [];
  // Only the last few messages re-embed heavy binaries; older ones are
  // summarized. Block-anchored (see openai-compat.ts): aging images out
  // one-per-turn would move the cache_control-stable prefix every request.
  const binaryFrom = Math.max(
    0,
    Math.floor((messages.length - BINARY_ATTACHMENT_LOOKBACK) / BINARY_ATTACHMENT_LOOKBACK) * BINARY_ATTACHMENT_LOOKBACK
  );

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

/** True when a `speed:"fast"` request failed specifically because fast mode is
 *  unavailable to this account/right now (not enrolled in the research preview,
 *  or fast-tier capacity exhausted) — the cases where retrying at standard speed
 *  is the right move. Other errors propagate unchanged. */
function isFastModeUnavailable(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { message?: string } };
  const status = e?.status;
  const msg = (e?.error?.message || e?.message || "").toLowerCase();
  if (status === 403) return true; // no access to the research preview
  if ((status === 400 || status === 429) && /fast|speed|beta/.test(msg)) return true;
  return false;
}

export async function* streamAnthropic(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  mcpServers?: AnthropicMcpServer[],
  dynamicContext?: string,
  fastMode?: boolean
): AsyncGenerator<LlmEvent> {
  const messages = await toAnthropicMessages(history);
  markConversationCacheBreakpoint(messages);
  // Cache the (large, stable) system prompt so it isn't re-billed every turn.
  // A 1h TTL (vs the 5m default) keeps the prefix warm across the pauses a real
  // chat has between turns — a reader who replies 10-40 min later still hits the
  // cache (0.1x read) instead of paying to rewrite the whole prefix. The 2x
  // write premium is repaid after a single later read of a prompt this large.
  // Dynamic per-request context (the date) goes in a SECOND system block after
  // the breakpoint, so its daily change never invalidates the cached prefix.
  // Ordering rule: the 1h block sits before the 5m conversation breakpoint below
  // (all 1h cache_control entries must precede any 5m entry in a request).
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } },
    ...(dynamicContext ? [{ type: "text" as const, text: dynamicContext }] : []),
  ];
  const thinkingBits = buildAnthropicThinkingBits(model.providerModel, maxTokens, reasoningEffort);
  const useMcp = !!mcpServers && mcpServers.length > 0;
  const baseParams = {
    model: model.providerModel,
    max_tokens: thinkingBits.maxTokens,
    system: systemBlocks,
    messages,
    stream: true,
    ...(thinkingBits.thinking ? { thinking: thinkingBits.thinking } : {}),
    ...(thinkingBits.outputConfig ? { output_config: thinkingBits.outputConfig } : {}),
    // Claude's native web search server tool — searches + cites inline.
    ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
    // Native MCP connector: Claude calls the linked servers (GitHub/Figma…) itself.
    ...(useMcp ? { mcp_servers: mcpServers } : {}),
  } as Anthropic.Messages.MessageCreateParamsStreaming;

  // Open the stream at the requested speed. Fast mode (`speed:"fast"`) streams
  // output ~2.5x faster at premium price on supported Opus models, behind the
  // fast-mode research-preview beta. If the account isn't enrolled or fast
  // capacity is exhausted, fall back to standard speed once rather than failing
  // the whole turn — switching speed only costs a one-off prompt-cache miss.
  const openStream = (fast: boolean) => {
    const betas = [
      ...(useMcp ? ["mcp-client-2025-04-04"] : []),
      ...(fast ? ["fast-mode-2026-02-01"] : []),
    ];
    return getAnthropic().messages.create(
      (fast ? { ...baseParams, speed: "fast" } : baseParams) as Anthropic.Messages.MessageCreateParamsStreaming,
      { signal, ...(betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : {}) }
    );
  };

  let servedFast = !!fastMode;
  let stream: Awaited<ReturnType<typeof openStream>>;
  try {
    stream = await openStream(!!fastMode);
  } catch (err) {
    if (fastMode && isFastModeUnavailable(err)) {
      servedFast = false;
      stream = await openStream(false);
    } else {
      throw err;
    }
  }
  const seen = new Set<string>();
  // Accumulate across the whole stream. Never emit partial mid-stream usage that
  // could wipe earlier input/cache with a delta that only has output_tokens.
  type RawU = {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
    output_tokens_details?: { thinking_tokens?: number } | null;
    server_tool_use?: { web_search_requests?: number } | null;
    speed?: string | null;
  };

  const acc = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    webSearchRequests: 0,
    fast: servedFast,
  };

  const fold = (u: RawU | null | undefined) => {
    if (!u) return;
    // Prefer higher values so a partial delta never zeros out message_start.
    if (u.input_tokens != null && u.input_tokens > acc.input) acc.input = u.input_tokens;
    if (u.output_tokens != null && u.output_tokens > acc.output) acc.output = u.output_tokens;
    if (u.cache_read_input_tokens != null && u.cache_read_input_tokens > acc.cacheRead) {
      acc.cacheRead = u.cache_read_input_tokens;
    }
    const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const writeAgg = u.cache_creation_input_tokens ?? 0;
    if (write5m > acc.cacheWrite5m) acc.cacheWrite5m = write5m;
    if (write1h > acc.cacheWrite1h) acc.cacheWrite1h = write1h;
    const split = acc.cacheWrite5m + acc.cacheWrite1h;
    if (split > acc.cacheWrite) acc.cacheWrite = split;
    else if (writeAgg > acc.cacheWrite) acc.cacheWrite = writeAgg;
    const thinking = u.output_tokens_details?.thinking_tokens ?? 0;
    if (thinking > acc.reasoning) acc.reasoning = thinking;
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    if (searches > acc.webSearchRequests) acc.webSearchRequests = searches;
    if (u.speed != null) acc.fast = servedFast && u.speed !== "standard";
  };

  for await (const event of stream as AsyncIterable<Anthropic.RawMessageStreamEvent>) {
    if (event.type === "message_start") {
      fold(event.message.usage as RawU);
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
      fold(event.usage as RawU);
      const stopReason = (event.delta as { stop_reason?: string | null }).stop_reason;
      if (stopReason) yield { type: "finish", reason: normalizeFinishReason(stopReason), raw: stopReason };
    }
  }

  // Single authoritative usage event after the stream completes.
  const hasAny =
    acc.input > 0 ||
    acc.output > 0 ||
    acc.cacheRead > 0 ||
    acc.cacheWrite > 0 ||
    acc.reasoning > 0 ||
    acc.webSearchRequests > 0;
  if (hasAny) {
    // Do NOT put cache into `total` — resolveBillableTokens would treat
    // total−input as "missing output" and inflate completion tokens.
    yield {
      type: "usage",
      input: acc.input || undefined,
      output: acc.output || undefined,
      cacheRead: acc.cacheRead || undefined,
      cacheWrite: acc.cacheWrite || undefined,
      cacheWrite5m: acc.cacheWrite5m || undefined,
      cacheWrite1h: acc.cacheWrite1h || undefined,
      reasoning: acc.reasoning || undefined,
      webSearchRequests: acc.webSearchRequests || undefined,
      fast: acc.fast,
    } satisfies LlmEvent;
  }
}
