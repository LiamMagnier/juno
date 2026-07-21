import Foundation
import JunoStorage

public struct OutboxMutationID: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.init(rawValue: rawValue)
    }
}

public struct IdempotencyKey: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.init(rawValue: rawValue)
    }
}

public struct MutationDraft: Equatable, Sendable {
    public let id: OutboxMutationID
    public let accountID: StorageAccountID
    public let idempotencyKey: IdempotencyKey
    public let entity: RecordKey
    public let operation: String
    public let payload: Data
    public let createdAt: Date

    public init(
        id: OutboxMutationID,
        accountID: StorageAccountID,
        idempotencyKey: IdempotencyKey,
        entity: RecordKey,
        operation: String,
        payload: Data,
        createdAt: Date
    ) {
        self.id = id
        self.accountID = accountID
        self.idempotencyKey = idempotencyKey
        self.entity = entity
        self.operation = operation
        self.payload = payload
        self.createdAt = createdAt
    }
}

public struct MutationLease: Equatable, Sendable {
    public let token: String
    public let owner: String
    public let leasedAt: Date
    public let expiresAt: Date

    public init(token: String, owner: String, leasedAt: Date, expiresAt: Date) {
        self.token = token
        self.owner = owner
        self.leasedAt = leasedAt
        self.expiresAt = expiresAt
    }
}

public struct MutationRetry: Equatable, Sendable {
    public let eligibleAt: Date
    public let errorCode: String

    public init(eligibleAt: Date, errorCode: String) {
        self.eligibleAt = eligibleAt
        self.errorCode = errorCode
    }
}

public struct MutationConflict: Equatable, Sendable {
    public let detectedAt: Date
    public let localRevision: UInt64?
    public let serverRevision: UInt64?
    public let reason: String

    public init(
        detectedAt: Date,
        localRevision: UInt64?,
        serverRevision: UInt64?,
        reason: String
    ) {
        self.detectedAt = detectedAt
        self.localRevision = localRevision
        self.serverRevision = serverRevision
        self.reason = reason
    }
}

public enum MutationState: Equatable, Sendable {
    case pending
    case leased(MutationLease)
    case retryScheduled(MutationRetry)
    case conflicted(MutationConflict)
    case acknowledged(at: Date)
    case discarded(at: Date, reason: String)
}

public struct QueuedMutation: Equatable, Sendable {
    public let draft: MutationDraft
    public private(set) var attemptCount: UInt
    public private(set) var state: MutationState

    public init(
        draft: MutationDraft,
        attemptCount: UInt = 0,
        state: MutationState = .pending
    ) {
        self.draft = draft
        self.attemptCount = attemptCount
        self.state = state
    }

    mutating func transition(to state: MutationState) {
        self.state = state
    }

    mutating func beginAttempt(lease: MutationLease) {
        attemptCount += 1
        state = .leased(lease)
    }
}

public struct MutationEnqueueResult: Equatable, Sendable {
    public let mutation: QueuedMutation
    public let inserted: Bool

    public init(mutation: QueuedMutation, inserted: Bool) {
        self.mutation = mutation
        self.inserted = inserted
    }
}

public enum ConflictResolution: Equatable, Sendable {
    case retry
    case discard(reason: String)
}

public enum MutationOutboxError: Error, Equatable, Sendable {
    case invalidDraftField(String)
    case duplicateMutationID(OutboxMutationID)
    case idempotencyCollision(IdempotencyKey)
    case mutationNotFound(OutboxMutationID)
    case invalidLeaseDuration
    case invalidLeaseLimit
    case leaseMismatch(OutboxMutationID)
    case leaseExpired(OutboxMutationID)
    case invalidTransition(OutboxMutationID, MutationState)
}

