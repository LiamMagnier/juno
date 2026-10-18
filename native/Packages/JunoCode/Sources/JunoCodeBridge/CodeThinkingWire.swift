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
        //
        // Haiku 4.5 (and the Claude 3 Haikus) only. This used to match any id
        // containing "haiku", which sent `{type: "enabled", budget_tokens}` to
        // Claude Haiku 5.5 — adaptive-only, so every turn was a 400
        // ("thinking.type.enabled is not supported for this model").
        if id.range(of: #"haiku-[34]"#, options: .regularExpression) != nil
            || id.contains("claude-3-haiku")
        {
            return .manual
        }
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
            || id.contains("opus-5") // claude-opus-5 and claude-opus-5-5 alike
            || id.contains("opus-4-8") || id.contains("opus-4-7")
            || id.contains("sonnet-5")
            || id.contains("haiku-5-5") // display defaults to "omitted" on Haiku 5.5 too
    }

    /// Adaptive thinking is always on and `disabled` is a 400: Fable, Mythos
    /// and Opus 5.5. Opus 5 still accepts `disabled`, hence the exact match.
    static func adaptiveAlwaysOn(_ providerModelID: String) -> Bool {
        let id = providerModelID.lowercased()
        return id.contains("fable") || id.contains("mythos") || id.contains("opus-5-5")
    }

    /// The depth an always-on model runs at when no depth was asked for: the
    /// API's own default, so omitting a tier never costs more than the
    /// provider would have charged. Opus 5.5 defaults to medium; Fable and
    /// Mythos to high (`alwaysOnDefaultEffort` on the website).
    static func alwaysOnDefaultEffort(_ providerModelID: String) -> ReasoningEffort {
        providerModelID.lowercased().contains("opus-5-5") ? .medium : .high
    }

    /// The `thinking` type that switches thinking off on a default-on model.
    /// Sonnet 5.5 rejects `disabled` at every effort and takes
    /// `between_tools`; Opus 5, Sonnet 5 and Haiku 5.5 take `disabled` (at
    /// effort high or below — Instant sends no effort, so the API default
    /// applies). `instantThinkingParam` on the website.
    static func instantThinkingType(_ providerModelID: String) -> String {
        providerModelID.lowercased().contains("sonnet-5-5") ? "between_tools" : "disabled"
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

    /// Mirrors `buildAnthropicThinkingBits` in `src/lib/anthropic-thinking.ts`
    /// branch for branch.
    public static func anthropicBits(
        providerModelID: String,
        maxTokens: Int,
        effort: ReasoningEffort?
    ) -> AnthropicBits {
        let cap = anthropicOutputCap(providerModelID)
        switch anthropicThinkingKind(providerModelID: providerModelID) {
        case .adaptive:
            guard effort != nil || adaptiveAlwaysOn(providerModelID) else {
                // Instant. Omitting `thinking` is NOT the same as switching it
                // off: Opus 5, Sonnet 5/5.5 and Haiku 5.5 reason anyway when
                // the field is absent, so they get the off value they accept.
                // Opus 4.6-4.8 and Sonnet 4.6 default off and get nothing. The
                // headroom below only pays for thinking, so the ceiling is
                // left alone.
                return AnthropicBits(
                    maxTokens: min(maxTokens, cap),
                    thinking: adaptiveDefaultsOn(providerModelID)
                        ? .object(["type": .string(instantThinkingType(providerModelID))])
                        : nil,
                    outputConfig: nil
                )
            }
            // Reached with no depth only on an always-on model, which runs at
            // the API's own default — said explicitly, as the website does, so
            // the summarized display and the headroom apply to it too.
            let tier = effort ?? alwaysOnDefaultEffort(providerModelID)
            var thinking: [String: JSONValue] = ["type": .string("adaptive")]
            if needsSummarizedDisplay(providerModelID) {
                thinking["display"] = .string("summarized")
            }
            return AnthropicBits(
                maxTokens: min(maxTokens + adaptiveHeadroom(tier), cap),
                thinking: .object(thinking),
                outputConfig: .object(["effort": .string(anthropicEffort(tier))])
            )
        case .manual:
            guard let effort else {
                // Omitting `thinking` is genuinely off on the manual families.
                return AnthropicBits(maxTokens: min(maxTokens, cap), thinking: nil, outputConfig: nil)
            }
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
    ///
    /// Mirrors `compatReasoningFields` in `src/lib/llm/compat-loop.ts` (the same
    /// rules as `src/lib/openai-compat.ts`) branch for branch. Several of its
    /// decisions turn on the model's own capabilities — whether it reasons at
    /// all and whether it can be switched off — which the website reads from
    /// `reasoningCaps`. `caps` is the same answer, from the account's model
    /// manifest (``CodeReasoningCapsRegistry``).
    ///
    /// With `caps` nil — a model the manifest has not described — the off
    /// switches that depend on `canDisable` are never sent. That is the
    /// conservative direction: sending a disable to a model that does not
    /// expose one is not a slower answer but a 400 on every turn ("reasoning_effort
    /// is not enabled for this model" — the Mistral outage). Such a model may
    /// over-think on Instant instead.
    public static func chatParameters(
        providerID: String,
        providerModelID: String,
        effort: ReasoningEffort?,
        caps: CodeReasoningCaps? = nil
    ) -> [String: JSONValue] {
        let provider = providerID.lowercased()
        let id = providerModelID.lowercased()
        var out: [String: JSONValue] = [:]

        // `model.reasoning` on the website. Unknown: a depth was asked for, so
        // the model is taken to reason; no depth, and nothing is assumed.
        let reasoning = caps?.supported ?? (effort != nil)
        // `reasoningCaps(model).canDisable`, gated on `model.reasoning` the way
        // the website gates it (the caps report canDisable for a model that
        // does not reason at all). Unknown is false — see above.
        let canDisable = caps.map { $0.supported && $0.canDisable }

        // GLM-5.3 always thinks: its depth is the effort enum, and the
        // `thinking` object's off state is exactly what makes its requests fail.
        let glmEffortOnly = provider == "zhipu" && id.contains("glm-5.3")

        if usesReasoningEffort(provider: provider, id: id) {
            if let effort {
                // Mistral's enum is only high|none, so any depth collapses to high.
                out["reasoning_effort"] = .string(provider == "mistral" ? "high" : effort.rawValue)
            } else if canDisableViaNoneEffort(
                provider: provider, id: id, canDisable: canDisable, reasoning: caps?.supported
            ) {
                // "Off" is a REQUEST, not an omission: GPT-5.5+, Gemini and
                // DeepSeek V4 think by default when the parameter is absent.
                out["reasoning_effort"] = .string("none")
            }
        }

        if provider == "qwen", reasoning {
            // Instant turns thinking off on the hybrid models (Qwen3.8 Max
            // included — hybrid, on by default); a thinking-only model always
            // gets it on. Unknown caps never send the off state.
            let alwaysThinks = !(canDisable ?? false)
            let qwenEffort: ReasoningEffort? = effort ?? (alwaysThinks ? .high : nil)
            out["enable_thinking"] = .bool(alwaysThinks ? true : qwenEffort != nil)
            if let qwenEffort {
                if id.contains("qwen3.8") {
                    // The 3.8 line takes reasoning_effort (low|medium|xhigh),
                    // and a thinking_budget alongside it is an error.
                    out["reasoning_effort"] = .string(qwenEffort.rawValue)
                } else {
                    out["thinking_budget"] = .number(Double(qwenBudget(qwenEffort)))
                }
            }
        }

        if provider == "zhipu", reasoning, !glmEffortOnly {
            // The on/off GLMs (and GLM-5.2): an effort means enabled, its
            // absence means off. The off state is only sent when the manifest
            // has confirmed the model reasons.
            if effort != nil {
                out["thinking"] = .object(["type": .string("enabled")])
            } else if caps != nil {
                out["thinking"] = .object(["type": .string("disabled")])
            }
        }

        if provider == "deepseek", reasoning, effort == nil, canDisable == true {
            // DeepSeek V4/V4.1 think by default (effort high); Instant must
            // switch it off explicitly. deepseek-reasoner has no switch.
            out["thinking"] = .object(["type": .string("disabled")])
        }

        let usesThinkingObject = ["minimax", "moonshot", "mimo", "longcat"].contains(provider)
        if usesThinkingObject, reasoning {
            // MiniMax M3 spells its on-state "adaptive".
            let onType = provider == "minimax" ? "adaptive" : "enabled"
            if let canDisable {
                // Only to models that can actually switch: Kimi K2.7 REJECTS
                // {type:"disabled"} and MiniMax M2.x ignores the field.
                if canDisable {
                    out["thinking"] = .object(["type": .string(effort != nil ? onType : "disabled")])
                }
            } else if effort != nil, thinkingObjectSwitches(provider: provider, id: id) {
                // Unknown caps: the on-state only, for the models known to
                // switch (never the off state — see above).
                out["thinking"] = .object(["type": .string(onType)])
            }
        }

        // Ask MiniMax for its reasoning in its own field rather than inline.
        if provider == "minimax" { out["reasoning_split"] = .bool(true) }
        return out
    }

    /// Providers whose docs define OpenAI's top-level `reasoning_effort`
    /// (`usesReasoningEffort` in compat-loop.ts).
    static func usesReasoningEffort(provider: String, id: String) -> Bool {
        switch provider {
        case "openai", "google", "deepseek", "xai", "mistral", "meta":
            return true
        case "zhipu":
            // GLM-5.2 takes it beside the thinking object; GLM-5.3 takes only it.
            return id.contains("glm-5.2") || id.contains("glm-5.3")
        case "moonshot":
            // Kimi K3 introduced a top-level reasoning_effort enum
            // (low|high|max) replacing the K2.x thinking object. Only K3 speaks
            // it; the K2.x line stays on the thinking-object path.
            return id.contains("k3")
        case "minimax":
            // MiniMax M3.1: the one MiniMax with reasoning_effort.
            return id.contains("m3.1")
        default:
            return false
        }
    }

    /// True for the models that run adaptive thinking when `thinking` is
    /// omitted, so `{"type": "adaptive"}` with no effort asks for exactly what
    /// omission would: Fable, Mythos, and Opus 5 / 5.5.
    static func thinksWhenOmitted(_ providerModelID: String) -> Bool {
        let id = providerModelID.lowercased()
        return id.contains("fable") || id.contains("mythos") || id.contains("opus-5")
    }

    /// Adaptive models that reason when `thinking` is omitted AND accept an
    /// off value, so Instant has to send one. Mirrors `adaptiveDefaultOn` in
    /// src/lib/anthropic-thinking.ts exactly: Opus 5 and Sonnet 5 (matched
    /// exactly — Opus 5.5 is always on and never reaches Instant), Sonnet 5.5,
    /// and Haiku 5.5, which thinks by default and takes `disabled` at effort
    /// high or below (thinking docs, 2026-10-10).
    static func adaptiveDefaultsOn(_ providerModelID: String) -> Bool {
        providerModelID.lowercased().range(
            of: #"(opus|sonnet)-5(?![-.]\d)|sonnet-5-5|haiku-5-5"#,
            options: .regularExpression
        ) != nil
    }

    /// True when the model expresses "don't think" as reasoning_effort:"none".
    ///
    /// Mirrors `canDisableViaNoneEffort` in src/lib/llm/compat-loop.ts.
    /// `canDisable` is the manifest's `reasoning.canDisable` (already gated on
    /// the model reasoning), or nil when the manifest has not described the
    /// model. The exclusions are the load-bearing part: gpt-5-pro always
    /// reasons, the original gpt-5 predates "none" (its floor is "minimal"), and
    /// sending the parameter to a Mistral model that does not expose it returns
    /// "reasoning_effort is not enabled for this model" — a 400 on every turn.
    static func canDisableViaNoneEffort(
        provider: String,
        id: String,
        canDisable: Bool?,
        reasoning: Bool? = nil
    ) -> Bool {
        switch provider {
        case "mistral", "google":
            // Mistral: only medium/small expose the parameter. Google's compat
            // shim accepts "none" on the models whose caps say so. Each is the
            // per-model caps answer, so an undescribed model gets nothing.
            return canDisable ?? false
        case "deepseek":
            // DeepSeek V4's documented off switch on Chat Completions is
            // `thinking: {type: "disabled"}`, not "none" (sent by
            // chatParameters, as compat-loop.ts does).
            return false
        case "openai":
            if id.range(of: #"gpt-5(\.\d)?-pro"#, options: .regularExpression) != nil { return false }
            // Codex and GPT-6 are split per snapshot; the caps carry each one's
            // enum. Without caps, only the snapshots the website verified by
            // name: GPT-6 Sol and Luna list "none", Astra and 6.1 Sol do not,
            // and Codex is left alone.
            if id.contains("codex") || id.contains("gpt-6") {
                if let canDisable { return canDisable }
                return id.range(of: #"gpt-6-(sol|luna)"#, options: .regularExpression) != nil
            }
            // 5.1+ only; the original gpt-5 predates "none". The website gates
            // this on `model.reasoning` alone, not on canDisable.
            return (reasoning ?? true)
                && id.range(of: #"gpt-5\.\d"#, options: .regularExpression) != nil
        default:
            return false
        }
    }

    /// Without the manifest's caps: whether a `thinking: {type}` provider's
    /// model is known to take the switch at all. Kimi K2.7 *rejects*
    /// `{type: "disabled"}` and MiniMax M2.x silently ignores the field — both
    /// always reason; K3 and MiniMax M3.1 are on the reasoning_effort path.
    static func thinkingObjectSwitches(provider: String, id: String) -> Bool {
        switch provider {
        case "minimax":
            return id.contains("m3") && !id.contains("m3.1")
        case "moonshot":
            return !id.contains("k3") && !id.contains("k2.7")
        case "mimo", "longcat":
            return true
        default:
            return false
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
        // GPT-5.3 Codex: low|medium|high|xhigh (model page) — no minimal, no max.
        if id.contains("codex") {
            if effort == .minimal { return ReasoningEffort.low.rawValue }
            if effort == .max { return ReasoningEffort.xhigh.rawValue }
        }
        return effort.rawValue
    }
}
