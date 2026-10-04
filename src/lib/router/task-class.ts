/**
 * What kind of task a turn is, for routing (BRIEF §25).
 *
 * Deterministic and cheap — regexes over the prompt plus the request's own
 * facts (images, web search, connectors, context size). No model call: the
 * router runs before the first token and must add no latency.
 *
 * Complexity is not re-derived here: `classifyPromptComplexity` in
 * `auto-model.ts` already grades difficulty in every served locale, and a
 * second grader would disagree with it. This module adds the dimensions that
 * one does not have — WHAT the task is (coding, research, structured output…)
 * and what it needs from a model (tool reliability, long context, vision).
 *
 * The task class is also the telemetry key, so the set is small and stable:
 * adding a class splits the evidence for every model.
 */

import type { PromptComplexity, PromptComplexityResult } from "@/lib/auto-model";

export const TASK_CLASSES = [
  "everyday",
  "writing",
  "reasoning",
  "coding",
  "research",
  "agentic",
  "structured_output",
  "long_context",
  "vision",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === "string" && (TASK_CLASSES as readonly string[]).includes(value);
}

export interface TaskProfile {
  /** The primary class — the telemetry key. */
  taskClass: TaskClass;
  /** The grader's level, raised one step for agentic and long-context work (stakes). */
  complexity: PromptComplexity;
  /** Every dimension that applies, not only the primary one. */
  needs: {
    reasoning: boolean;
    coding: boolean;
    research: boolean;
    toolReliability: boolean;
    structuredOutput: boolean;
    longContext: boolean;
    vision: boolean;
  };
  /** Rough token sizes the cost model uses (prompt includes history/attachments). */
  estInputTokens: number;
  estOutputTokens: number;
  /** Tool rounds a turn of this shape usually takes before measured evidence. */
  priorToolRounds: number;
  /** Short reasons in the receipt's voice ("repository-scale coding"). */
  signals: string[];
}

export interface TaskInput {
  message: string;
  complexity: PromptComplexityResult;
  hasImages?: boolean;
  wantsWebSearch?: boolean;
  /** Connectors / client tools offered to the model this turn. */
  toolsOffered?: number;
  /** Tokens already in the context (history + attachments), when known. */
  contextTokens?: number;
}

const family = (parts: string[]) => new RegExp(parts.join("|"), "iu");

const CODE = family([
  "```",
  "\\b(code|function|class|bug|stack ?trace|exception|compile|typescript|javascript|python|rust|golang|swift|kotlin|sql|regex|api endpoint|unit test|refactor|repository|repo|pull request|diff)\\b",
  "\\b(npm|pip|cargo|git|docker|kubernetes|tsconfig|webpack|vite|react|next\\.js|prisma)\\b",
  "fonction|classe|débog|dépôt|requête sql|código|função|funzione|codice|programm|コード|関数|代码|函数|코드|함수|код|функци",
]);

const REPO_SCALE = family([
  "\\b(repository|codebase|monorepo|across (the|all) files|multiple files|whole project|migration)\\b",
  "dépôt|base de code|repositorio|repositório|リポジトリ|代码库|코드베이스|репозитор",
]);

const RESEARCH = family([
  "\\b(research|sources?|cite|citations?|latest|recent|news|today|this week|current(ly)?|compare (prices|vendors|providers)|market|statistics|study|studies|paper)\\b",
  "recherche|sources|actualité|dernières|investigación|fuentes|pesquisa|fontes|ricerca|fonti|quellen|aktuell|最新|ニュース|調べて|研究|新闻|来源|최신|뉴스|출처|исследован|источник|новост",
]);

const STRUCTURED = family([
  "\\b(json|yaml|csv|xml|schema|table|spreadsheet|columns?|structured|key-value|markdown table|fill (in|out) (the|this) form)\\b",
  "tableau|colonnes|tabla|columnas|tabela|tabella|tabelle|表|テーブル|表格|표|таблиц",
]);

const AGENTIC = family([
  "\\b(send (an? )?(email|message)|schedule|book|create (an? )?(issue|ticket|event)|open (a )?pr|update (the )?(sheet|doc|calendar)|use (the )?tools?|on my behalf)\\b",
  "envoie|planifie|réserve|crée un ticket|envía|programa|reserva|invia|prenota|sende|plane|buche|送って|予約|发送|预订|보내|예약|отправь|забронируй",
]);

