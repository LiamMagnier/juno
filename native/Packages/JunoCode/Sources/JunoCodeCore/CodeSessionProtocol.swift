import Foundation

/// The version of the transport-neutral Juno Code session protocol.
///
/// This is deliberately independent of the app version and of a relay's
/// inventory generation. A client must negotiate this value before it sends a
/// command that could change a workspace. Version `1` is additive: the legacy
/// Swift store and the existing HTTP relay continue to operate through
/// adapters while clients move to these envelopes.
public struct CodeProtocolVersion: Hashable, Codable, Sendable, Comparable {
    public let major: Int
    public let minor: Int

    public init(major: Int, minor: Int = 0) {
        self.major = major
        self.minor = minor
    }

    public static let current = CodeProtocolVersion(major: 1)

    /// A major-version mismatch is never safe to guess through: an older
    /// client could otherwise misread an approval or cancellation command.
    public func isCompatible(with peer: CodeProtocolVersion) -> Bool {
        major == peer.major && minor <= peer.minor
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        (lhs.major, lhs.minor) < (rhs.major, rhs.minor)
    }
}

/// An opaque identifier for a host, cloud runner, or routable execution target.
/// It is intentionally not a filesystem path, hostname, or credential.
public struct ExecutionTargetID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

public enum ExecutionTargetKind: String, Codable, CaseIterable, Sendable {
    case local
    case remote
    case cloud

    public var sessionLocation: SessionLocation {
        switch self {
        case .local: .local
        case .remote: .remote
        case .cloud: .cloud
        }
    }
}

public enum ExecutionTargetConnectionState: String, Codable, CaseIterable, Sendable {
    /// The target has not reported enough information to be selected safely.
    case unknown
    case online
    case degraded
    case offline
    case revoked

    public var isSelectable: Bool {
        self == .online || self == .degraded
    }
}

/// Capabilities advertised by a target, not permissions granted to a session.
/// A host still evaluates its local policy for every action.
public enum ExecutionTargetCapability: String, Codable, CaseIterable, Sendable {
    case workspaceAccess
    case shell
    case git
    case worktrees
    case tests
    case devServers
    case previews
    case screenshots
    case computerUse
    case subagents
    case approvals
    case sessionResume
}

/// A workspace safe to advertise outside the host. Its opaque ID is resolved
/// by the host against its local workspace grant; it never carries a path or a
/// bookmark.
public struct ExecutionTargetWorkspace: Hashable, Codable, Sendable {
    public let id: WorkspaceID
    public let displayName: String
    public let isGitRepository: Bool

    public init(id: WorkspaceID, displayName: String, isGitRepository: Bool) {
        self.id = id
        self.displayName = displayName
        self.isGitRepository = isGitRepository
    }
}

/// A cloud repository reference. It is intentionally distinct from a local
/// workspace because a cloud target cannot be granted local machine access.
public struct ExecutionTargetRepository: Hashable, Codable, Sendable {
    public let owner: String
    public let name: String
    public let baseRef: String?

    public init(owner: String, name: String, baseRef: String? = nil) {
        self.owner = owner
        self.name = name
        self.baseRef = baseRef
    }
}

/// The one routing abstraction for a local host, a trusted remote host, and a
/// cloud runner. It contains only public routing metadata; workspace grants,
/// absolute paths, credentials, and approval policy remain inside the host.
public struct ExecutionTarget: Hashable, Codable, Sendable, Identifiable {
    public let id: ExecutionTargetID
    public let kind: ExecutionTargetKind
    public var displayName: String
    /// Host/device identity for local and remote targets. Nil for a cloud
    /// runner, whose target identity is sufficient to route a task.
    public let hostID: String?
    public var workspace: ExecutionTargetWorkspace?
    public var repository: ExecutionTargetRepository?
    public var capabilities: Set<ExecutionTargetCapability>
    public var connectionState: ExecutionTargetConnectionState
    public var supportedModelIDs: [String]
    public var protocolVersion: CodeProtocolVersion?

    public init(
        id: ExecutionTargetID,
        kind: ExecutionTargetKind,
        displayName: String,
        hostID: String? = nil,
        workspace: ExecutionTargetWorkspace? = nil,
        repository: ExecutionTargetRepository? = nil,
        capabilities: Set<ExecutionTargetCapability> = [],
        connectionState: ExecutionTargetConnectionState = .unknown,
        supportedModelIDs: [String] = [],
        protocolVersion: CodeProtocolVersion? = nil
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.hostID = hostID
        self.workspace = workspace
        self.repository = repository
        self.capabilities = capabilities
        self.connectionState = connectionState
        self.supportedModelIDs = supportedModelIDs
        self.protocolVersion = protocolVersion
    }

