import Foundation
import JunoCodeCore

/// How a chosen thinking depth becomes provider-native request parameters.
///
/// **Why this file has to exist.** `/api/agent/<provider>/<path>` is a
/// transparent proxy — its own comment says it forwards "the app's
/// provider-native body verbatim", swapping in the server-side key and nothing
/// else. Chat does not need any of this because it posts to `/api/chat`, which
/// builds the provider payload server-side. Code posts the payload itself, so
/// every thinking parameter Code wants honoured has to be in the body Code
/// sends.
///
/// It was not. Before this file, `reasoningEffort` reached exactly one of the
/// three request builders — `OpenAIResponsesRequestBuilder`, as
/// `reasoning.effort`. `AnthropicRequestBuilder` sent no `thinking` object and
/// `OpenAIChatRequestBuilder` sent no reasoning parameter of any kind, so for
/// every Claude model and every OpenAI-compatible lab (Kimi, GLM, DeepSeek,
/// Qwen, Gemini, Grok, Mistral, MiniMax, MiMo, LongCat) the composer's Thinking
/// control was inert: moving it rewrote the session record and changed nothing
/// on the wire.
///
/// **Keep in sync with the website**, which is the source of truth and has the
/// provider oracles recorded against it:
///   - `src/lib/anthropic-thinking.ts` — adaptive vs manual, budgets, headroom
///   - `src/lib/openai-compat.ts`      — which provider speaks which dialect
///   - `src/lib/model-metrics.ts`      — `reasoningCaps`, the per-model tiers
///
/// This layer decides *shape*, not *tier*. Which depths a model offers is the
/// manifest's answer (`supportedReasoningEfforts`), and the composer already
/// narrows the control to those, so an effort arriving here is one the chosen
/// model accepts. The only value mapping done here is where the website does it
/// too: Anthropic has no `minimal`, and Mistral's enum is `high|none`.
public enum CodeThinkingWire {

    // MARK: - Anthropic

    /// Anthropic takes one of two mutually exclusive shapes, and the wrong one
    /// is a hard 400 rather than a silently ignored field.
    ///
    /// - `adaptive`: `thinking: {type: "adaptive"}` + `output_config.effort`.
    ///   `type: "enabled"` is rejected on Fable/Mythos/Opus 4.8/4.7/Sonnet 5 and
    ///   deprecated on Opus 4.6 / Sonnet 4.6.
    /// - `manual`: `thinking: {type: "enabled", budget_tokens}`. Adaptive is not
    ///   supported at all (Haiku 4.5, Opus 4.5, Sonnet 4.5, and earlier).
    public enum AnthropicThinkingKind: Sendable {
        case adaptive
        case manual
    }

    public static func anthropicThinkingKind(
        providerModelID: String
    ) -> AnthropicThinkingKind {
        let id = providerModelID.lowercased()
        // Manual-only families are matched first: "claude-opus-4-5" would
        // otherwise fall through to the adaptive default below.
        if id.contains("haiku") { return .manual }
        if id.contains("opus-4-5") || id.contains("sonnet-4-5") { return .manual }
        if id.contains("opus-4-1") || id.contains("claude-3") { return .manual }
        // An unrecognised future Claude id prefers adaptive, because manual is
        // what 400s on new models.
        return .adaptive
    }

    /// The newest adaptive models default `display` to `"omitted"`, which sends
    /// an empty thinking field. Code streams reasoning into the transcript, so
    /// it opts into summaries explicitly.
    static func needsSummarizedDisplay(_ id: String) -> Bool {
        let id = id.lowercased()
        return id.contains("fable") || id.contains("mythos")
            || id.contains("opus-4-8") || id.contains("opus-4-7")
            || id.contains("sonnet-5")
    }

    /// Anthropic publishes no `minimal` effort.
    static func anthropicEffort(_ effort: ReasoningEffort) -> String {
        effort == .minimal ? ReasoningEffort.low.rawValue : effort.rawValue
    }

