import Foundation
import JunoCodeCore

/// One model turn, streamed to its end and collected, for a loop that does
/// not show the reply as it arrives — the Mac's Work runs.
///
/// It applies the same retry policy as ``AgentOrchestrator``: the same typed
/// failures, the same backoff and the same respect for the provider's
/// `retry-after`, so a Work run is not the one loop that dies on the first
/// 429. What it collects is in stream order, reasoning blocks included, so a
/// caller can put the turn back into its history exactly as the model wrote
/// it and keep the model's replayed thinking valid.
public enum ModelTurnCollector {
    /// What one turn amounted to.
    public struct Turn: Sendable {
        /// The model's items in stream order: reasoning, text and calls. A
        /// malformed call is here with empty arguments.
        public var items: [ModelMessage] = []
        /// The turn's text, joined.
        public var text = ""
        public var toolCalls: [ToolCall] = []
        /// The answer for each call whose arguments did not parse, by id.
        public var malformedResults: [String: String] = [:]
        public var stopReason: ModelStopReason?
        public var usage: ModelCallUsage?

        public init() {}
    }

    public struct ToolCall: Sendable, Equatable {
        public let id: String
        public let name: String
        public let input: JSONValue
    }

    /// A retry about to be waited for.
    public struct Retry: Sendable, Equatable {
        public let attempt: Int
        public let limit: Int
        public let delay: Duration
        /// What went wrong, for a person.
        public let sentence: String
    }

    /// The turn failed and waiting would not help, or waiting ran out.
    public struct Failure: Error, Sendable {
        /// What went wrong, in words a person can act on.
        public let sentence: String
        public let underlying: any Error
    }

    /// Streams `request` to its end, retrying what the policy says is worth
    /// waiting out.
    ///
    /// - Throws: ``Failure`` once the turn cannot succeed, or
    ///   `CancellationError` when the task is cancelled, including mid-wait.
    public static func collect(
        _ request: ModelTurnRequest,
        model: any AgentModelClient,
        policy: ModelRetryPolicy = .standard,
        sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        jitter: @Sendable () -> Double = { Double.random(in: 0..<1) },
        onRetry: @Sendable (Retry) async -> Void = { _ in }
    ) async throws -> Turn {
        var retries = 0
        var waited = Duration.zero
        while true {
            do {
                return try await stream(request, model: model)
            } catch {
                try Task.checkCancellation()
                let failure = ModelFailure(error)
                let limit = failure.retryLimit(policy)
                guard retries < limit,
                      let delay = policy.delay(
                          forRetry: retries + 1,
                          retryAfter: failure.retryAfter,
                          waited: waited,
                          jitter: jitter()
                      )
                else {
                    throw Failure(sentence: failure.sentence, underlying: error)
                }
                retries += 1
                waited += delay
                await onRetry(Retry(attempt: retries, limit: limit, delay: delay, sentence: failure.sentence))
                try await sleep(delay)
            }
        }
    }

    private static func stream(_ request: ModelTurnRequest, model: any AgentModelClient) async throws -> Turn {
        var turn = Turn()
        var segment = ""
        var filter = LeadingThinkingFilter()
        var input: Int?
        var output: Int?
        var cacheRead: Int?
        var cacheWrite: Int?
        func closeSegment() {
            if !segment.isEmpty {
                turn.items.append(.assistant(segment))
                segment = ""
            }
        }
        func take(_ parts: (text: String, reasoning: String)) {
            segment += parts.text
            turn.text += parts.text
        }
        for try await event in model.streamTurn(request) {
            try Task.checkCancellation()
            switch event {
            case let .textDelta(delta):
                take(filter.push(delta))
            case .reasoningSummary:
                continue
            case let .thinkingBlock(text, signature):
                closeSegment()
                turn.items.append(.assistantThinking(text: text, signature: signature))
            case let .redactedThinking(data):
                closeSegment()
                turn.items.append(.assistantRedactedThinking(data: data))
            case let .toolCallRequested(id, name, arguments):
                closeSegment()
                turn.items.append(.toolCall(id: id, name: name, input: arguments))
                turn.toolCalls.append(ToolCall(id: id, name: name, input: arguments))
            case let .toolCallRequestedWithExtra(id, name, arguments, extra):
                closeSegment()
                turn.items.append(.toolCallWithExtra(id: id, name: name, input: arguments, extraContent: extra))
                turn.toolCalls.append(ToolCall(id: id, name: name, input: arguments))
            case let .toolCallMalformed(id, name, rawArguments, error, extra):
                closeSegment()
                turn.items.append(
                    extra.map { .toolCallWithExtra(id: id, name: name, input: .object([:]), extraContent: $0) }
                        ?? .toolCall(id: id, name: name, input: .object([:]))
                )
                turn.toolCalls.append(ToolCall(id: id, name: name, input: .object([:])))
                turn.malformedResults[id] = ToolArguments.malformedResult(
                    toolName: name,
                    rawArguments: rawArguments,
                    error: error
                )
            case let .usage(inputTokens, outputTokens):
                if let inputTokens { input = inputTokens }
                if let outputTokens { output = outputTokens }
            case let .cacheUsage(readTokens, writeTokens):
                if let readTokens { cacheRead = readTokens }
                if let writeTokens { cacheWrite = writeTokens }
            case let .turnCompleted(reason):
                turn.stopReason = reason
            }
        }
        take(filter.finish())
        closeSegment()
        // A valid call defines the work even when a compatible provider
        // labels the ending as a normal end of turn.
        if turn.stopReason == .endTurn, !turn.toolCalls.isEmpty {
            turn.stopReason = .toolUse
        }
        if input != nil || output != nil {
            turn.usage = ModelCallUsage(
                purpose: .turn,
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                modelID: request.modelID
            )
        }
        return turn
    }
}