const WRITING = family([
  "\\b(write|rewrite|draft|edit|proofread|essay|email|letter|blog|post|story|poem|tone|summari[sz]e|translate)\\b",
  "rédige|réécris|écris|corrige|résume|traduis|redacta|escribe|resume|traduce|redija|escreva|scrivi|riassumi|traduci|schreibe|fasse zusammen|übersetze|書いて|要約|翻訳|写一|总结|翻译|써 줘|요약|번역|напиши|перепиши|резюмируй|переведи",
]);

const CJK_CHARS = /[぀-ヿ㐀-䶿一-鿿가-힣]/g;

/** ~4 chars per token for spaced scripts, ~1.5 for CJK. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_CHARS) ?? []).length;
  return Math.ceil((text.length - cjk) / 4 + cjk / 1.5);
}

/** Context beyond which "long-context reliability" is a routing dimension. */
export const LONG_CONTEXT_TOKENS = 120_000;

const OUTPUT_TOKENS: Record<PromptComplexity, number> = {
  simple: 350,
  medium: 900,
  hard: 1_800,
  expert: 3_000,
};

export function classifyTask(input: TaskInput): TaskProfile {
  const text = input.message;
  const level = input.complexity.level;
  const promptTokens = estimateTokens(text);
  const contextTokens = Math.max(promptTokens, input.contextTokens ?? 0);
  const signals: string[] = [];

  const coding = CODE.test(text);
  const repoScale = coding && REPO_SCALE.test(text);
  const research = !!input.wantsWebSearch || (RESEARCH.test(text) && level !== "simple");
  const structuredOutput = STRUCTURED.test(text);
  const agentic = (input.toolsOffered ?? 0) > 0 && AGENTIC.test(text);
  const longContext = contextTokens >= LONG_CONTEXT_TOKENS;
  const vision = !!input.hasImages;
  const reasoning = input.complexity.preferReasoning;
  const writing = WRITING.test(text);
  const toolReliability = agentic || research || (input.toolsOffered ?? 0) > 0;

  if (longContext) signals.push("long-context reliability");
  if (vision) signals.push("image understanding");
  if (coding) signals.push(repoScale ? "repository-scale coding" : "coding");
  if (research) signals.push(input.wantsWebSearch ? "web research with citations" : "research");
  if (agentic) signals.push("reliable tool use");
  else if (toolReliability && !research) signals.push("tool use");
  if (structuredOutput) signals.push("structured output");
  if (reasoning && (level === "hard" || level === "expert")) signals.push("complex reasoning");
  else if (reasoning) signals.push("careful reasoning");

  // Primary class, most specific first. The order is the same question the
  // telemetry asks — "which models do well on THIS kind of turn" — so a turn
  // that is both coding and long-context counts where its hardest need is.
  let taskClass: TaskClass;
  if (longContext) taskClass = "long_context";
  else if (agentic) taskClass = "agentic";
  else if (coding) taskClass = "coding";
  else if (research) taskClass = "research";
  else if (vision) taskClass = "vision";
  else if (structuredOutput) taskClass = "structured_output";
  else if (reasoning && level !== "simple") taskClass = "reasoning";
  else if (writing) taskClass = "writing";
  else taskClass = "everyday";

  if (taskClass === "everyday") signals.push("quick everyday answer");
  if (taskClass === "writing") signals.push("writing quality");

  const priorToolRounds = agentic ? 3 : research ? 2 : toolReliability ? 1 : 0;
  const estOutputTokens = Math.round(OUTPUT_TOKENS[level] * (coding ? 1.4 : 1) * (structuredOutput ? 1.2 : 1));

  // Stakes, not wording: an action taken on the reader's behalf, or an answer
  // that has to hold across a very long document, costs more to get wrong than
  // a chat reply of the same length. A short agentic ask is graded "simple" by
  // its words; routed as simple it would go to the cheapest model that can
  // call a tool once.
  const stakesLevel: PromptComplexity =
    (agentic || longContext) && level === "simple" ? "medium" : level;

  return {
    taskClass,
    complexity: stakesLevel,
    needs: {
      reasoning,
      coding,
      research,
      toolReliability,
      structuredOutput,
      longContext,
      vision,
    },
    estInputTokens: contextTokens + 1_200, // + system prompt and tool schemas
    estOutputTokens,
    priorToolRounds,
    signals,
  };
}
