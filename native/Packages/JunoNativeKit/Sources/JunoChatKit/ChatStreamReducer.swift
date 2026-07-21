import Foundation
import JunoCore

public enum ChatStreamPhase: Equatable, Sendable {
    case idle
    case streaming(messageID: String)
    case completed(messageID: String)
    case failed(message: String)
    case cancelled

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled:
            true
        case .idle, .streaming:
            false
        }
    }
}

public enum ChatToolPhase: String, Codable, Sendable {
    case pending
    case running
    case succeeded
    case failed
}

public struct ChatToolState: Equatable, Sendable {
    public let name: String
    public var phase: ChatToolPhase
    public var summary: String?

    public init(name: String, phase: ChatToolPhase, summary: String? = nil) {
        self.name = name
        self.phase = phase
        self.summary = summary
    }
}

public enum ChatStreamEvent: Equatable, Sendable {
    case opened(sequence: UInt64, messageID: String)
    case textDelta(sequence: UInt64, text: String)
    case reasoningDelta(sequence: UInt64, text: String)
    case tool(sequence: UInt64, id: String, state: ChatToolState)
    case completed(sequence: UInt64)
    case failed(sequence: UInt64, message: String)
    case cancelled(sequence: UInt64)

    public var sequence: UInt64 {
        switch self {
        case let .opened(sequence, _),
             let .textDelta(sequence, _),
             let .reasoningDelta(sequence, _),
             let .tool(sequence, _, _),
             let .completed(sequence),
             let .failed(sequence, _),
             let .cancelled(sequence):
            sequence
        }
    }
}

public enum ChatStreamApplyResult: Equatable, Sendable {
    case applied
    case duplicate
}

public enum ChatStreamReducerError: Error, Equatable, Sendable {
    case sequenceGap(expected: UInt64, received: UInt64)
    case invalidTransition
    case invalidPayload(BoundedValueError)
    case accumulatedContentTooLarge(maximumUTF8Bytes: Int)
}

/// Deterministic reducer for reconnectable chat streams.
public struct ChatStreamState: Equatable, Sendable {
    public static let maximumDeltaUTF8Bytes = 64 * 1_024
    public static let maximumAccumulatedUTF8Bytes = 4 * 1_024 * 1_024

    public private(set) var phase: ChatStreamPhase
    public private(set) var text: String
    public private(set) var reasoning: String
    public private(set) var tools: [String: ChatToolState]
    public private(set) var lastSequence: UInt64?

    public init(
        phase: ChatStreamPhase = .idle,
        text: String = "",
        reasoning: String = "",
        tools: [String: ChatToolState] = [:],
        lastSequence: UInt64? = nil
    ) {
        self.phase = phase
        self.text = text
        self.reasoning = reasoning
        self.tools = tools
        self.lastSequence = lastSequence
    }

    @discardableResult
    public mutating func apply(_ event: ChatStreamEvent) throws -> ChatStreamApplyResult {
        if let lastSequence {
            if event.sequence <= lastSequence {
                return .duplicate
            }
            let expected = lastSequence + 1
            guard event.sequence == expected else {
                throw ChatStreamReducerError.sequenceGap(
                    expected: expected,
                    received: event.sequence
                )
            }
        }

        guard !phase.isTerminal else {
            throw ChatStreamReducerError.invalidTransition
        }

        switch event {
        case let .opened(_, messageID):
            guard case .idle = phase else {
                throw ChatStreamReducerError.invalidTransition
            }
            try validate(messageID, field: "messageID", maximum: 256)
            phase = .streaming(messageID: messageID)

        case let .textDelta(_, delta):
            try requireStreaming()
            try validateDelta(delta, field: "textDelta")
            text.append(delta)
            try validateAccumulatedSize()

        case let .reasoningDelta(_, delta):
            try requireStreaming()
            try validateDelta(delta, field: "reasoningDelta")
            reasoning.append(delta)
            try validateAccumulatedSize()

        case let .tool(_, id, state):
            try requireStreaming()
            try validate(id, field: "toolID", maximum: 256)
            try validate(state.name, field: "toolName", maximum: 256)
            if let summary = state.summary {
                try validate(summary, field: "toolSummary", maximum: 32 * 1_024, allowsEmpty: true)
            }
            tools[id] = state

        case .completed:
            let messageID = try streamingMessageID()
            phase = .completed(messageID: messageID)

        case let .failed(_, message):
            try validate(message, field: "failureMessage", maximum: 8 * 1_024)
            phase = .failed(message: message)

        case .cancelled:
            phase = .cancelled
        }

        lastSequence = event.sequence
        return .applied
    }

    private func requireStreaming() throws {
        _ = try streamingMessageID()
    }

    private func streamingMessageID() throws -> String {
        guard case let .streaming(messageID) = phase else {
            throw ChatStreamReducerError.invalidTransition
        }
        return messageID
    }

    private func validateDelta(_ value: String, field: String) throws {
        try validate(
            value,
            field: field,
            maximum: Self.maximumDeltaUTF8Bytes,
            allowsEmpty: true
        )
    }

    private func validateAccumulatedSize() throws {
        guard text.utf8.count + reasoning.utf8.count <= Self.maximumAccumulatedUTF8Bytes else {
            throw ChatStreamReducerError.accumulatedContentTooLarge(
                maximumUTF8Bytes: Self.maximumAccumulatedUTF8Bytes
            )
        }
    }

    private func validate(
        _ value: String,
        field: String,
        maximum: Int,
        allowsEmpty: Bool = false
    ) throws {
        do {
            try BoundedValue.validateText(
                value,
                field: field,
                maximumUTF8Bytes: maximum,
                allowsEmpty: allowsEmpty,
                allowsNewlines: true
            )
        } catch let error as BoundedValueError {
            throw ChatStreamReducerError.invalidPayload(error)
        }
    }
}