    /// A migration-only target for sessions persisted before explicit routing
    /// existed. It is not a discovery result and may not be sent to another
    /// machine until a host replaces it with its registered identity.
    public static func legacy(for location: SessionLocation) -> Self {
        Self(
            id: ExecutionTargetID(value: "legacy-\(location.rawValue)"),
            kind: ExecutionTargetKind(rawValue: location.rawValue) ?? .local,
            displayName: location == .local ? "This Mac" : location.rawValue.capitalized,
            connectionState: location == .local ? .online : .unknown
        )
    }

    public var isLegacy: Bool { id.value.hasPrefix("legacy-") }
    public var isSelectable: Bool { !isLegacy && connectionState.isSelectable }
}

/// A resume cursor. Sequences are one-based at the protocol boundary; the
/// legacy local store's zero-based sequence is translated by its adapter.
public struct CodeSessionEventCursor: Hashable, Codable, Sendable {
    public let sessionID: CodeSessionID
    public let afterSequence: Int

    public init(sessionID: CodeSessionID, afterSequence: Int) {
        self.sessionID = sessionID
        self.afterSequence = max(0, afterSequence)
    }
}

/// The durable event sent between a host and any client. The semantic payload
/// is the existing `SessionEventPayload`, so this boundary does not discard
/// mature event data or create a second UI-only event vocabulary.
public struct CodeSessionEventEnvelope: Hashable, Codable, Sendable, Identifiable {
    public let protocolVersion: CodeProtocolVersion
    /// Producer-stable event id. This is the idempotency key for replayed event
    /// batches; sequence alone only establishes transcript order.
    public let id: String
    public let sessionID: CodeSessionID
    public let sequence: Int
    public let occurredAt: Date
    public let payload: SessionEventPayload

    public init(
        protocolVersion: CodeProtocolVersion = .current,
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        sequence: Int,
        occurredAt: Date,
        payload: SessionEventPayload
    ) {
        self.protocolVersion = protocolVersion
        self.id = id
        self.sessionID = sessionID
        self.sequence = sequence
        self.occurredAt = occurredAt
        self.payload = payload
    }
}

public enum CodeSessionEventAppendError: Error, Equatable, Sendable {
    case incompatibleProtocol(expectedMajor: Int, receivedMajor: Int)
    case wrongSession(expected: CodeSessionID, received: CodeSessionID)
    case invalidSequence(Int)
    case duplicateSequence(Int)
    case sequenceGap(expected: Int, received: Int)
}

public struct CodeSessionEventAppendPlan: Equatable, Sendable {
    public let accepted: [CodeSessionEventEnvelope]
    public let lastSequence: Int

    public init(accepted: [CodeSessionEventEnvelope], lastSequence: Int) {
        self.accepted = accepted
        self.lastSequence = lastSequence
    }
}

/// Pure event-stream folding rules shared by hosts and transports. It makes a
/// reconnect/retry idempotent while refusing holes, so a client never renders
/// an incomplete transcript as complete.
public enum CodeSessionEventAppendPlanner {
    public static func plan(
        persistedThrough lastSequence: Int,
        for sessionID: CodeSessionID,
        incoming: [CodeSessionEventEnvelope],
        supportedVersion: CodeProtocolVersion = .current
    ) throws -> CodeSessionEventAppendPlan {
        let sorted = incoming.sorted { lhs, rhs in
            lhs.sequence == rhs.sequence ? lhs.id < rhs.id : lhs.sequence < rhs.sequence
        }
        var expected = max(0, lastSequence) + 1
        var accepted: [CodeSessionEventEnvelope] = []
        var seenNewSequences = Set<Int>()

        for event in sorted {
            guard event.protocolVersion.major == supportedVersion.major else {
                throw CodeSessionEventAppendError.incompatibleProtocol(
                    expectedMajor: supportedVersion.major,
                    receivedMajor: event.protocolVersion.major
                )
            }
            guard event.sessionID == sessionID else {
                throw CodeSessionEventAppendError.wrongSession(
                    expected: sessionID,
                    received: event.sessionID
                )
            }
            guard event.sequence > 0 else {
                throw CodeSessionEventAppendError.invalidSequence(event.sequence)
            }
            if event.sequence <= lastSequence { continue }
            guard seenNewSequences.insert(event.sequence).inserted else {
                throw CodeSessionEventAppendError.duplicateSequence(event.sequence)
            }
            guard event.sequence == expected else {
                throw CodeSessionEventAppendError.sequenceGap(
                    expected: expected,
                    received: event.sequence
                )
            }
            accepted.append(event)
            expected += 1
        }

        return CodeSessionEventAppendPlan(
            accepted: accepted,
            lastSequence: accepted.last?.sequence ?? max(0, lastSequence)
        )
    }
}

