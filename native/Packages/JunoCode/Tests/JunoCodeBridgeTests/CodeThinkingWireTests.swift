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

    /// Anthropic gets neither `thinking` nor `output_config`, and the ceiling is
    /// left alone — the headroom only exists to pay for thinking tokens.
    func testNoDepthSendsNoAnthropicThinkingAndDoesNotRaiseTheCeiling() {
        let bits = CodeThinkingWire.anthropicBits(
            providerModelID: "claude-sonnet-5",
            maxTokens: 8_192,
            effort: nil
        )
        XCTAssertNil(bits.thinking)
        XCTAssertNil(bits.outputConfig)
        XCTAssertEqual(bits.maxTokens, 8_192)
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
    }

    func testAnOrdinaryResponsesModelRelaysTheDepthUnchanged() {
        XCTAssertEqual(
            CodeThinkingWire.responsesEffort(providerModelID: "gpt-5.6", effort: .max),
            "max"
        )
    }
}
