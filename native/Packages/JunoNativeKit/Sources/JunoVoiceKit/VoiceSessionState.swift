import Foundation

public enum VoicePermission: Equatable, Sendable {
    case unknown
    case granted
    case denied
}

public enum VoiceSessionPhase: Equatable, Sendable {
    case idle
    case requestingPermission
    case preparing
    case listening
    case processing
    case speaking
    case interrupted
    case failed(message: String)
}

public enum VoiceSessionEvent: Equatable, Sendable {
    case start
    case permissionResolved(granted: Bool)
    case captureReady
    case userFinishedSpeaking
    case playbackReady
    case interruptionBegan
    case interruptionEnded(shouldResume: Bool)
    case stop
    case failed(message: String)
}

public enum VoiceSessionTransitionError: Error, Equatable, Sendable {
    case permissionDenied
    case invalidTransition(from: VoiceSessionPhase, event: VoiceSessionEvent)
    case invalidFailureMessage
}

/// Pure lifecycle reducer. Platform audio sessions adapt their callbacks into events.
public struct VoiceSessionState: Equatable, Sendable {
    public private(set) var permission: VoicePermission
    public private(set) var phase: VoiceSessionPhase
    private var resumablePhase: VoiceSessionPhase?

    public init(permission: VoicePermission = .unknown, phase: VoiceSessionPhase = .idle) {
        self.permission = permission
        self.phase = phase
    }

    public mutating func apply(_ event: VoiceSessionEvent) throws {
        if case .stop = event {
            phase = .idle
            resumablePhase = nil
            return
        }
        if case let .failed(message) = event {
            guard !message.isEmpty, message.utf8.count <= 8 * 1_024 else {
                throw VoiceSessionTransitionError.invalidFailureMessage
            }
            phase = .failed(message: message)
            resumablePhase = nil
            return
        }

        switch (phase, event) {
        case (.idle, .start):
            switch permission {
            case .unknown:
                phase = .requestingPermission
            case .granted:
                phase = .preparing
            case .denied:
                throw VoiceSessionTransitionError.permissionDenied
            }

        case let (.requestingPermission, .permissionResolved(granted)):
            permission = granted ? .granted : .denied
            if granted {
                phase = .preparing
            } else {
                phase = .idle
                throw VoiceSessionTransitionError.permissionDenied
            }

        case (.preparing, .captureReady):
            phase = .listening

        case (.listening, .userFinishedSpeaking):
            phase = .processing

        case (.processing, .playbackReady):
            phase = .speaking

        case (.listening, .interruptionBegan),
             (.processing, .interruptionBegan),
             (.speaking, .interruptionBegan):
            resumablePhase = phase
            phase = .interrupted

        case let (.interrupted, .interruptionEnded(shouldResume)):
            phase = shouldResume ? (resumablePhase ?? .idle) : .idle
            resumablePhase = nil

        default:
            throw VoiceSessionTransitionError.invalidTransition(from: phase, event: event)
        }
    }
}
