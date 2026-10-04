import type { VoiceDelegate, VoiceReasoningEffort } from "../protocol.js";

/**
 * The backend model a Gemini Live call hands harder turns to.
 *
 * Gemini Live has no managed delegation the way GPT-Live has
 * (`delegation.responses`), so the relay builds the same shape out of the Live
 * API's function calling: the voice model is given one function,
 * `ask_backend_model`, and when it calls it the relay asks Gemini 3.8 Flash
 * over REST `generateContent` and answers with a `toolResponse`
 * (https://ai.google.dev/gemini-api/docs/live-tools).
 *
 * How hard Flash thinks follows the voice model, as the owner set it: Gemini
 * 3.8 Live delegates at `thinkingLevel: "low"` (a quick lookup that keeps the
 * call conversational), Gemini 3.8 Live Extended Thinking at `"high"` — the
 * caller who chose a thinking voice gets a thinking delegate. Gemini 3.8 Flash
 * accepts low / medium / high (https://ai.google.dev/gemini-api/docs/thinking).
 * Google Search grounding rides on the delegate, as web search does on
 * GPT-Live's.
 */
export const GEMINI_DELEGATE_MODEL = "gemini-3.8-flash";
export const GEMINI_DELEGATE_FUNCTION = "ask_backend_model";

/** The Live API function declaration (camelCase on the raw socket). */
export const GEMINI_DELEGATE_DECLARATION = {
  name: GEMINI_DELEGATE_FUNCTION,
  description:
    "Hand a question to a stronger backend model that can reason carefully and search the web. Use it for anything " +
    "that needs current information, facts you are unsure of, calculations, or careful multi-step thinking. Say a few " +
    "words to the user while you wait, then speak its answer in your own conversational words.",
  parameters: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING", description: "The question to answer, self-contained." },
      context: {
        type: "STRING",
        description: "Anything from the conversation the backend model needs to answer well. Optional.",
      },
    },
    required: ["question"],
  },
} as const;

/** The REST host; tests point it at a local server. */
function restBase(): string {
  return (process.env.RELAY_GEMINI_REST_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
}

/**
 * One thinking dial for a Gemini call, the way GPT-Live's dial works — except
 * that on Gemini the voice model itself has a thinking mode, so a rung chooses
 * both halves (https://ai.google.dev/gemini-api/docs/live-guide: 3.8 Live
 * takes no `thinkingLevel`; 3.8 Live Extended Thinking takes low/medium/high):
 *
 *   Low     Gemini 3.8 Live                         → Flash at low
 *   Medium  3.8 Live Extended Thinking, level low   → Flash at high
 *   High    3.8 Live Extended Thinking, level high  → Flash at high
 *
 * Every Extended Thinking rung delegates at high, as the owner set it. Medium
 * is exactly what "Reasoning on" was before (Extended Thinking at its
 * conversational `low`); High lets the voice model think at its deepest too.
 */
export const GEMINI_REASONING_EFFORTS: readonly VoiceReasoningEffort[] = ["low", "medium", "high"];
export const GEMINI_DEFAULT_REASONING_EFFORT: VoiceReasoningEffort = "low";

export interface GeminiVoicePlan {
  /** Extended Thinking rather than plain 3.8 Live. */
  thinking: boolean;
  /** `thinkingConfig.thinkingLevel` for Extended Thinking; absent for plain Live, which refuses one. */
  liveThinkingLevel?: "low" | "high";
  delegate: VoiceDelegate;
}

export function geminiVoicePlan(effort: VoiceReasoningEffort): GeminiVoicePlan {
  if (effort === "low") return { thinking: false, delegate: geminiDelegateConfig(false) };
  // Medium hands Flash medium thinking; High (and anything above) hands it high.
  if (effort === "medium") return { thinking: true, liveThinkingLevel: "low", delegate: { ...geminiDelegateConfig(true), effort: "medium" } };
  return { thinking: true, liveThinkingLevel: "high", delegate: geminiDelegateConfig(true) };
}

export function geminiDelegateConfig(thinking: boolean): VoiceDelegate {
  return {
    model: process.env.RELAY_GEMINI_DELEGATE_MODEL || GEMINI_DELEGATE_MODEL,
    effort: thinking ? "high" : "low",
    webSearch: process.env.RELAY_GEMINI_DELEGATE_WEB_SEARCH !== "0",
  };
}

/** The exact `generateContent` body the delegate sends. Pure, so a test can pin it. */
export function geminiDelegateRequest(
  delegate: VoiceDelegate,
  args: { question?: unknown; context?: unknown }
): Record<string, unknown> {
  const question = String(args.question ?? "").trim().slice(0, 4_000);
  const context = typeof args.context === "string" ? args.context.trim().slice(0, 8_000) : "";
  return {
    systemInstruction: {
      parts: [
        {
          text:
            "You are the backend model behind a voice assistant. Your answer will be spoken aloud by the voice " +
            "model, so answer directly and concisely in plain sentences: no markdown, lists, tables or links.",
        },
      ],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: context ? `${question}\n\nConversation context:\n${context}` : question }],
      },
    ],
    generationConfig: { thinkingConfig: { thinkingLevel: delegate.effort } },
    ...(delegate.webSearch ? { tools: [{ google_search: {} }] } : {}),
  };
}

/**
 * Ask the delegate. Resolves to the text the voice model should speak from;
 * a failure resolves to an `error` the voice model can say plainly rather
 * than a thrown error that would end the call.
 */
export async function askGeminiDelegate(
  delegate: VoiceDelegate,
  args: { question?: unknown; context?: unknown },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<{ answer: string } | { error: string }> {
  const key = process.env.GEMINI_LIVE_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { error: "The backend model is not configured on this relay." };
  try {
    const res = await fetchImpl(
      `${restBase()}/v1beta/models/${encodeURIComponent(delegate.model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(geminiDelegateRequest(delegate, args)),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      }
    );
    const text = await res.text();
    if (!res.ok) return { error: `The backend model failed (${res.status}).` };
    const body = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    };
    const answer = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join("")
      .trim();
    return answer ? { answer: answer.slice(0, 12_000) } : { error: "The backend model returned no answer." };
  } catch (err) {
    if (signal?.aborted) return { error: "cancelled" };
    return { error: `The backend model could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}
