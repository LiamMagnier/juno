/**
 * "Auto" model routing: pick the cheapest chat model that can handle the prompt.
 *
 * Complexity is estimated with cheap, deterministic heuristics (no extra LLM call)
 * so routing adds near-zero latency. Capability floors use the same intelligence /
 * price metrics as the model selector.
 */

import type { Plan } from "@prisma/client";
import { canUseModel } from "@/lib/plans";
import { MODEL_LIST, type ModelId, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import {
  averageRequestCostMicroUsd,
  clampReasoningEffort,
  getModelMetrics,
  reasoningCaps,
  type ReasoningEffort,
} from "@/lib/model-metrics";

/** Sentinel id shown in the model selector; never sent to a provider API. */
export const AUTO_MODEL_ID: ModelId = "juno:auto";

export function isAutoModelId(id: string | null | undefined): boolean {
  return !!id && (id === AUTO_MODEL_ID || id === "auto" || id.toLowerCase() === "juno:auto");
}

export type PromptComplexity = "simple" | "medium" | "hard" | "expert";

export interface PromptComplexityResult {
  level: PromptComplexity;
  /** Minimum intelligence score (1–10) a model should clear. */
  minIntelligence: number;
  /** Prefer models with reasoning/thinking when true. */
  preferReasoning: boolean;
  /** Why the router chose this tier (debug / future UI). */
  reasons: string[];
}

export interface AutoPickInput {
  message: string;
  plan: Plan;
  hasImages?: boolean;
  wantsWebSearch?: boolean;
  /** Prefer current generation models unless nothing else fits. */
  preferCurrent?: boolean;
}

export interface AutoPickResult {
  model: ModelInfo;
  complexity: PromptComplexityResult;
  /**
   * Thinking effort chosen for this prompt on the picked model.
   * `null` = Instant / no extra reasoning (when the model allows disabling).
   */
  reasoningEffort: ReasoningEffort;
  /** Models considered, cheapest-first among eligible (for logging). */
  candidatesConsidered: number;
}

const MIN_INTEL: Record<PromptComplexity, number> = {
  simple: 4,
  medium: 6,
  hard: 8,
  expert: 9,
};

// ---------------------------------------------------------------------------
// Complexity signals
// ---------------------------------------------------------------------------
//
// Keyword families are grouped by WHAT they signal, not by language: each
// carries patterns for the locales Juno actually serves — English, French (the
// home market), the Spanish/Portuguese/Italian/German majors, Japanese,
// Chinese, Korean and Russian — so « refactorise » weighs exactly what
// "refactor" does. English-only wordlists routed every non-English expert
// prompt to the cheapest tier.
//
// Patterns are matched as substrings on purpose: \b is ASCII-only in JS
// regexes, so it would silently break on « démontrer » or 「証明」, and a
// false positive merely spends a little more — it never degrades the answer.
// Languages with no wordlist here are caught by the structural signals in
// classifyPromptComplexity (length, fences, list shape, question count),
// which read shape rather than words — unknown locales degrade toward a
// STRONGER model, never a weaker one. Everything stays precompiled regex:
// no model call, no locale-detection pass, no per-request allocation.
const family = (parts: string[]) => new RegExp(parts.join("|"), "iu");

const DEEP_TECHNICAL = family([
  "\\b(architect|refactor|migrate|distributed|concurrency|race condition|security audit|prove|theorem|formal|compiler|kernel|cryptograph)",
  // fr
  "architectur|refactoris|refonte|migrer|distribué|concurren[ct]|condition de course|audit de sécurité|démontr|théorème|formel|compilateur|noyau|cryptograph",
  // es / pt / it
  "arquitectur|arquitetur|architettur|refactoriz|refatora|rifattorizz|concurrencia|concorrênc|concorrenz|condición de carrera|auditoría de seguridad|auditoria de segurança|demostr|demonstr|dimostr|teorema|compilador|compilatore|criptograf|crittograf",
  // de
  "architektur|refaktor|migrier|verteilte|nebenläufig|sicherheitsaudit|beweis|kryptograph",
  // ja
  "アーキテクチャ|リファクタリング|分散システム|並行処理|競合状態|セキュリティ監査|証明|定理|コンパイラ|カーネル|暗号",
  // zh
  "架构|重构|分布式|并发|竞态|安全审计|定理|形式化|编译器|内核|密码学",
  // ko
  "아키텍처|리팩터링|분산 시스템|동시성|경쟁 상태|보안 감사|증명|컴파일러|커널|암호",
  // ru
  "архитектур|рефактор|миграци|распредел[её]нн|конкурентн|состояние гонки|аудит безопасности|доказательств|теорем|формальн|компилятор|криптограф",
]);

const MULTI_STEP_ANALYSIS = family([
  "\\b(step by step|multi-?step|plan then|break down|compare (and|&) contrast|trade-?offs?|pros and cons|research|investigate|debug|root cause|why does|how would you design)",
  // fr
  "étape par étape|pas à pas|en plusieurs étapes|décompose|compar(e|er|aison)|avantages et inconvénients|le pour et le contre|compromis|recherche approfondie|analyse en profondeur|débog|débug|cause racine|cause profonde|pourquoi|comment concevoir",
  // es / pt / it
  "paso a paso|passo a passo|passo dopo passo|ventajas y desventajas|prós e contras|pro e contro|pros y contras|investig|indaga|depura|causa raíz|causa raiz|por qué|por que|perché|cómo diseñar|como projetar|come progettare",
  // de
  "schritt für schritt|zerlege|vergleiche|vor- und nachteile|abwäg|untersuch|recherchier|debugge|grundursache|warum|wie würdest du",
  // ja
  "ステップバイステップ|段階的に|手順を追って|比較して|長所と短所|メリットとデメリット|トレードオフ|調査して|デバッグ|根本原因|なぜ|設計して",
  // zh
  "一步一步|逐步|分步骤|优缺点|利弊|权衡|调查|调试|根本原因|为什么|如何设计",
  // ko
  "단계별로|차근차근|비교해|장단점|트레이드오프|조사해|디버깅|근본 원인|어떻게 설계",
  // ru
  "шаг за шагом|поэтапно|сравни|плюсы и минусы|компромисс|исследуй|отлад|первопричин|почему|как бы ты спроектировал",
]);

const BUILD_FROM_SCRATCH = family([
  "\\b(implement|build|write a|create a|full (app|stack)|end-to-end|production-ready|from scratch)\\b",
  // fr
  "implément|développe|construis|écris (un|une)|crée (un|une)|application complète|de bout en bout|prêt pour la production|à partir de zéro|depuis zéro",
  // es / pt / it
  "implementa|desarrolla|desenvolv|sviluppa|construye|constru(a|ir)|costruisci|escribe (un|una)|escreva (um|uma)|scrivi (un|una)|crea (un|una)|crie (um|uma)|aplicación completa|de extremo a extremo|listo para producción|desde cero|do zero|da zero",
  // de
  "implementier|entwickle|entwickel|schreibe (ein|eine)|erstelle (ein|eine)|komplette (app|anwendung)|produktionsreif|von grund auf",
  // ja
  "実装|開発して|構築して|作成して|作って|ゼロから|本番環境|エンドツーエンド",
  // zh
  "实现一个|开发一个|构建|编写一个|写一个|创建一个|从零开始|从头开始|生产环境|端到端",
  // ko
  "구현|개발해|구축해|만들어|처음부터|프로덕션",
  // ru
  "реализуй|разработай|построй|напиши|создай|с нуля|продакшен",
]);

const AGENTIC_TOOLING = family([
  "\\b(agent|tool use|function call|orchestrat|workflow|pipeline)\\b",
  // fr
  "appel de fonction|appel d'outil|orchestrat|flux de travail",
  // es / pt / it
  "agente|llamada a función|chamada de função|orquesta|flujo de trabajo|fluxo de trabalho|flusso di lavoro",
  // de
  "agenten|funktionsaufruf|orchestrier|arbeitsablauf",
  // ja
  "エージェント|ツール使用|関数呼び出し|オーケストレーション|ワークフロー|パイプライン",
  // zh
  "智能体|工具调用|函数调用|编排|工作流|流水线",
  // ko
  "에이전트|도구 사용|함수 호출|오케스트레이션|워크플로|파이프라인",
  // ru
  "агент|вызов функции|оркестрац|конвейер",
]);

const REASONING_WORDS = family([
  "\\b(reason|think carefully|chain of thought|prove|rigorous|exhaustive|edge cases?)\\b",
  // fr
  "raisonne|réfléchis (bien|attentivement)|chaîne de pensée|démontre|rigoureu|exhausti|cas limites|cas particuliers",
  // es / pt / it
  "razona|raciocin|ragiona|piensa (bien|con cuidado)|pense (bem|com cuidado)|rigoros|riguros|exhaustiv|exaustiv|esaustiv|casos límite|casos extremos|casi limite",
  // de
  "begründe|denk (gut|sorgfältig) nach|beweise|rigoros|erschöpfend|randfälle|grenzfälle",
  // ja
  "推論|よく考えて|慎重に考えて|厳密に|網羅的に|エッジケース",
  // zh
  "推理|仔细思考|认真思考|严谨|详尽|穷举|边界情况|极端情况",
  // ko
  "추론|신중하게 생각|엄밀하게|철저하게|엣지 케이스",
  // ru
  "рассуждай|подумай (хорошо|внимательно|тщательно)|строго|исчерпывающе|докажи|граничны[ех] случа",
]);

// Han / kana / hangul: scripts that pack a clause into a handful of glyphs.
const CJK_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/g;

// Bullets and numbered items across scripts (･①/一、included) — a
// requirements list reads as a spec in any language.
const LIST_LINES = /^[ \t]*(?:[-*•‣]\s|\d{1,2}[.)、．]\s?|[①-⑳])/gm;