/// The commands clients may submit to a host. The host is still responsible
/// for validating payload fields and enforcing its current local policy.
public enum CodeSessionCommandKind: String, Codable, CaseIterable, Sendable {
    case createSession = "create_session"
    case sendMessage = "send_message"
    case cancel = "cancel"
    case approvalDecision = "approval_decision"
    case retry = "retry"
    case fork = "fork"
    case runTests = "run_tests"
    case stopTests = "stop_tests"
    case gitAction = "git_action"
    case inspectDiff = "inspect_diff"
    case inspectFiles = "inspect_files"
    case inspectSubagents = "inspect_subagents"
}

/// A command envelope may be delivered more than once. `idempotencyKey` is
/// client-minted and remains stable across retries; the host records the first
/// result rather than executing a second time.
public struct CodeSessionCommandEnvelope: Hashable, Codable, Sendable, Identifiable {
    public let protocolVersion: CodeProtocolVersion
    public let id: String
    public let idempotencyKey: String
    public let targetID: ExecutionTargetID
    /// Nil is valid only for `createSession`.
    public let sessionID: CodeSessionID?
    public let kind: CodeSessionCommandKind
    public let payload: [String: JSONValue]
    public let issuedAt: Date
    public let expiresAt: Date?

    public init(
        protocolVersion: CodeProtocolVersion = .current,
        id: String = UUID().uuidString.lowercased(),
        idempotencyKey: String = UUID().uuidString.lowercased(),
        targetID: ExecutionTargetID,
        sessionID: CodeSessionID?,
        kind: CodeSessionCommandKind,
        payload: [String: JSONValue] = [:],
        issuedAt: Date = Date(),
        expiresAt: Date? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.targetID = targetID
        self.sessionID = sessionID
        self.kind = kind
        self.payload = payload
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    public func isExpired(at date: Date = Date()) -> Bool {
        expiresAt.map { $0 <= date } ?? false
    }
}

public enum CodeSessionCommandDisposition: String, Codable, CaseIterable, Sendable {
    case pending
    case claimed
    case completed
    case rejected
    case expired
    case cancelled
}

public struct CodeSessionCommandReceipt: Hashable, Codable, Sendable {
    public let commandID: String
    public let idempotencyKey: String
    public let disposition: CodeSessionCommandDisposition
    public let result: [String: JSONValue]?
    public let errorCode: String?
    public let completedAt: Date?

    public init(
        commandID: String,
        idempotencyKey: String,
        disposition: CodeSessionCommandDisposition,
        result: [String: JSONValue]? = nil,
        errorCode: String? = nil,
        completedAt: Date? = nil
    ) {
        self.commandID = commandID
        self.idempotencyKey = idempotencyKey
        self.disposition = disposition
        self.result = result
        self.errorCode = errorCode
        self.completedAt = completedAt
    }
}

/// The bounded, client-safe session inventory returned by a host. It deliberately
/// excludes execution paths, credentials, raw model context and tool output;
/// clients use the event cursor to request a particular transcript on demand.
public struct CodeSessionSummary: Hashable, Codable, Sendable, Identifiable {
    public let id: CodeSessionID
    public let targetID: ExecutionTargetID
    public let title: String
    public let status: SessionStatus
    public let modelID: String
    public let reasoningEffort: ReasoningEffort?
    public let lastEventSequence: Int
    public let updatedAt: Date

    public init(
        id: CodeSessionID,
        targetID: ExecutionTargetID,
        title: String,
        status: SessionStatus,
        modelID: String,
        reasoningEffort: ReasoningEffort?,
        lastEventSequence: Int,
        updatedAt: Date
    ) {
        self.id = id
        self.targetID = targetID
        self.title = title
        self.status = status
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.lastEventSequence = max(0, lastEventSequence)
        self.updatedAt = updatedAt
    }
}

/// The GUI, CLI, relay, and host all depend on this narrow surface. Concrete
/// implementations may use an XPC capability, a Unix socket, or an
/// authenticated relay; no UI framework appears in this contract.
public protocol JunoCodeHosting: Sendable {
    func executionTargets() async throws -> [ExecutionTarget]
    func sessions() async throws -> [CodeSessionSummary]
    func events(after cursor: CodeSessionEventCursor) async throws -> [CodeSessionEventEnvelope]
    func submit(_ command: CodeSessionCommandEnvelope) async throws -> CodeSessionCommandReceipt
}