    /// Soft `max_tokens` headroom so adaptive thinking has room to run without
    /// eating the answer.
    static func adaptiveHeadroom(_ effort: ReasoningEffort) -> Int {
        switch effort {
        case .minimal: 4_096
        case .low: 8_192
        case .medium: 16_384
        case .high: 32_000
        case .xhigh: 48_000
        case .max: 56_000
        }
    }

    /// `budget_tokens` per depth on the manual path.
    static func manualBudget(_ effort: ReasoningEffort) -> Int {
        switch effort {
        case .minimal: 1_024
        case .low: 2_048
        case .medium: 8_192
        case .high: 16_000
        case .xhigh: 24_000
        case .max: 32_000
        }
    }

    /// 128k output on adaptive-era models, 64k on Haiku/4.5, 32k on legacy.
    static func anthropicOutputCap(_ id: String) -> Int {
        let id = id.lowercased()
        if id.contains("opus-4-1") || id.contains("claude-3") { return 32_000 }
        return anthropicThinkingKind(providerModelID: id) == .adaptive
            ? 128_000
            : 64_000
    }

    /// What an Anthropic Messages body needs for this depth.
    ///
    /// `maxTokens` comes back adjusted because thinking tokens are drawn from the
    /// same budget as the answer: asking for extended thinking inside an
    /// unchanged 8k ceiling produces a truncated reply rather than a deeper one.
    public struct AnthropicBits: Equatable, Sendable {
        public let maxTokens: Int
        public let thinking: JSONValue?
        public let outputConfig: JSONValue?
    }

    public static func anthropicBits(
        providerModelID: String,
        maxTokens: Int,
        effort: ReasoningEffort?
    ) -> AnthropicBits {
        let cap = anthropicOutputCap(providerModelID)
        // No depth to ask for.
        //
        // Omitting `thinking` is NOT the same as switching it off. An adaptive
        // model that defaults thinking ON — Sonnet 5 — reasons anyway when the
        // field is absent, so "Off" was a no-op and the user paid for thinking
        // tokens they had explicitly declined. Those models need an explicit
        // `{"type": "disabled"}`; the ones that default off still get nothing,
        // because Fable/Mythos REJECT being disabled.
        //
        // The headroom added below exists only to pay for thinking tokens, so
        // the ceiling is left alone here either way.
        guard let effort else {
            let disable = anthropicThinkingKind(providerModelID: providerModelID) == .adaptive
                && adaptiveDefaultsOn(providerModelID)
            return AnthropicBits(
                maxTokens: min(maxTokens, cap),
                thinking: disable ? .object(["type": .string("disabled")]) : nil,
                outputConfig: nil
            )
        }
        switch anthropicThinkingKind(providerModelID: providerModelID) {
        case .adaptive:
            var thinking: [String: JSONValue] = ["type": .string("adaptive")]
            if needsSummarizedDisplay(providerModelID) {
                thinking["display"] = .string("summarized")
            }
            return AnthropicBits(
                maxTokens: min(maxTokens + adaptiveHeadroom(effort), cap),
                thinking: .object(thinking),
                outputConfig: .object(["effort": .string(anthropicEffort(effort))])
            )
        case .manual:
            let requested = manualBudget(effort)
            let total = min(requested + maxTokens, cap)
            // Anthropic requires budget_tokens < max_tokens and >= 1024. A
            // quarter of the window is reserved for the answer itself, so a
            // deep budget cannot starve the reply it is supposed to improve.
            let budget = Swift.max(
                1_024,
                Swift.min(requested, total - Int((Double(total) / 4).rounded(.up)))
            )
            return AnthropicBits(
                maxTokens: total,
                thinking: .object([
                    "type": .string("enabled"),
                    "budget_tokens": .number(Double(budget)),
                ]),
                outputConfig: nil
            )
        }
    }

    // MARK: - OpenAI-compatible Chat Completions

