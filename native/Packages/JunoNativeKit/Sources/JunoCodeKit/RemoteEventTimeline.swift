import Foundation

public enum CodeTaskPhase: String, Codable, Sendable {
    case queued
    case running
    case awaitingApproval
    case completed
    case failed
    case cancelled
}

public enum CodeRemoteEventPayload: Equatable, Sendable {
    case phase(CodeTaskPhase)
    case progress(String)
    case commandOutput(String)
    case fileChanged(WorkspaceRelativePath)
    case approval(CodeApprovalRequest)
    case pullRequest(number: Int, url: URL)
}

public struct CodeRemoteEvent: Equatable, Sendable {
    public let sequence: UInt64
    public let occurredAt: Date
    public let payload: CodeRemoteEventPayload

    public init(sequence: UInt64, occurredAt: Date, payload: CodeRemoteEventPayload) {
        self.sequence = sequence
        self.occurredAt = occurredAt
        self.payload = payload
    }
}

public enum CodeRemoteTimelineError: Error, Equatable, Sendable {
    case sequenceGap(expected: UInt64, received: UInt64)
    case payloadTooLarge(maximumUTF8Bytes: Int)
}

public enum CodeRemoteApplyResult: Equatable, Sendable {
    case applied
    case duplicate
}

public struct CodeRemoteTimeline: Equatable, Sendable {
    public static let maximumTextPayloadUTF8Bytes = 256 * 1_024
    public static let retainedEventCount = 2_048

    public private(set) var lastSequence: UInt64?
    public private(set) var events: [CodeRemoteEvent]

    public init(lastSequence: UInt64? = nil, events: [CodeRemoteEvent] = []) {
        self.lastSequence = lastSequence
        self.events = Array(events.suffix(Self.retainedEventCount))
    }

    @discardableResult
    public mutating func apply(_ event: CodeRemoteEvent) throws -> CodeRemoteApplyResult {
        if let lastSequence {
            if event.sequence <= lastSequence {
                return .duplicate
            }
            let expected = lastSequence + 1
            guard event.sequence == expected else {
                throw CodeRemoteTimelineError.sequenceGap(
                    expected: expected,
                    received: event.sequence
                )
            }
        }

        switch event.payload {
        case let .progress(text), let .commandOutput(text):
            guard text.utf8.count <= Self.maximumTextPayloadUTF8Bytes else {
                throw CodeRemoteTimelineError.payloadTooLarge(
                    maximumUTF8Bytes: Self.maximumTextPayloadUTF8Bytes
                )
            }
        case .phase, .fileChanged, .approval, .pullRequest:
            break
        }

        events.append(event)
        if events.count > Self.retainedEventCount {
            events.removeFirst(events.count - Self.retainedEventCount)
        }
        lastSequence = event.sequence
        return .applied
    }
}