extension MutationOutboxError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .invalidDraftField(field):
            "The mutation has an empty or invalid \(field)."
        case let .duplicateMutationID(id):
            "Mutation ID \(id.rawValue) already exists."
        case let .idempotencyCollision(key):
            "Idempotency key \(key.rawValue) was reused for a different mutation."
        case let .mutationNotFound(id):
            "Mutation \(id.rawValue) was not found."
        case .invalidLeaseDuration:
            "A mutation lease must have a positive duration."
        case .invalidLeaseLimit:
            "A mutation lease batch must request at least one item."
        case let .leaseMismatch(id):
            "Mutation \(id.rawValue) is owned by another lease."
        case let .leaseExpired(id):
            "The lease for mutation \(id.rawValue) has expired."
        case let .invalidTransition(id, state):
            "Mutation \(id.rawValue) cannot transition from \(String(describing: state))."
        }
    }
}

public protocol MutationOutboxRepository: Sendable {
    func enqueue(_ draft: MutationDraft) async throws -> MutationEnqueueResult

    func lease(
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date,
        duration: TimeInterval,
        limit: Int
    ) async throws -> [QueuedMutation]

    func acknowledge(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date
    ) async throws

    func scheduleRetry(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date,
        eligibleAt: Date,
        errorCode: String
    ) async throws

    func markConflict(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date,
        localRevision: UInt64?,
        serverRevision: UInt64?,
        reason: String
    ) async throws

    func resolveConflict(
        id: OutboxMutationID,
        resolution: ConflictResolution,
        now: Date
    ) async throws

    func mutations(accountID: StorageAccountID) async -> [QueuedMutation]
    func wipe(accountID: StorageAccountID) async
}

