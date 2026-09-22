import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// The model-written summary on its own: what it is asked, what it accepts,
/// and every way it can fail without failing anything else.
final class CompactionSummarizerTests: XCTestCase {
    private let sessionID = CodeSessionID()

    /// A request, a long stretch of tool work with reasoning between calls,
    /// and a follow-up — the shape a long run actually has.
    private func longRun(steps: Int = 12) -> [ModelMessage] {
        var messages: [ModelMessage] = [.user("Refactor the parser so errors carry line numbers")]
        for step in 0..<steps {
            messages.append(.assistantThinking(text: "private reasoning \(step)", signature: "sig-\(step)"))
            messages.append(.assistant("Step \(step): reading two files."))
            messages.append(.toolCall(id: "a\(step)", name: "read_file", input: ["path": .string("Sources/P\(step).swift")]))
            messages.append(.toolCall(id: "b\(step)", name: "grep", input: ["pattern": .string("throw\(step)")]))
            messages.append(.toolResult(id: "a\(step)", content: "file \(step) contents", isError: false))
            messages.append(.toolResult(id: "b\(step)", content: "no match \(step)", isError: step == 3))
        }
        messages.append(.user("Also keep the old error type public"))
        messages.append(.assistant("Keeping ParserError public."))
        return messages
    }

    private func plan(_ messages: [ModelMessage], recentTurns: Int = 2) throws -> ConversationCompactionPlan {
        try XCTUnwrap(
            ConversationCompactor.plan(messages, maximumBytes: 1, recentTurns: recentTurns, force: true)
        )
    }

    private func summaryEvents(
        _ text: String,
        input: Int? = 1_200,
        output: Int? = 180,
        stop: ModelStopReason = .endTurn
    ) -> [ModelStreamEvent] {
        [
            .usage(inputTokens: input, outputTokens: nil),
            .textDelta("<summary>\n"),
            .textDelta(text),
            .textDelta("\n</summary>"),
            .usage(inputTokens: nil, outputTokens: output),
            .turnCompleted(stop),
        ]
    }

    private func summarize(
        _ plan: ConversationCompactionPlan,
        model: ScriptedModelClient,
        focus: String? = nil,
        limits: CompactionSummarizer.Limits = .standard
    ) async -> CompactionSummarizer.Attempt {
        await CompactionSummarizer.summarize(
            plan: plan,
            focus: focus,
            model: model,
            sessionID: sessionID,
            modelID: "anthropic:claude-sonnet-5",
            limits: limits
        )
    }

    // MARK: - Success

    func testTheModelSummaryReplacesTheFoldedSpanAndKeepsTheRecentStepsWhole() async throws {
        let messages = longRun()
        let plan = try plan(messages)
        let model = ScriptedModelClient(steps: [
            .events(summaryEvents("**Requests and intent.** Line numbers on parser errors.")),
        ])

        let attempt = await summarize(plan, model: model)

        XCTAssertNil(attempt.failure)
        XCTAssertEqual(attempt.summary, "**Requests and intent.** Line numbers on parser errors.")
        let result = plan.result(modelSummary: try XCTUnwrap(attempt.summary))
        guard case let .user(anchor) = result.messages.first else { return XCTFail("anchor") }
        XCTAssertTrue(anchor.hasPrefix("Refactor the parser so errors carry line numbers"))
        XCTAssertTrue(anchor.contains(ConversationCompactor.retainedContextMarker))
        XCTAssertTrue(anchor.contains("Line numbers on parser errors."))
        XCTAssertFalse(anchor.contains(ConversationCompactor.structuralHeader))
        XCTAssertEqual(Array(result.messages.dropFirst()), plan.recent)
        XCTAssertEqual(result.removedMessageCount, plan.structural.removedMessageCount)
        XCTAssertTrue(ConversationIntegrity.isValid(result.messages))
    }