    /// The reasoning parameters an OpenAI-compatible body needs, keyed for
    /// merging straight into the request object.
    ///
    /// Empty for a provider with no documented control. That is the honest
    /// answer rather than a default guess: sending `reasoning_effort` to a lab
    /// that does not define it is at best ignored and at worst a 400, which is
    /// exactly why the website gates the parameter per provider.
    public static func chatParameters(
        providerID: String,
        providerModelID: String,
        effort: ReasoningEffort?
    ) -> [String: JSONValue] {
        // Nothing at all when there is no depth to ask for.
        //
        // This is the case that matters most on this path, because the failure is
        // not a wrong answer but a refused request. The Mistral line, the
        // non-reasoning OpenAI snapshots and the non-thinking Qwen models all
        // publish no tiers and all reject the parameter — `reasoning_effort is not
        // enabled for this model` is a 400, so a session on one of them failed
        // every turn rather than merely thinking at the wrong depth.
        let provider = providerID.lowercased()
        let id = providerModelID.lowercased()
        var parameters: [String: JSONValue] = [:]

        // "Off" is a REQUEST, not an omission.
        //
        // GPT-5.5/5.6, Gemini and the GLM/Qwen hybrids all think by default when
        // the parameter is absent, so omitting it made Juno's "Off" silently do
        // nothing on half the catalog — and the user paid for reasoning tokens
        // they had turned off. Each provider spells the off-state differently;
        // this mirrors the website's per-provider rules rather than guessing,
        // because sending the wrong spelling is a 400, not a slower answer.
        guard let effort else {
            if canDisableViaNoneEffort(provider: provider, id: id) {
                return ["reasoning_effort": .string("none")]
            }
            // Everything else keeps sending nothing, deliberately.
            //
            // The website decides this per model from its reasoningCaps table
            // (canDisable), which does not exist on this side. Guessing is not
            // the safe direction: sending a disable to a model that does not
            // expose one is not a slower answer, it is
            // "reasoning_effort is not enabled for this model" — a 400 on every
            // single turn, which is how the Mistral outage happened. So GLM,
            // the Qwen hybrids, Kimi and MiniMax still over-think when switched
            // off, and closing that needs the caps table ported, not a wider
            // guess here.
            return [:]
        }

        // Qwen (DashScope) drives thinking with enable_thinking + a token
        // budget, never OpenAI's reasoning_effort — sending both is redundant
        // or rejected.
        if provider == "qwen" {
            parameters["enable_thinking"] = .bool(true)
            parameters["thinking_budget"] = .number(Double(qwenBudget(effort)))
            return parameters
        }

        if usesReasoningEffort(provider: provider, id: id) {
            // Mistral's enum is only high|none, so any depth collapses to high.
            parameters["reasoning_effort"] = .string(
                provider == "mistral" ? "high" : effort.rawValue
            )
        }

        // GLM takes a thinking object on every model, and GLM-5.2 additionally
        // takes reasoning_effort (set just above).
        if provider == "zhipu" {
            parameters["thinking"] = .object(["type": .string("enabled")])
        }

        if let onState = thinkingObjectOnState(provider: provider, id: id) {
            parameters["thinking"] = .object(["type": .string(onState)])
        }

        if provider == "minimax" {
            // Ask MiniMax to return reasoning in its own field rather than
            // inline in the answer text.
            parameters["reasoning_split"] = .bool(true)
        }

        return parameters
    }

    /// Providers whose docs define OpenAI's top-level `reasoning_effort`
    /// (verified against live providers on the website, 2026-07).
    static func usesReasoningEffort(provider: String, id: String) -> Bool {
        switch provider {
        case "openai", "google", "deepseek", "xai", "mistral":
            return true
        case "zhipu":
            return id.contains("glm-5.2")
        case "moonshot":
            // Kimi K3 introduced a top-level reasoning_effort enum
            // (low|high|max) replacing the K2.x thinking object. Only K3 speaks
            // it; the K2.x line stays on the thinking-object path.
            return id.contains("k3")
        default:
            return false
        }
    }

