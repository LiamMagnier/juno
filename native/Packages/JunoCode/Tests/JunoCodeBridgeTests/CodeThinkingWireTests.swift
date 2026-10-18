import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeBridge

/// Locks the provider matrix that turns a chosen depth into wire parameters.
///
/// These assertions are the Swift half of a contract whose other half lives on
/// the website (`src/lib/anthropic-thinking.ts`, `src/lib/openai-compat.ts`),
/// where each value was verified against the live provider. The shapes are not
/// interchangeable — Anthropic 400s on the wrong `thinking.type`, and a
/// `reasoning_effort` sent to a lab that does not define it is ignored at best.
final class CodeThinkingWireTests: XCTestCase {

    private func request(
        model: String,
        effort: ReasoningEffort?
    ) -> ModelTurnRequest {
        ModelTurnRequest(
            sessionID: CodeSessionID(),
            systemPrompt: "system",
            messages: [.user("hello")],
            tools: [],
            modelID: model,
            reasoningEffort: effort
        )
    }

    private func object(_ value: JSONValue) -> [String: JSONValue] {
        value.objectValue ?? [:]
    }

    // MARK: - The regression this whole file exists for

    /// Kimi K3 is the model the user reported: its published ladder is
    /// low/high/**max**, and Code could express none of that.
    func testKimiK3SendsTopLevelReasoningEffortIncludingMax() {
        let parameters = CodeThinkingWire.chatParameters(
            providerID: "moonshot",
            providerModelID: "kimi-k3",
            effort: .max
        )
        XCTAssertEqual(parameters["reasoning_effort"], .string("max"))
        // K3 replaced the K2.x thinking object; sending both is wrong.
        XCTAssertNil(parameters["thinking"])
    }

    /// The K2.x line keeps the older dialect, and K2.7 takes no switch at all
    /// because it *rejects* `{type: "disabled"}` and always reasons.
    func testKimiK2LineUsesTheThinkingObjectAndK27SendsNothing() {
        let k26 = CodeThinkingWire.chatParameters(
            providerID: "moonshot",
            providerModelID: "kimi-k2.6",
            effort: .high
        )
        XCTAssertEqual(k26["thinking"], .object(["type": .string("enabled")]))
        XCTAssertNil(k26["reasoning_effort"])

        let k27 = CodeThinkingWire.chatParameters(
            providerID: "moonshot",
            providerModelID: "kimi-k2.7-code",
            effort: .high
        )
        XCTAssertTrue(k27.isEmpty)
    }

    /// Before this layer existed the chat path sent no reasoning parameter of any
    /// kind, so the Thinking control was inert for every OpenAI-compatible lab.
    func testTheChatBodyActuallyCarriesTheDepth() {
        let body = OpenAIChatRequestBuilder.body(
            for: request(model: "moonshot:kimi-k3", effort: .max),
            providerModelID: "kimi-k3",
            providerID: "moonshot",
            maxTokens: 8_192
        )
        XCTAssertEqual(object(body)["reasoning_effort"], .string("max"))
    }

    // MARK: - Token accounting