    func testTheRequestIsASideCallWithNoToolsAndABoundedReply() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.events(summaryEvents("Done."))])
        var limits = CompactionSummarizer.Limits.standard
        limits.maximumOutputTokens = 3_000

        _ = await summarize(plan, model: model, limits: limits)

        let request = try XCTUnwrap(model.receivedRequests.first)
        XCTAssertEqual(model.receivedRequests.count, 1)
        XCTAssertTrue(request.tools.isEmpty)
        XCTAssertNil(request.reasoningEffort)
        XCTAssertEqual(request.maximumOutputTokens, 3_000)
        XCTAssertEqual(request.modelID, "anthropic:claude-sonnet-5")
        XCTAssertEqual(request.sessionID, sessionID)
        XCTAssertEqual(request.systemPrompt, CompactionSummarizer.systemPrompt)
        guard request.messages.count == 1, case let .user(prompt) = request.messages[0] else {
            return XCTFail("the summary request is one plain user message")
        }
        // The folded span is there, as text…
        XCTAssertTrue(prompt.contains("Tool call read_file"))
        XCTAssertTrue(prompt.contains("Sources/P0.swift"))
        XCTAssertTrue(prompt.contains("Tool error:\nno match 3"))
        // …the private reasoning is not…
        XCTAssertFalse(prompt.contains("private reasoning"))
        XCTAssertFalse(prompt.contains("sig-0"))
        // …and neither are the steps kept verbatim after the summary.
        XCTAssertFalse(prompt.contains("Keeping ParserError public."))
        for heading in ["Requests and intent", "Key decisions", "Files and code", "Errors and fixes",
                        "Open tasks", "Current work", "Next step"] {
            XCTAssertTrue(prompt.contains(heading), heading)
        }
        XCTAssertTrue(prompt.contains("<summary>"))
    }

    func testFocusInstructionsReachTheRequest() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.events(summaryEvents("Done."))])

        _ = await summarize(plan, model: model, focus: "  the error-type decisions  ")

        guard case let .user(prompt) = model.receivedRequests.first?.messages.first else {
            return XCTFail("expected the summary request")
        }
        XCTAssertTrue(prompt.contains("focus on the following"))
        XCTAssertTrue(prompt.contains("the error-type decisions"))
    }

    func testAnEarlierSummaryIsFoldedIntoTheRequest() async throws {
        let first = try plan(longRun())
        let folded = first.result(modelSummary: "Earlier: the parser moved to a table.")
        let continued = folded.messages + [.user("Now the lexer"), .assistant("Reading the lexer.")]
        let second = try plan(continued, recentTurns: 1)
        XCTAssertEqual(
            second.earlierSummary,
            ConversationCompactor.modelSummaryHeader + "\nEarlier: the parser moved to a table."
        )
        let model = ScriptedModelClient(steps: [.events(summaryEvents("Both summaries, folded."))])

        _ = await summarize(second, model: model)

        guard case let .user(prompt) = model.receivedRequests.first?.messages.first else {
            return XCTFail("expected the summary request")
        }
        XCTAssertTrue(prompt.contains("<earlier-summary>"))
        XCTAssertTrue(prompt.contains("the parser moved to a table"))
        XCTAssertTrue(prompt.contains("Fold the earlier summary in"))
        // The new anchor carries one memory block, not two stacked.
        let result = second.result(modelSummary: "Both summaries, folded.")
        guard case let .user(anchor) = result.messages[0] else { return XCTFail("anchor") }
        XCTAssertEqual(anchor.components(separatedBy: ConversationCompactor.retainedContextMarker).count, 2)
        XCTAssertFalse(anchor.contains("the parser moved to a table"))
    }

    func testUsageIsReportedWithThePurposeOfTheCall() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.events(summaryEvents("Done.", input: 9_000, output: 400))])

        let attempt = await summarize(plan, model: model)

        XCTAssertEqual(
            attempt.usage,
            ModelCallUsage(purpose: .compactionSummary, inputTokens: 9_000, outputTokens: 400)
        )
    }

    func testAnOverlongSummaryIsCutAtALineRatherThanDiscarded() throws {
        let lines = (0..<400).map { "Line \($0) of a summary that ran long." }.joined(separator: "\n")
        let kept = try XCTUnwrap(
            CompactionSummarizer.extractSummary(
                from: "<summary>\n\(lines)\n</summary>",
                maximumCharacters: 1_000
            )
        )
        XCTAssertLessThanOrEqual(kept.count, 1_002)
        XCTAssertTrue(kept.hasPrefix("Line 0 of"))
        XCTAssertTrue(kept.hasSuffix("ran long.\n…"))
    }

    // MARK: - Every failure falls back

    func testATransportErrorIsAFailureNotAThrow() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [
            .failure(AgentModelClientError.transport(message: "503 overloaded")),
        ])

        let attempt = await summarize(plan, model: model)

        XCTAssertNil(attempt.summary)
        guard case .requestFailed = attempt.failure else {
            return XCTFail("expected a request failure, got \(String(describing: attempt.failure))")
        }
    }

    func testAHungModelTimesOutWithinTheLimit() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.neverFinishes])
        var limits = CompactionSummarizer.Limits.standard
        limits.timeout = .milliseconds(150)

        let started = ContinuousClock.now
        let attempt = await summarize(plan, model: model, limits: limits)

        XCTAssertEqual(attempt.failure, .timedOut)
        XCTAssertNil(attempt.summary)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
    }

    func testAnEmptyReplyIsNotASummary() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("   "), .turnCompleted(.endTurn)]),
        ])

        let attempt = await summarize(plan, model: model)

        XCTAssertEqual(attempt.failure, .noSummary)
    }

    func testARefusalIsNotASummary() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [
            .events([
                .usage(inputTokens: 800, outputTokens: 12),
                .textDelta("I can't help with that."),
                .turnCompleted(.endTurn),
            ]),
        ])

        let attempt = await summarize(plan, model: model)

        XCTAssertEqual(attempt.failure, .noSummary)
        // Billed all the same.
        XCTAssertEqual(attempt.usage.inputTokens, 800)
        XCTAssertEqual(attempt.usage.outputTokens, 12)
    }

    func testEmptyTagsAreNotASummary() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.events(summaryEvents("  "))])

        let attempt = await summarize(plan, model: model)

        XCTAssertEqual(attempt.failure, .noSummary)
    }

    func testAReplyCutOffByItsCeilingIsNotUsed() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [
            .events([.textDelta("<summary>\nRequests and intent: line num"), .turnCompleted(.maxTokens)]),
        ])

        let attempt = await summarize(plan, model: model)

        XCTAssertEqual(attempt.failure, .truncated)
    }

    func testCancellationEndsTheCallAndIsReportedAsSuch() async throws {
        let plan = try plan(longRun())
        let model = ScriptedModelClient(steps: [.neverFinishes])
        var limits = CompactionSummarizer.Limits.standard
        limits.timeout = .seconds(60)
        let sessionID = self.sessionID

        let task = Task {
            await CompactionSummarizer.summarize(
                plan: plan,
                focus: nil,
                model: model,
                sessionID: sessionID,
                modelID: "m",
                limits: limits
            )
        }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        let attempt = await task.value

        XCTAssertEqual(attempt.failure, .cancelled)
    }

    // MARK: - The transcript

    func testTheTranscriptLeavesOutTheOldestItemsFirstWhenOverBudget() {
        var messages: [ModelMessage] = []
        for step in 0..<200 {
            messages.append(.user("question \(step) " + String(repeating: "x", count: 200)))
        }
        let transcript = CompactionSummarizer.transcript(of: messages, maximumCharacters: 5_000)

        XCTAssertLessThanOrEqual(transcript.count, 5_200)
        XCTAssertTrue(transcript.hasPrefix("["))
        XCTAssertTrue(transcript.contains("omitted for length"))
        XCTAssertTrue(transcript.contains("question 199"))
        XCTAssertFalse(transcript.contains("question 0 "))
    }

    func testALongCommandOutputKeepsItsTail() {
        let output = String(repeating: "noise\n", count: 2_000) + "error: the actual cause"
        let transcript = CompactionSummarizer.transcript(
            of: [.toolResult(id: "r", content: output, isError: true)],
            maximumCharacters: 100_000
        )
        XCTAssertTrue(transcript.contains("error: the actual cause"))
        XCTAssertLessThan(transcript.count, 3_000)
    }
}