    /// Adaptive Claude models that reason when `thinking` is OMITTED, and so
    /// need an explicit disable to actually stop.
    ///
    /// Sonnet 5 defaults on; Opus 4.7/4.8 default off. Fable and Mythos are
    /// always-on and reject `disabled` outright, which is why they must not be
    /// listed here.
    static func adaptiveDefaultsOn(_ providerModelID: String) -> Bool {
        let id = providerModelID.lowercased()
        if id.contains("fable") || id.contains("mythos") { return false }
        return id.contains("sonnet-5")
    }

    /// True when the model expresses "don't think" as reasoning_effort:"none".
    ///
    /// Mirrors canDisableViaNoneEffort in src/lib/openai-compat.ts. The
    /// exclusions are the load-bearing part: gpt-5-pro always reasons, the
    /// original gpt-5 predates "none" (its floor is "minimal"), and sending the
    /// parameter to a Mistral model that does not expose it returns
    /// "reasoning_effort is not enabled for this model" — a 400 on every turn.
    static func canDisableViaNoneEffort(provider: String, id: String) -> Bool {
        // OpenAI only, and only where the website has verified it. Google and
        // Mistral also accept "none" on SOME models, but both gate it on a
        // per-model capability this side cannot see, and both 400 the models
        // that do not expose it.
        guard provider == "openai" else { return false }
        if id.contains("-pro") { return false }        // gpt-5-pro always reasons
        // 5.1+ only; the original gpt-5 predates "none" (its floor is "minimal").
        return id.range(of: #"gpt-5\.\d"#, options: .regularExpression) != nil
    }

    /// The on-state spelling for providers that switch thinking with a
    /// `thinking: {type}` object, or nil when this model exposes no switch.
    ///
    /// Nil is the important case. Kimi K2.7 *rejects* `{type: "disabled"}` and
    /// MiniMax M2.x silently ignores the field — both always reason and are
    /// `canDisable: false` in the website's caps table, so nothing is sent for
    /// them at all.
    static func thinkingObjectOnState(provider: String, id: String) -> String? {
        switch provider {
        case "minimax":
            // M3 spells its on-state "adaptive"; M2.x has no control.
            return id.contains("m3") ? "adaptive" : nil
        case "moonshot":
            // K3 is on the reasoning_effort path; K2.7 always reasons and takes
            // no switch; K2.6 and earlier switch with enabled/disabled.
            if id.contains("k3") || id.contains("k2.7") { return nil }
            return "enabled"
        case "mimo", "longcat":
            return "enabled"
        default:
            return nil
        }
    }

    /// Qwen maps depth onto a thinking-token budget rather than an enum.
    static func qwenBudget(_ effort: ReasoningEffort) -> Int {
        switch effort {
        case .minimal: 1_024
        case .low: 2_048
        case .medium: 8_192
        case .high: 24_000
        case .xhigh: 32_000
        case .max: 38_000
        }
    }

    // MARK: - OpenAI Responses

    /// The `reasoning.effort` value for a Responses-API model.
    ///
    /// The Pro snapshots accept only medium|high|xhigh — anything shallower is a
    /// 400 — and the Codex line publishes no `minimal`. The composer already
    /// narrows to the manifest's tiers, so this is a floor rather than the
    /// primary gate, and it exists because a 400 here fails the whole turn.
    /// Returns nil when the whole `reasoning` object should be omitted.
    public static func responsesEffort(
        providerModelID: String,
        effort: ReasoningEffort?
    ) -> String? {
        guard let effort else { return nil }
        let id = providerModelID.lowercased()
        if id.contains("-pro") {
            switch effort {
            case .minimal, .low, .medium: return ReasoningEffort.medium.rawValue
            case .high: return ReasoningEffort.high.rawValue
            case .xhigh, .max: return ReasoningEffort.xhigh.rawValue
            }
        }
        if id.contains("codex"), effort == .minimal {
            return ReasoningEffort.low.rawValue
        }
        return effort.rawValue
    }
}