/**
 * Score how hard the user prompt is. Tuned to push obvious trivial asks to
 * cheap tiers and multi-step / code / architecture work to flagship tiers,
 * in every locale the product serves — see the signal families above.
 */
export function classifyPromptComplexity(message: string): PromptComplexityResult {
  const text = message.trim();
  const reasons: string[] = [];
  let score = 0;

  // CJK carries roughly 2–3× the information per character of spaced Latin
  // text, so a 500-character Japanese spec IS a long prompt. Weighting the
  // characters into an effective length keeps one set of thresholds honest
  // across scripts instead of forking them per locale.
  const cjkCount = (text.match(CJK_CHARS) ?? []).length;
  const len = text.length + cjkCount * 2;
  if (len > 12_000) {
    score += 4;
    reasons.push("very long prompt");
  } else if (len > 4_000) {
    score += 3;
    reasons.push("long prompt");
  } else if (len > 1_200) {
    score += 2;
    reasons.push("medium-length prompt");
  } else if (len > 280) {
    score += 1;
  }

  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount >= 2) {
    score += 2;
    reasons.push("code blocks");
  } else if (/`[^`]+`/.test(text) || /\b(function|const |class |import |export |def |fn )\b/.test(text)) {
    score += 1;
    reasons.push("inline code");
  }

  let keywordHit = false;
  if (DEEP_TECHNICAL.test(text)) {
    keywordHit = true;
    score += 3;
    reasons.push("deep technical language");
  }

  if (MULTI_STEP_ANALYSIS.test(text)) {
    keywordHit = true;
    score += 2;
    reasons.push("multi-step / analysis framing");
  }

  if (BUILD_FROM_SCRATCH.test(text)) {
    keywordHit = true;
    score += 2;
    reasons.push("build-from-scratch request");
  }

  if (AGENTIC_TOOLING.test(text)) {
    keywordHit = true;
    score += 2;
    reasons.push("agentic / tooling request");
  }

  // Language-agnostic structure — what carries a locale the wordlists miss.
  // Several distinct questions mean several answers to plan (fullwidth ？,
  // inverted ¿ and Arabic ؟ included).
  const questionCount = (text.match(/[?？؟¿]/g) ?? []).length;
  if (questionCount >= 3) {
    score += questionCount >= 5 ? 2 : 1;
    reasons.push("multiple questions");
  }

  const listCount = (text.match(LIST_LINES) ?? []).length;
  if (listCount >= 3) {
    score += listCount >= 6 ? 2 : 1;
    reasons.push("list of requirements");
  }

  // A substantial prompt in a script none of the wordlists cover: trust its
  // shape over its vocabulary and lean UP a tier. The failure mode to avoid
  // is an expert ask in an uncovered language reading as "no keywords → route
  // to the cheapest model".
  if (!keywordHit && len > 280) {
    const nonAscii = (text.match(/[\u0080-\uffff]/g) ?? []).length;
    if (nonAscii / text.length > 0.25) {
      score += 1;
      reasons.push("uncovered language — structural signals only");
    }
  }

  // Structured system-style curricula and long role prompts need a stronger model.
  if (/<\/?[a-z][\w:-]*\b[^>]*>/i.test(text) && len > 2_000) {
    score += 2;
    reasons.push("structured / system-style prompt");
  }

  const hardReasoning = REASONING_WORDS.test(text) || score >= 6;
  if (hardReasoning && !reasons.includes("deep technical language")) {
    score += 1;
    reasons.push("reasoning-heavy wording");
  }

  // Trivial short asks stay simple even with a keyword hit.
  if (len < 80 && fenceCount === 0 && score <= 2) {
    score = Math.min(score, 1);
  }

  let level: PromptComplexity;
  if (score >= 8) level = "expert";
  else if (score >= 5) level = "hard";
  else if (score >= 3) level = "medium";
  else level = "simple";

  if (reasons.length === 0) reasons.push("short everyday request");

  return {
    level,
    minIntelligence: MIN_INTEL[level],
    preferReasoning: level === "hard" || level === "expert" || hardReasoning,
    reasons,
  };
}

function isEligibleChatModel(m: ModelInfo, plan: Plan, needsVision: boolean, needsWebSearch: boolean): boolean {
  if (m.modality !== "chat") return false;
  if (m.comingSoon) return false;
  if (m.status === "deprecated") return false;
  if (!isProviderConfigured(m.provider)) return false;
  if (!canUseModel(plan, m.id)) return false;
  if (needsVision && !m.vision) return false;
  if (needsWebSearch && !m.webSearch) return false;
  return true;
}

/**
 * Map prompt complexity → a target thinking tier, then clamp to what the
 * chosen model actually supports (Instant / on-off / multi-tier).
 */
export function pickAutoReasoningEffort(
  model: ModelInfo,
  complexity: PromptComplexityResult
): ReasoningEffort {
  if (!model.reasoning) return null;

  const caps = reasoningCaps(model);
  // On/off models: only "think" for hard+ work.
  if (caps.onOff) {
    return complexity.level === "simple" || complexity.level === "medium" ? null : "high";
  }

  // Target by complexity (cheapest thinking that still matches the ask).
  const target: ReasoningEffort =
    complexity.level === "simple"
      ? null // Instant when the model allows it
      : complexity.level === "medium"
        ? "low"
        : complexity.level === "hard"
          ? "high"
          : "max"; // expert

  // Always-on models with no Instant: null → default to their lowest tier.
  if (target == null && !caps.canDisable && caps.tiers.length > 0) {
    return clampReasoningEffort(model, caps.tiers[0]);
  }

  return clampReasoningEffort(model, target);
}

/**
 * Among models the user can call, pick the cheapest that clears the intelligence
 * floor for this prompt. Prefer `current` over legacy when prices are close.
 * Also chooses thinking effort for that model from the same complexity score.
 */
export function pickAutoModel(input: AutoPickInput): AutoPickResult {
  const complexity = classifyPromptComplexity(input.message);
  const needsVision = !!input.hasImages;
  const needsWebSearch = !!input.wantsWebSearch;
  const preferCurrent = input.preferCurrent !== false;

  let pool = MODEL_LIST.filter((m) => isEligibleChatModel(m, input.plan, needsVision, needsWebSearch));

  // Prefer current generation; fall back to legacy if the floor can't be met.
  if (preferCurrent) {
    const currentOnly = pool.filter((m) => m.status === "current" || !m.status);
    if (currentOnly.some((m) => getModelMetrics(m).intelligence >= complexity.minIntelligence)) {
      pool = currentOnly;
    }
  }

  const capable = pool.filter((m) => {
    const intel = getModelMetrics(m).intelligence;
    if (intel < complexity.minIntelligence) return false;
    if (complexity.preferReasoning && complexity.level === "expert" && !m.reasoning && intel < 9) {
      // Expert work: require explicit reasoning OR top-tier intelligence.
      return false;
    }
    return true;
  });

  const ranked = (capable.length > 0 ? capable : pool).slice().sort((a, b) => {
    const costA = averageRequestCostMicroUsd(a);
    const costB = averageRequestCostMicroUsd(b);
    if (costA !== costB) return costA - costB;
    // Tie-break: higher intelligence at same price, then current over legacy.
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    const curA = a.status === "current" ? 0 : 1;
    const curB = b.status === "current" ? 0 : 1;
    if (curA !== curB) return curA - curB;
    return a.name.localeCompare(b.name);
  });

  const fallback =
    ranked[0] ??
    MODEL_LIST.find((m) => isEligibleChatModel(m, input.plan, false, false)) ??
    MODEL_LIST.find((m) => m.modality === "chat" && !m.comingSoon);

  if (!fallback) {
    throw new Error("No chat model is available for Auto routing.");
  }

  const reasoningEffort = pickAutoReasoningEffort(fallback, complexity);

  return {
    model: fallback,
    complexity,
    reasoningEffort,
    candidatesConsidered: ranked.length || pool.length,
  };
}

/** Lightweight ModelInfo used only for UI when Auto is selected. */
export const AUTO_MODEL_INFO: ModelInfo = {
  id: AUTO_MODEL_ID,
  provider: "anthropic", // logo fallback; UI special-cases Auto with Juno mark
  providerModel: "auto",
  name: "Auto",
  description: "Picks the cheapest model and thinking depth that can handle each prompt.",
  minPlan: "FREE",
  vision: true,
  reasoning: true,
  // See resolveModel: Auto is a sentinel and the model it picks carries
  // its own flag.
  agenticTools: true,
  cost: 1,
  modality: "chat",
  webSearch: true,
  status: "current",
  family: "auto",
  legacy: false,
};