/// The cut itself, which both summaries share.
final class CompactionPlanTests: XCTestCase {
    /// Parallel calls, reasoning between them, steers after a batch: wherever
    /// the plan cuts, no call is separated from its result.
    func testPairsAreNeverSplitWhereverThePlanCuts() throws {
        var messages: [ModelMessage] = [.user("Task")]
        for step in 0..<10 {
            messages.append(.assistantThinking(text: "t\(step)", signature: "s\(step)"))
            messages.append(.toolCall(id: "x\(step)", name: "read_file", input: [:]))
            messages.append(.assistantRedactedThinking(data: "r\(step)"))
            messages.append(.toolCall(id: "y\(step)", name: "grep", input: [:]))
            messages.append(.toolResult(id: "x\(step)", content: "x", isError: false))
            messages.append(.toolResult(id: "y\(step)", content: "y", isError: false))
            if step % 3 == 0 { messages.append(.user("steer \(step)")) }
        }
        messages.append(.assistant("Finished."))
        XCTAssertTrue(ConversationIntegrity.isValid(messages))

        for recentTurns in 1...12 {
            let plan = try XCTUnwrap(
                ConversationCompactor.plan(messages, maximumBytes: 1, recentTurns: recentTurns, force: true),
                "recentTurns \(recentTurns)"
            )
            XCTAssertEqual(plan.folded.count + plan.recent.count + 1, messages.count)
            XCTAssertNil(plan.recent.first?.toolResultID, "recent may not open on a result")
            let callsInRecent = Set(plan.recent.compactMap(\.toolCallID))
            for result in plan.recent.compactMap(\.toolResultID) {
                XCTAssertTrue(callsInRecent.contains(result), "result \(result) lost its call")
            }
            XCTAssertTrue(ConversationIntegrity.isValid(plan.structural.messages))
            XCTAssertTrue(ConversationIntegrity.isValid(plan.result(modelSummary: "S").messages))
        }
    }

