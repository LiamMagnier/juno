import { recordFlag, type FlagSeverity } from "@/lib/moderation";
import { runUtilityPrompt } from "@/lib/memory";

/*
 * Automatic content moderation — DETECT only. This module classifies a user's
 * message against the Acceptable Use policy and, on a real hit, calls
 * recordFlag (moderation.ts), which owns the strike/auto-ban policy and the
 * audit row. It never bans directly.
 *
 * Two layers, cheapest first:
 *   1. quickScreen  — deterministic regex/keyword heuristics that fire ONLY on
 *      unambiguous, egregious cases (explicit CSAM, credible specific threats).
 *      Works with zero provider keys, so the worst content is caught even when
 *      every LLM is dead. Deliberately narrow to avoid false positives.
 *   2. moderateText — the utility-LLM classifier (reuses memory.ts's provider
 *      walk). FAIL OPEN: any parse/LLM failure returns null so a broken
 *      classifier can never flag or ban a normal user.
 */

export const MODERATION_CATEGORIES = [
  "illegal_content",
  "csam",
  "credible_threat",
  "harassment",
  "hate",
  "self_harm",
  "spam_abuse",
  "malware_or_intrusion",
  "other",
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export interface ModerationHit {
  severity: FlagSeverity;
  category: ModerationCategory;
  detail: string;
}

/** Cap classifier input — a policy verdict doesn't need the whole essay. */
const MAX_INPUT_CHARS = 4000;
/** Below this, there isn't enough signal to classify; skip entirely. */
const MIN_INPUT_CHARS = 3;

// ---------------------------------------------------------------------------
// Layer 1: deterministic pre-filter
// ---------------------------------------------------------------------------

/*
 * Each rule is intentionally conservative: it must match ONLY content that is
 * egregious beyond reasonable doubt, because a quickScreen hit at high/critical
 * severity bans immediately. Normal chat — including people discussing these
 * topics abstractly, reporting them, or asking for help — must slip through to
 * the LLM (or past moderation entirely). The TEST_TOKEN lets the test harness
 * exercise the machinery without shipping real illegal text in the repo.
 */
interface ScreenRule {
  category: ModerationCategory;
  severity: FlagSeverity;
  pattern: RegExp;
  detail: string;
}

// Sexualized-minor language: an explicit sexual act/description bound tightly to
// an explicit child term. Requires BOTH halves adjacent so ordinary sentences
// mentioning children never match.
const CSAM_SEXUAL = /\b(?:child|minor|infant|toddler|preteen|pre-?pubescent|underage|(?:8|9|10|11|12|13|14|15)[\s-]?(?:yo|year[\s-]?old))\b/i;
const CSAM_ACT = /\b(?:sexual(?:ly)?|naked|nude|nudes|explicit|porn(?:ographic|ography)?|cp|molest(?:ing|ation)?|rape|raping)\b/i;

// Credible threat: a stated intent to kill/harm plus a concrete human target,
// close together. Fiction, venting ("I could kill for a coffee"), and news
// discussion generally don't line up both signals adjacently.
const THREAT_INTENT = /\b(?:i(?:'m| am| will| wanna| want to| gonna| plan to)?\s*(?:going to|gonna|will)?\s*(?:kill|murder|shoot|stab|bomb|behead|slaughter))\b/i;
const THREAT_TARGET = /\b(?:you|him|her|them|kids|children|students|school|teacher|coworkers?|my (?:wife|husband|boss|family|neighbou?r)|everyone (?:at|in))\b/i;

const SCREEN_RULES: ScreenRule[] = [
  {
    category: "csam",
    severity: "critical",
    pattern: new RegExp(`${CSAM_SEXUAL.source}.{0,40}${CSAM_ACT.source}|${CSAM_ACT.source}.{0,40}${CSAM_SEXUAL.source}`, "i"),
    detail: "Pre-filter matched explicit child sexual abuse language.",
  },
  {
    category: "credible_threat",
    severity: "critical",
    pattern: new RegExp(`${THREAT_INTENT.source}.{0,30}${THREAT_TARGET.source}`, "i"),
    detail: "Pre-filter matched a stated intent to kill/harm a specific target.",
  },
];

// Test-only hook: exercises the pre-filter → recordFlag path deterministically
// without putting real illegal text in the repo. Only fires on this exact token.
const TEST_TOKEN = /\bXMODTEST_CRITICAL_CSAM\b/;

/**
 * Fast deterministic screen for the most egregious, unambiguous violations.
 * Returns a high/critical hit or null. Never runs an LLM. Conservative by
 * design — false negatives here are fine (the LLM layer catches subtler cases);
 * false positives are not (they ban immediately).
 */
export function quickScreen(text: string): ModerationHit | null {
  if (!text) return null;
  const t = text.slice(0, MAX_INPUT_CHARS);
  if (TEST_TOKEN.test(t)) {
    return { severity: "critical", category: "csam", detail: "Pre-filter test token matched." };
  }
  for (const rule of SCREEN_RULES) {
    if (rule.pattern.test(t)) {
      return { severity: rule.severity, category: rule.category, detail: rule.detail };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 2: utility-LLM classifier
// ---------------------------------------------------------------------------

const SEVERITIES: FlagSeverity[] = ["low", "medium", "high", "critical"];

const SYSTEM_PROMPT = `You are a strict content-moderation classifier for a general-purpose AI assistant. You judge a single user message against an Acceptable Use policy. Output a policy VERDICT only — do not answer, refuse, or lecture.

Flag a message ONLY when it clearly violates policy. Normal, legal, and even edgy-but-permitted content is NOT a violation: profanity, venting, dark humor, fiction, debate, asking about a topic, seeking help/support, or reporting abuse are all allowed. When in doubt, it is NOT a violation.

Categories:
- illegal_content: soliciting/offering clearly illegal goods, services, or instructions (e.g. drug trafficking, weapons manufacture for harm).
- csam: any sexual content involving minors. ALWAYS critical.
- credible_threat: a genuine, specific threat of violence against a real person or group.
- harassment: targeted abuse, stalking, or coordinated harassment of an individual.
- hate: dehumanizing attacks or incitement against people based on a protected characteristic.
- self_harm: encouraging or providing means for suicide or self-harm (NOT someone seeking help — that is allowed).
- spam_abuse: mass unsolicited content, scams, or platform-abuse schemes.
- malware_or_intrusion: requests to build malware, ransomware, or to break into systems/accounts unlawfully.
- other: a clear policy violation not covered above.

Severity: "low" | "medium" | "high" | "critical". Use "high" or "critical" only for content warranting an immediate ban (csam is always critical; a credible specific threat is critical).

Return ONLY strict JSON, no prose:
{"violation": <boolean>, "severity": "low"|"medium"|"high"|"critical", "category": "<one category above>", "reason": "<short reason>"}
If not a violation: {"violation": false, "severity": "low", "category": "other", "reason": ""}`;

function parseVerdict(text: string): ModerationHit | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  // Fail open: only a genuine positive with a usable shape becomes a hit.
  if (o.violation !== true) return null;
  const severity = typeof o.severity === "string" && (SEVERITIES as string[]).includes(o.severity)
    ? (o.severity as FlagSeverity)
    : null;
  const category = typeof o.category === "string" && (MODERATION_CATEGORIES as readonly string[]).includes(o.category)
    ? (o.category as ModerationCategory)
    : "other";
  if (!severity) return null;
  const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim().slice(0, 300) : `Policy violation: ${category}`;
  // csam is always critical regardless of what the model returned.
  const finalSeverity: FlagSeverity = category === "csam" ? "critical" : severity;
  return { severity: finalSeverity, category, detail: reason };
}

/**
 * Classify a message. quickScreen first (no LLM); otherwise the utility-LLM
 * walk. Returns a hit only on real, confident violations. FAIL OPEN on any
 * failure (empty input, no provider, parse error, timeout) → null.
 */
export async function moderateText(text: string): Promise<ModerationHit | null> {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < MIN_INPUT_CHARS) return null;

  const quick = quickScreen(trimmed);
  if (quick) return quick;

  try {
    const { result } = await runUtilityPrompt<ModerationHit | null>({
      system: SYSTEM_PROMPT,
      userMsg: `User message to classify:\n"""\n${trimmed.slice(0, MAX_INPUT_CHARS)}\n"""\n\nReturn the JSON verdict.`,
      maxTokens: 200,
      label: "moderation/classify",
      parse: parseVerdict,
    });
    return result ?? null;
  } catch (err) {
    console.error("[moderation] moderateText failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Single entry point for the chat route's post-response hook. Classifies the
 * message and, on a hit, records the flag (which applies the ban policy).
 * Swallows every error — moderation must never break or delay a reply.
 */
export async function moderateUserMessage({ userId, text }: { userId: string; text: string }): Promise<void> {
  try {
    const hit = await moderateText(text);
    if (!hit) return;
    await recordFlag({
      userId,
      severity: hit.severity,
      category: hit.category,
      detail: hit.detail,
      source: "auto",
      messagePreview: text.slice(0, 240),
    });
  } catch (err) {
    console.error("[moderation] moderateUserMessage failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