/// Actor-backed outbox intended only for deterministic tests and development.
///
/// It implements the complete transition rules, but intentionally provides no
/// durable persistence. Production composition roots must inject an encrypted
/// transactional adapter conforming to `MutationOutboxRepository`.
public actor InMemoryMutationOutbox: MutationOutboxRepository {
    private var entries: [OutboxMutationID: QueuedMutation] = [:]

    public init() {}

    public func enqueue(_ draft: MutationDraft) throws -> MutationEnqueueResult {
        try validate(draft)

        if let duplicate = entries.values.first(where: {
            $0.draft.accountID == draft.accountID
                && $0.draft.idempotencyKey == draft.idempotencyKey
        }) {
            guard semanticallyMatches(duplicate.draft, draft) else {
                throw MutationOutboxError.idempotencyCollision(draft.idempotencyKey)
            }
            return MutationEnqueueResult(mutation: duplicate, inserted: false)
        }

        guard entries[draft.id] == nil else {
            throw MutationOutboxError.duplicateMutationID(draft.id)
        }

        let mutation = QueuedMutation(draft: draft)
        entries[draft.id] = mutation
        return MutationEnqueueResult(mutation: mutation, inserted: true)
    }

    public func lease(
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date,
        duration: TimeInterval,
        limit: Int
    ) throws -> [QueuedMutation] {
        guard duration > 0 else { throw MutationOutboxError.invalidLeaseDuration }
        guard limit > 0 else { throw MutationOutboxError.invalidLeaseLimit }
        try validateNonempty(owner, field: "lease owner")
        try validateNonempty(token, field: "lease token")

        let eligibleIDs = entries.values
            .filter { mutation in
                guard mutation.draft.accountID == accountID else { return false }
                switch mutation.state {
                case .pending:
                    return true
                case let .retryScheduled(retry):
                    return retry.eligibleAt <= now
                case let .leased(lease):
                    return lease.expiresAt <= now
                case .conflicted, .acknowledged, .discarded:
                    return false
                }
            }
            .sorted(by: mutationOrder)
            .prefix(limit)
            .map(\.draft.id)

        let lease = MutationLease(
            token: token,
            owner: owner,
            leasedAt: now,
            expiresAt: now.addingTimeInterval(duration)
        )

        var leased: [QueuedMutation] = []
        leased.reserveCapacity(eligibleIDs.count)
        for id in eligibleIDs {
            guard var mutation = entries[id] else { continue }
            mutation.beginAttempt(lease: lease)
            entries[id] = mutation
            leased.append(mutation)
        }
        return leased
    }

    public func acknowledge(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date
    ) throws {
        var mutation = try leasedMutation(id: id, owner: owner, token: token, now: now)
        mutation.transition(to: .acknowledged(at: now))
        entries[id] = mutation
    }

    public func scheduleRetry(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date,
        eligibleAt: Date,
        errorCode: String
    ) throws {
        try validateNonempty(errorCode, field: "retry error code")
        var mutation = try leasedMutation(id: id, owner: owner, token: token, now: now)
        mutation.transition(
            to: .retryScheduled(
                MutationRetry(eligibleAt: max(now, eligibleAt), errorCode: errorCode)
            )
        )
        entries[id] = mutation
    }

    public func markConflict(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date,
        localRevision: UInt64?,
        serverRevision: UInt64?,
        reason: String
    ) throws {
        try validateNonempty(reason, field: "conflict reason")
        var mutation = try leasedMutation(id: id, owner: owner, token: token, now: now)
        mutation.transition(
            to: .conflicted(
                MutationConflict(
                    detectedAt: now,
                    localRevision: localRevision,
                    serverRevision: serverRevision,
                    reason: reason
                )
            )
        )
        entries[id] = mutation
    }

    public func resolveConflict(
        id: OutboxMutationID,
        resolution: ConflictResolution,
        now: Date
    ) throws {
        guard var mutation = entries[id] else {
            throw MutationOutboxError.mutationNotFound(id)
        }
        guard case .conflicted = mutation.state else {
            throw MutationOutboxError.invalidTransition(id, mutation.state)
        }

        switch resolution {
        case .retry:
            mutation.transition(to: .pending)
        case let .discard(reason):
            try validateNonempty(reason, field: "discard reason")
            mutation.transition(to: .discarded(at: now, reason: reason))
        }
        entries[id] = mutation
    }

    public func mutations(accountID: StorageAccountID) -> [QueuedMutation] {
        entries.values
            .filter { $0.draft.accountID == accountID }
            .sorted(by: mutationOrder)
    }

    public func wipe(accountID: StorageAccountID) {
        entries = entries.filter { $0.value.draft.accountID != accountID }
    }

    private func leasedMutation(
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date
    ) throws -> QueuedMutation {
        guard let mutation = entries[id] else {
            throw MutationOutboxError.mutationNotFound(id)
        }
        guard case let .leased(lease) = mutation.state else {
            throw MutationOutboxError.invalidTransition(id, mutation.state)
        }
        guard lease.owner == owner, lease.token == token else {
            throw MutationOutboxError.leaseMismatch(id)
        }
        guard lease.expiresAt > now else {
            throw MutationOutboxError.leaseExpired(id)
        }
        return mutation
    }

    private func validate(_ draft: MutationDraft) throws {
        try validateNonempty(draft.id.rawValue, field: "mutation ID")
        try validateNonempty(draft.accountID.rawValue, field: "account ID")
        try validateNonempty(draft.idempotencyKey.rawValue, field: "idempotency key")
        try validateNonempty(draft.entity.namespace, field: "entity namespace")
        try validateNonempty(draft.entity.id, field: "entity ID")
        try validateNonempty(draft.operation, field: "operation")
    }

    private func validateNonempty(_ value: String, field: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MutationOutboxError.invalidDraftField(field)
        }
    }

    private func semanticallyMatches(_ lhs: MutationDraft, _ rhs: MutationDraft) -> Bool {
        lhs.accountID == rhs.accountID
            && lhs.idempotencyKey == rhs.idempotencyKey
            && lhs.entity == rhs.entity
            && lhs.operation == rhs.operation
            && lhs.payload == rhs.payload
    }

    private func mutationOrder(_ lhs: QueuedMutation, _ rhs: QueuedMutation) -> Bool {
        if lhs.draft.createdAt != rhs.draft.createdAt {
            return lhs.draft.createdAt < rhs.draft.createdAt
        }
        return lhs.draft.id.rawValue < rhs.draft.id.rawValue
    }
}