    /// When the model has failed once, the structural fallback still folds its
    /// earlier summary in, as one bounded note, under one marker.
    func testAStructuralFallbackFoldsAnEarlierModelSummaryIn() throws {
        var messages: [ModelMessage] = [.user("Task")]
        for step in 0..<8 {
            messages.append(.user("turn \(step)"))
            messages.append(.assistant("answer \(step)"))
        }
        let first = try XCTUnwrap(ConversationCompactor.plan(messages, maximumBytes: 1, recentTurns: 2, force: true))
        let afterModel = first.result(modelSummary: "## Current work\nWiring the table lookup.")
        let continued = afterModel.messages + [.user("turn 8"), .assistant("answer 8"), .user("turn 9")]

        let fallback = try XCTUnwrap(ConversationCompactor.compact(continued, maximumBytes: 1, recentTurns: 1, force: true))

        guard case let .user(anchor) = fallback.messages[0] else { return XCTFail("anchor") }
        XCTAssertTrue(anchor.hasPrefix("Task"))
        XCTAssertEqual(anchor.components(separatedBy: ConversationCompactor.retainedContextMarker).count, 2)
        XCTAssertTrue(fallback.summary.hasPrefix(ConversationCompactor.structuralHeader))
        XCTAssertTrue(fallback.summary.contains("- Earlier summary: ## Current work Wiring the table lookup."))
        XCTAssertTrue(fallback.summary.contains("answer 8"))
        XCTAssertTrue(ConversationIntegrity.isValid(fallback.messages))
    }
}