    /// The usage-only chunk must not be dropped.
    ///
    /// `stream_options.include_usage` makes every OpenAI-compatible provider send a
    /// final chunk whose `choices` array is **empty** and whose only payload is
    /// `usage`. The decoder guarded on a first choice before reading anything, so
    /// the one chunk carrying the token accounting was discarded on every provider —
    /// which is why a context meter was impossible to build.
    func testAUsageOnlyChatChunkIsDecoded() throws {
        var decoder = OpenAIChatStreamDecoder()
        let chunk = Data(#"{"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56}}"#.utf8)
        let events = try decoder.events(from: chunk)
        guard case let .usage(input, output)? = events.first else {
            return XCTFail("expected a usage event, got \(events)")
        }
        XCTAssertEqual(input, 1_234)
        XCTAssertEqual(output, 56)
    }

    /// Anthropic reports the prompt size on `message_start`, which the decoder used
    /// to discard along with `ping`.
    func testAnthropicMessageStartReportsThePromptSize() throws {
        var decoder = AnthropicStreamDecoder()
        let chunk = Data(#"{"type":"message_start","message":{"usage":{"input_tokens":4096}}}"#.utf8)
        let events = try decoder.events(from: chunk)
        guard case let .usage(input, _)? = events.first else {
            return XCTFail("expected a usage event, got \(events)")
        }
        XCTAssertEqual(input, 4_096)
    }

    /// A ping still carries nothing, so the split did not turn keepalives into events.
    func testAPingStillProducesNothing() throws {
        var decoder = AnthropicStreamDecoder()
        XCTAssertTrue(try decoder.events(from: Data(#"{"type":"ping"}"#.utf8)).isEmpty)
    }

    // MARK: - No depth means no parameter

    /// The failure mode this optionality exists to prevent.
    ///
    /// Mistral's large/codestral/ministral/devstral/magistral models publish no
    /// tiers and *reject* the parameter — `reasoning_effort is not enabled for this
    /// model` is a 400, so sending a default failed every turn rather than
    /// thinking at the wrong depth. Same for the non-reasoning OpenAI snapshots
    /// and the non-thinking Qwen models.
    func testNoDepthSendsNoChatParameterAtAll() {
        for (provider, model) in [
            ("mistral", "codestral-latest"),
            ("mistral", "magistral-medium-2509"),
            ("openai", "gpt-4o"),
            ("qwen", "qwen-long"),
            ("qwen", "qwen3-coder-plus"),
            ("google", "gemini-3-flash-preview"),
            ("deepseek", "deepseek-chat"),
            ("xai", "grok-build"),
            ("zhipu", "glm-4.7"),
            ("moonshot", "kimi-k3"),
        ] {
            XCTAssertTrue(
                CodeThinkingWire.chatParameters(
                    providerID: provider,
                    providerModelID: model,
                    effort: nil
                ).isEmpty,
                "\(provider)/\(model) must receive no thinking parameter"
            )
        }
    }

    /// Anthropic gets no `output_config` and the ceiling is left alone — the
    /// headroom only exists to pay for thinking tokens.
    ///
    /// `thinking` is the exception, and used to be asserted nil here. Sonnet 5
    /// is adaptive and reasons when the field is OMITTED, so "no thinking" has
    /// to be said out loud or the user pays for reasoning they turned off.
    func testNoDepthDisablesAdaptiveThinkingAndDoesNotRaiseTheCeiling() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192,
            effort: nil
        )
        XCTAssertEqual(bits.thinking, .object(["type": .string("disabled")]))
        XCTAssertNil(bits.outputConfig)
        XCTAssertEqual(bits.maxTokens, 8_192)
    }

    /// Opus 5 also defaults thinking ON (Anthropic's per-model table), and
    /// Sonnet 5.5 rejects `disabled` outright: its off switch is
    /// `between_tools`.
    func testDefaultOnModelsGetTheOffValueTheyAccept() {
        let opus5 = CodeThinkingWire.anthropicBits(providerModelID: "claude-opus-5", maxTokens: 8_192, effort: nil)
        XCTAssertEqual(opus5.thinking, .object(["type": .string("disabled")]))
        let sonnet55 = CodeThinkingWire.anthropicBits(providerModelID: "claude-sonnet-5-5", maxTokens: 8_192, effort: nil)
        XCTAssertEqual(sonnet55.thinking, .object(["type": .string("between_tools")]))
    }

    /// Only the models that reason by default get an explicit disable. Opus
    /// 4.7/4.8 default OFF when omitted, and Fable/Mythos/Opus 5.5 are
    /// always-on and REJECT `disabled` — sending it would 400 them.
    func testOnlyDefaultOnAdaptiveModelsAreExplicitlyDisabled() {
        XCTAssertNil(
            CodeThinkingWire.anthropicBits(
                providerModelID: "claude-opus-4-8", maxTokens: 8_192, effort: nil
            ).thinking
        )
        // The always-on models are sent adaptive at the API's own default
        // effort, as the website does — never `disabled`.
        for model in ["claude-fable-5", "claude-mythos-1", "claude-opus-5-5"] {
            let bits = CodeThinkingWire.anthropicBits(providerModelID: model, maxTokens: 8_192, effort: nil)
            XCTAssertEqual(bits.thinking?["type"], .string("adaptive"), "\(model) must not be sent an explicit disable")
        }
        // Manual-thinking families were never affected: omitting `thinking` is
        // genuinely off for them.
        XCTAssertNil(
            CodeThinkingWire.anthropicBits(
                providerModelID: "claude-haiku-4-5", maxTokens: 8_192, effort: nil
            ).thinking
        )
    }

    /// GPT-5.5/5.6 default to `medium` when reasoning_effort is absent, so "Off"
    /// has to be sent as "none" rather than omitted.
    func testNoDepthSendsNoneToTheOpenAIModelsThatDefaultToThinking() {
        for model in ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna"] {
            XCTAssertEqual(
                CodeThinkingWire.chatParameters(
                    providerID: "openai", providerModelID: model, effort: nil
                )["reasoning_effort"],
                .string("none"),
                "\(model) must be told not to think"
            )
        }
        // gpt-5-pro always reasons and the original gpt-5 predates "none";
        // sending it to either is a 400, not a faster answer.
        // GPT-6 Astra publishes no "none" at all.
        for model in ["gpt-5-pro", "gpt-5", "gpt-4o", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.3-codex"] {
            XCTAssertTrue(
                CodeThinkingWire.chatParameters(
                    providerID: "openai", providerModelID: model, effort: nil
                ).isEmpty,
                "\(model) must receive nothing"
            )
        }
    }

    /// The Responses body omits the whole `reasoning` object.
    func testNoDepthOmitsTheResponsesReasoningObject() {
        XCTAssertNil(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.6", effort: nil)
        )
        let body = OpenAIResponsesRequestBuilder.body(
            for: request(model: "openai:gpt-4o", effort: nil),
            providerModelID: "gpt-4o",
            maxTokens: 8_192
        )
        XCTAssertNil(object(body)["reasoning"])
    }

    func testNoDepthLeavesTheChatAndAnthropicBodiesClean() {
        let chat = OpenAIChatRequestBuilder.body(
            for: request(model: "mistral:codestral-latest", effort: nil),
            providerModelID: "codestral-latest",
            providerID: "mistral",
            maxTokens: 8_192
        )
        XCTAssertNil(object(chat)["reasoning_effort"])
        XCTAssertNil(object(chat)["thinking"])
        XCTAssertNil(object(chat)["enable_thinking"])

        let anthropic = AnthropicRequestBuilder.body(
            for: request(model: "anthropic:claude-haiku-4-5", effort: nil),
            providerModelID: "claude-haiku-4-5",
            maxTokens: 8_192
        )
        XCTAssertNil(object(anthropic)["thinking"])
        XCTAssertNil(object(anthropic)["output_config"])
    }

    // MARK: - Per-provider dialects

    func testQwenUsesEnableThinkingAndABudgetRatherThanAnEnum() {
        let parameters = CodeThinkingWire.chatParameters(
            providerID: "qwen",
            providerModelID: "qwen3.7-plus",
            effort: .high
        )
        XCTAssertEqual(parameters["enable_thinking"], .bool(true))
        XCTAssertEqual(parameters["thinking_budget"], .number(24_000))
        // Sending both would be redundant or rejected.
        XCTAssertNil(parameters["reasoning_effort"])
    }

    func testGLM52TakesBothTheObjectAndTheEffortButOtherGLMsOnlyTheObject() {
        let glm52 = CodeThinkingWire.chatParameters(
            providerID: "zhipu",
            providerModelID: "glm-5.2",
            effort: .xhigh
        )
        XCTAssertEqual(glm52["reasoning_effort"], .string("xhigh"))
        XCTAssertEqual(glm52["thinking"], .object(["type": .string("enabled")]))

        let glm47 = CodeThinkingWire.chatParameters(
            providerID: "zhipu",
            providerModelID: "glm-4.7",
            effort: .high
        )
        XCTAssertNil(glm47["reasoning_effort"])
        XCTAssertEqual(glm47["thinking"], .object(["type": .string("enabled")]))
    }

    func testMistralCollapsesEveryDepthToHigh() {
        // Mistral's enum is high|none — "max" is a documented 400.
        for effort in [ReasoningEffort.minimal, .low, .medium, .high, .xhigh, .max] {
            let parameters = CodeThinkingWire.chatParameters(
                providerID: "mistral",
                providerModelID: "mistral-medium-latest",
                effort: effort
            )
            XCTAssertEqual(parameters["reasoning_effort"], .string("high"))
        }
    }

    func testMiniMaxM3SpellsItsOnStateAdaptiveAndSplitsReasoning() {
        let m3 = CodeThinkingWire.chatParameters(
            providerID: "minimax",
            providerModelID: "minimax-m3",
            effort: .high
        )
        XCTAssertEqual(m3["thinking"], .object(["type": .string("adaptive")]))
        XCTAssertEqual(m3["reasoning_split"], .bool(true))

        // M2.x ignores the field entirely — it always reasons.
        let m2 = CodeThinkingWire.chatParameters(
            providerID: "minimax",
            providerModelID: "minimax-m2.1",
            effort: .high
        )
        XCTAssertNil(m2["thinking"])
    }

    /// A lab with no documented control gets nothing rather than a guess.
    func testAnUnknownProviderSendsNoThinkingParameters() {
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(
                providerID: "someone-new",
                providerModelID: "their-model",
                effort: .high
            ).isEmpty
        )
    }

    // MARK: - Anthropic: two shapes, and the wrong one is a 400

    func testAdaptiveModelsSendAdaptivePlusOutputConfigEffort() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192,
            effort: .xhigh
        )
        XCTAssertEqual(
            bits.outputConfig,
            .object(["effort": .string("xhigh")])
        )
        // Sonnet 5 is in the summarized-display set, so reasoning can stream.
        XCTAssertEqual(
            bits.thinking,
            .object([
                "type": .string("adaptive"),
                "display": .string("summarized"),
            ])
        )
        // Headroom is added so thinking does not buy depth by truncating the
        // answer: 8192 + 48000 for xhigh, under the 128k adaptive cap.
        XCTAssertEqual(bits.maxTokens, 8_192 + 48_000)
    }

    func testManualModelsSendEnabledWithABudgetAndNeverOutputConfig() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-opus-4-5",
            maxTokens: 8_192,
            effort: .high
        )
        XCTAssertNil(bits.outputConfig, "adaptive is rejected on this family")
        guard let thinking = bits.thinking?.objectValue else {
            return XCTFail("expected a thinking object")
        }
        XCTAssertEqual(thinking["type"], .string("enabled"))
        // budget_tokens must be >= 1024 and leave the answer at least a quarter
        // of the window.
        guard let budget = thinking["budget_tokens"]?.intValue else {
            return XCTFail("expected a budget")
        }
        XCTAssertGreaterThanOrEqual(budget, 1_024)
        XCTAssertLessThan(budget, bits.maxTokens)
        XCTAssertLessThanOrEqual(budget, bits.maxTokens - bits.maxTokens / 4)
    }

    /// Haiku is absent from Anthropic's effort-supported list entirely, and
    /// "claude-opus-4-5" must not be caught by a broad adaptive pattern.
    func testManualFamiliesAreMatchedBeforeTheAdaptiveDefault() {
        XCTAssertEqual(
            CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-haiku-4-5"),
            .manual
        )
        XCTAssertEqual(
            CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-sonnet-4-5"),
            .manual
        )
        XCTAssertEqual(
            CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-opus-4-7"),
            .adaptive
        )
        // An unrecognised future id prefers adaptive, because manual is what
        // 400s on new models.
        XCTAssertEqual(
            CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-opus-9"),
            .adaptive
        )
    }

    // MARK: - Claude Haiku 5.5 (the owner's report)

    /// Haiku 5.5 is adaptive-only: `type: "enabled"` is a 400 on it. It used to
    /// be caught by a bare "haiku" match and sent the manual shape.
    func testHaiku55IsAdaptiveAndHaiku45StaysManual() {
        XCTAssertEqual(CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-haiku-5-5"), .adaptive)
        XCTAssertEqual(CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-haiku-4-5"), .manual)
        XCTAssertEqual(CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-haiku-4-5-20251001"), .manual)
        XCTAssertEqual(CodeThinkingWire.anthropicThinkingKind(providerModelID: "claude-3-haiku-20240307"), .manual)
    }

    /// Every depth Haiku 5.5 publishes goes out as adaptive + output_config,
    /// with the summarized display (it defaults to omitted) and the 128k
    /// adaptive output cap.
    func testHaiku55SendsAdaptiveAtEveryEffort() {
        let headroom: [ReasoningEffort: Int] = [.low: 8_192, .medium: 16_384, .high: 32_000, .xhigh: 48_000, .max: 56_000]
        for effort in [ReasoningEffort.low, .medium, .high, .xhigh, .max] {
            let body = AnthropicRequestBuilder.body(
                for: request(model: "anthropic:claude-haiku-5-5", effort: effort),
                providerModelID: "claude-haiku-5-5",
                maxTokens: 8_192
            )
            let fields = object(body)
            XCTAssertEqual(
                fields["thinking"],
                .object([
                    "type": .string("adaptive"),
                    "display": .string("summarized"),
                    "block_binding": .object(["prefix_mismatch_behavior": .string("drop_block")]),
                ]),
                "\(effort)"
            )
            XCTAssertEqual(fields["output_config"], .object(["effort": .string(effort.rawValue)]), "\(effort)")
            XCTAssertEqual(fields["max_tokens"], .number(Double(8_192 + headroom[effort]!)), "\(effort)")
        }
        // The 128k cap applies, not Haiku 4.5's 64k.
        let big = CodeThinkingWire.anthropicBits(providerModelID: "claude-haiku-5-5", maxTokens: 128_000, effort: .max)
        XCTAssertEqual(big.maxTokens, 128_000)
    }

    /// Haiku 5.5 thinks by default, so Instant must say `disabled` (accepted at
    /// effort high or below; Instant sends no effort, so the API default
    /// medium applies).
    func testHaiku55InstantSendsDisabledAndNoEffort() {
        let body = AnthropicRequestBuilder.body(
            for: request(model: "anthropic:claude-haiku-5-5", effort: nil),
            providerModelID: "claude-haiku-5-5",
            maxTokens: 8_192
        )
        let fields = object(body)
        XCTAssertEqual(fields["thinking"], .object(["type": .string("disabled")]))
        XCTAssertNil(fields["output_config"])
        XCTAssertEqual(fields["max_tokens"], .number(8_192))
    }

    func testHaiku45SendsTheManualBudget() {
        let bits = CodeThinkingWire.anthropicBits(providerModelID: "claude-haiku-4-5", maxTokens: 8_192, effort: .high)
        XCTAssertEqual(bits.thinking, .object(["type": .string("enabled"), "budget_tokens": .number(16_000)]))
        XCTAssertNil(bits.outputConfig)
        XCTAssertEqual(bits.maxTokens, 8_192 + 16_000)
    }

    func testSonnet55InstantSendsBetweenTools() {
        let body = AnthropicRequestBuilder.body(
            for: request(model: "anthropic:claude-sonnet-5-5", effort: nil),
            providerModelID: "claude-sonnet-5-5",
            maxTokens: 8_192
        )
        XCTAssertEqual(object(body)["thinking"], .object(["type": .string("between_tools")]))
        XCTAssertNil(object(body)["output_config"])
    }

    /// Opus 5.5 is always on: no effort means adaptive at its API default
    /// (medium), said explicitly; Fable's default is high.
    func testAlwaysOnModelsWithNoEffortRunAtTheirAPIDefault() {
        let opus = CodeThinkingWire.anthropicBits(providerModelID: "claude-opus-5-5", maxTokens: 8_192, effort: nil)
        XCTAssertEqual(opus.thinking, .object(["type": .string("adaptive"), "display": .string("summarized")]))
        XCTAssertEqual(opus.outputConfig, .object(["effort": .string("medium")]))
        XCTAssertEqual(opus.maxTokens, 8_192 + 16_384)

        let fable = CodeThinkingWire.anthropicBits(providerModelID: "claude-fable-5-1", maxTokens: 8_192, effort: nil)
        XCTAssertEqual(fable.outputConfig, .object(["effort": .string("high")]))
    }

    /// The default-on set is the website's regex exactly.
    func testDefaultOnSetMatchesTheWebsite() {
        for id in ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
            XCTAssertTrue(CodeThinkingWire.adaptiveDefaultsOn(id), id)
        }
        for id in ["claude-opus-5-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] {
            XCTAssertFalse(CodeThinkingWire.adaptiveDefaultsOn(id), id)
        }
    }

    // MARK: - Fitting a stored depth to the model (manifest caps)

    private let haiku55Caps = CodeReasoningCaps(
        supported: true, canDisable: true,
        tiers: [.low, .medium, .high, .xhigh, .max], defaultEffort: .medium
    )

    /// GPT's `minimal` carried to Haiku 5.5 resets to its declared default.
    func testAStoredForeignDepthIsFittedBeforeTheBodyIsBuilt() {
        let fitted = BackendCodeModelClient.fittingReasoning(
            request(model: "anthropic:claude-haiku-5-5", effort: .minimal),
            caps: haiku55Caps
        )
        XCTAssertEqual(fitted.reasoningEffort, .medium)
        XCTAssertEqual(
            BackendCodeModelClient.fittingReasoning(request(model: "x", effort: .minimal), caps: nil).reasoningEffort,
            .minimal,
            "no caps, no change"
        )
    }

    func testCapsClampMirrorsTheWebsite() {
        XCTAssertNil(haiku55Caps.clamp(nil))
        XCTAssertEqual(haiku55Caps.clamp(.xhigh), .xhigh)
        let onOff = CodeReasoningCaps(supported: true, canDisable: true, onOffOnly: true)
        XCTAssertEqual(onOff.clamp(.low), .high)
        XCTAssertNil(onOff.clamp(nil))
        let alwaysOn = CodeReasoningCaps(supported: true, canDisable: false, tiers: [.low, .high, .max], defaultEffort: .max)
        XCTAssertEqual(alwaysOn.clamp(nil), .max)
        XCTAssertEqual(alwaysOn.clamp(.medium), .max)
        let noControl = CodeReasoningCaps(supported: true, canDisable: false)
        XCTAssertNil(noControl.clamp(.high))
        XCTAssertNil(CodeReasoningCaps(supported: false, canDisable: false).clamp(.high))
    }

    func testTheRegistryIsReadByCanonicalIdOrRoute() {
        let registry = CodeReasoningCapsRegistry()
        registry.replace(["anthropic:claude-haiku-5-5": haiku55Caps])
        XCTAssertEqual(
            BackendCodeModelClient.reasoningCaps(
                for: "anthropic:claude-haiku-5-5", resolver: .default, registry: registry
            ),
            haiku55Caps
        )
        XCTAssertEqual(
            BackendCodeModelClient.reasoningCaps(for: "claude-haiku-5-5", resolver: .default, registry: registry),
            haiku55Caps,
            "a bare Claude id resolves to the same entry"
        )
        XCTAssertNil(BackendCodeModelClient.reasoningCaps(for: "openai:gpt-5.6", resolver: .default, registry: registry))
    }

    // MARK: - OpenAI-compatible: compatReasoningFields parity

    private func caps(_ canDisable: Bool, supported: Bool = true) -> CodeReasoningCaps {
        CodeReasoningCaps(supported: supported, canDisable: canDisable)
    }

    func testQwen38TakesEnableThinkingAndReasoningEffortNotABudget() {
        let on = CodeThinkingWire.chatParameters(
            providerID: "qwen", providerModelID: "qwen3.8-max", effort: .xhigh, caps: caps(true)
        )
        XCTAssertEqual(on, ["enable_thinking": .bool(true), "reasoning_effort": .string("xhigh")])
        let instant = CodeThinkingWire.chatParameters(
            providerID: "qwen", providerModelID: "qwen3.8-max", effort: nil, caps: caps(true)
        )
        XCTAssertEqual(instant, ["enable_thinking": .bool(false)])
        // Unknown caps: still the 3.8 spelling, never the off state.
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "qwen", providerModelID: "qwen3.8-flash", effort: .low),
            ["enable_thinking": .bool(true), "reasoning_effort": .string("low")]
        )
        XCTAssertTrue(CodeThinkingWire.chatParameters(providerID: "qwen", providerModelID: "qwen3.8-max", effort: nil).isEmpty)
    }

    func testQwenThinkingOnlyModelAlwaysGetsItOn() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "qwen", providerModelID: "qwq-plus", effort: nil, caps: caps(false)),
            ["enable_thinking": .bool(true), "thinking_budget": .number(24_000)]
        )
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(
                providerID: "qwen", providerModelID: "qwen-long", effort: nil, caps: caps(false, supported: false)
            ).isEmpty
        )
    }

    func testGLM53TakesReasoningEffortOnlyAndNeverAThinkingObject() {
        for effort in [ReasoningEffort.low, .high, .max] {
            XCTAssertEqual(
                CodeThinkingWire.chatParameters(providerID: "zhipu", providerModelID: "glm-5.3", effort: effort, caps: caps(false)),
                ["reasoning_effort": .string(effort.rawValue)]
            )
        }
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "zhipu", providerModelID: "glm-5.3", effort: nil, caps: caps(false)).isEmpty
        )
    }

    func testGLMOnOffInstantSendsDisabledOnlyWithCaps() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "zhipu", providerModelID: "glm-4.7", effort: nil, caps: caps(true)),
            ["thinking": .object(["type": .string("disabled")])]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "zhipu", providerModelID: "glm-5.2", effort: nil, caps: caps(true)),
            ["thinking": .object(["type": .string("disabled")])]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "zhipu", providerModelID: "glm-5.2", effort: .max, caps: caps(true)),
            ["reasoning_effort": .string("max"), "thinking": .object(["type": .string("enabled")])]
        )
    }

    func testMetaAndMiniMaxM31TakeReasoningEffort() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "meta", providerModelID: "muse-spark-1.3", effort: .xhigh, caps: caps(false)),
            ["reasoning_effort": .string("xhigh")]
        )
        let m31 = CodeThinkingWire.chatParameters(
            providerID: "minimax", providerModelID: "minimax-m3.1-flash-preview", effort: .max, caps: caps(false)
        )
        XCTAssertEqual(m31, ["reasoning_effort": .string("max"), "reasoning_split": .bool(true)])
        // Without caps M3.1 still gets no thinking object.
        XCTAssertNil(
            CodeThinkingWire.chatParameters(providerID: "minimax", providerModelID: "minimax-m3.1-flash-preview", effort: .max)["thinking"]
        )
    }

    /// DeepSeek V4's off switch is the thinking object, not "none"
    /// (compat-loop.ts, guides/thinking_mode 2026-10-18).
    func testDeepSeekV4InstantDisablesThinkingWithCaps() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "deepseek", providerModelID: "deepseek-v4-pro", effort: nil, caps: caps(true)),
            ["thinking": .object(["type": .string("disabled")])]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "deepseek", providerModelID: "deepseek-v4-pro", effort: .max, caps: caps(true)),
            ["reasoning_effort": .string("max")]
        )
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "deepseek", providerModelID: "deepseek-v4-pro", effort: nil).isEmpty,
            "no caps, no off switch"
        )
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "deepseek", providerModelID: "deepseek-reasoner", effort: nil, caps: caps(false)).isEmpty
        )
    }

    func testGoogleAndMistralInstantFollowTheCaps() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "google", providerModelID: "gemini-3.1-flash-lite", effort: nil, caps: caps(true)),
            ["reasoning_effort": .string("none")]
        )
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "google", providerModelID: "gemini-3.7-flash", effort: nil, caps: caps(false)).isEmpty
        )
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "mistral", providerModelID: "magistral-medium-2509", effort: nil, caps: caps(false)).isEmpty
        )
    }

    func testThinkingObjectLabsSwitchOnlyWhereTheCapsSayCanDisable() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "moonshot", providerModelID: "kimi-k2.6", effort: nil, caps: caps(true)),
            ["thinking": .object(["type": .string("disabled")])]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "minimax", providerModelID: "minimax-m3", effort: nil, caps: caps(true)),
            ["thinking": .object(["type": .string("disabled")]), "reasoning_split": .bool(true)]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "mimo", providerModelID: "mimo-v2.5", effort: .high, caps: caps(true)),
            ["thinking": .object(["type": .string("enabled")])]
        )
        // Kimi K2.7 rejects disabled: always reasons, nothing sent.
        XCTAssertTrue(
            CodeThinkingWire.chatParameters(providerID: "moonshot", providerModelID: "kimi-k2.7-code", effort: nil, caps: caps(false)).isEmpty
        )
    }

    func testOpenAIInstantNoneFollowsTheCapsOnSplitLines() {
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "openai", providerModelID: "gpt-6-astra", effort: nil, caps: caps(false)),
            [:]
        )
        XCTAssertEqual(
            CodeThinkingWire.chatParameters(providerID: "openai", providerModelID: "gpt-5.6", effort: nil, caps: caps(true)),
            ["reasoning_effort": .string("none")]
        )
    }

    /// Anthropic publishes no `minimal`, so it has to be mapped rather than sent.
    func testMinimalIsMappedToLowForAnthropic() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192,
            effort: .minimal
        )
        XCTAssertEqual(bits.outputConfig, .object(["effort": .string("low")]))
    }

    func testTheAnthropicBodyCarriesThinkingAndTheAdjustedCeiling() {
        let body = AnthropicRequestBuilder.body(
            for: request(model: "anthropic:claude-sonnet-5", effort: .max),
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192
        )
        let fields = object(body)
        XCTAssertNotNil(fields["thinking"])
        XCTAssertEqual(fields["output_config"], .object(["effort": .string("max")]))
        XCTAssertEqual(fields["max_tokens"], .number(Double(8_192 + 56_000)))
    }

    /// Legacy families cap output far lower, and the cap must win over headroom.
    func testTheOutputCapClampsTheHeadroom() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-3-5-sonnet",
            maxTokens: 8_192,
            effort: .max
        )
        XCTAssertEqual(bits.maxTokens, 32_000)
    }

    // MARK: - OpenAI Responses

    /// The Pro snapshots accept only medium|high|xhigh; anything shallower 400s.
    func testProSnapshotsFloorTheEffort() {
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.4-pro", effort: .low),
            "medium"
        )
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.4-pro", effort: .max),
            "xhigh"
        )
    }

    func testCodexHasNoMinimal() {
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(
                providerModelID: "gpt-5.3-codex",
                effort: .minimal
            ),
            "low"
        )
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.3-codex", effort: .max),
            "xhigh"
        )
    }

    func testAnOrdinaryResponsesModelRelaysTheDepthUnchanged() {
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.6", effort: .max),
            "max"
        )
    }
}
