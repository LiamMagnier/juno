import Foundation
import JunoStorage

public enum PersistentMutationOutboxError: Error, Equatable, Sendable {
    case corruptRecord(RecordKey)
    case concurrentWriteLimitExceeded
}

/// Durable outbox stored as encrypted account records in the production SQLite
/// repository. Leases and state transitions are optimistic account transactions,
/// so a process crash can only leave a reclaimable expired lease—not a half write.
public actor PersistentMutationOutbox<Repository: AccountScopedRepository>:
    MutationOutboxRepository
{
    public static var namespace: String { "_juno.outbox" }

    private let repository: Repository
    private let maximumTransactionAttempts: Int
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(repository: Repository, maximumTransactionAttempts: Int = 4) {
        self.repository = repository
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        decoder = JSONDecoder()
    }

    public func enqueue(_ draft: MutationDraft) async throws -> MutationEnqueueResult {
        try validate(draft)
        return try await transact(accountID: draft.accountID) { entries in
            if let duplicate = entries.values.first(where: {
                $0.draft.idempotencyKey == draft.idempotencyKey
            }) {
                guard semanticallyMatches(duplicate.draft, draft) else {
                    throw MutationOutboxError.idempotencyCollision(draft.idempotencyKey)
                }
                return (MutationEnqueueResult(mutation: duplicate, inserted: false), [])
            }
            guard entries[draft.id] == nil else {
                throw MutationOutboxError.duplicateMutationID(draft.id)
            }
            let mutation = QueuedMutation(draft: draft)
            entries[draft.id] = mutation
            return (MutationEnqueueResult(mutation: mutation, inserted: true), [draft.id])
        }
    }

    public func lease(
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date,
        duration: TimeInterval,
        limit: Int
    ) async throws -> [QueuedMutation] {
        guard duration > 0 else { throw MutationOutboxError.invalidLeaseDuration }
        guard limit > 0 else { throw MutationOutboxError.invalidLeaseLimit }
        try validateNonempty(owner, field: "lease owner")
        try validateNonempty(token, field: "lease token")
        return try await transact(accountID: accountID) { entries in
            let ids = entries.values.filter { mutation in
                switch mutation.state {
                case .pending: true
                case .retryScheduled(let retry): retry.eligibleAt <= now
                case .leased(let lease): lease.expiresAt <= now
                case .conflicted, .acknowledged, .discarded: false
                }
            }.sorted(by: mutationOrder).prefix(limit).map(\.draft.id)
            let lease = MutationLease(
                token: token,
                owner: owner,
                leasedAt: now,
                expiresAt: now.addingTimeInterval(duration)
            )
            var leased: [QueuedMutation] = []
            for id in ids {
                guard var mutation = entries[id] else { continue }
                mutation.beginAttempt(lease: lease)
                entries[id] = mutation
                leased.append(mutation)
            }
            return (leased, Set(ids))
        }
    }

    public func acknowledge(
        id: OutboxMutationID,
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date
    ) async throws {
        _ = try await transact(accountID: accountID) { entries in
            var mutation = try leasedMutation(
                entries: entries, id: id, owner: owner, token: token, now: now
            )
            mutation.transition(to: .acknowledged(at: now))
            entries[id] = mutation
            return ((), [id])
        }
    }

    public func scheduleRetry(
        id: OutboxMutationID,
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date,
        eligibleAt: Date,
        errorCode: String
    ) async throws {
        try validateNonempty(errorCode, field: "retry error code")
        _ = try await transact(accountID: accountID) { entries in
            var mutation = try leasedMutation(
                entries: entries, id: id, owner: owner, token: token, now: now
            )
            mutation.transition(to: .retryScheduled(MutationRetry(
                eligibleAt: max(now, eligibleAt), errorCode: errorCode
            )))
            entries[id] = mutation
            return ((), [id])
        }
    }

    public func markConflict(
        id: OutboxMutationID,
        accountID: StorageAccountID,
        owner: String,
        token: String,
        now: Date,
        localRevision: UInt64?,
        serverRevision: UInt64?,
        reason: String
    ) async throws {
        try validateNonempty(reason, field: "conflict reason")
        _ = try await transact(accountID: accountID) { entries in
            var mutation = try leasedMutation(
                entries: entries, id: id, owner: owner, token: token, now: now
            )
            mutation.transition(to: .conflicted(MutationConflict(
                detectedAt: now,
                localRevision: localRevision,
                serverRevision: serverRevision,
                reason: reason
            )))
            entries[id] = mutation
            return ((), [id])
        }
    }

    public func resolveConflict(
        id: OutboxMutationID,
        accountID: StorageAccountID,
        resolution: ConflictResolution,
        now: Date
    ) async throws {
        _ = try await transact(accountID: accountID) { entries in
            guard var mutation = entries[id] else {
                throw MutationOutboxError.mutationNotFound(id)
            }
            guard case .conflicted = mutation.state else {
                throw MutationOutboxError.invalidTransition(id, mutation.state)
            }
            switch resolution {
            case .retry: mutation.transition(to: .pending)
            case .discard(let reason):
                try validateNonempty(reason, field: "discard reason")
                mutation.transition(to: .discarded(at: now, reason: reason))
            }
            entries[id] = mutation
            return ((), [id])
        }
    }

    public func mutations(accountID: StorageAccountID) async throws -> [QueuedMutation] {
        let snapshot = try await repository.snapshot(for: accountID)
        return try decodeEntries(snapshot).values.sorted(by: mutationOrder)
    }

    public func wipe(accountID: StorageAccountID) async throws {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            let operations = snapshot.records.keys
                .filter { $0.namespace == Self.namespace }
                .sorted { $0.id < $1.id }
                .map(StorageOperation.remove)
            do {
                _ = try await repository.apply(StorageTransaction(
                    accountID: accountID,
                    expectedStoreVersion: snapshot.version,
                    operations: operations
                ))
                return
            } catch AccountStorageError.versionConflict where attempt + 1 < maximumTransactionAttempts {
                continue
            } catch AccountStorageError.versionConflict {
                throw PersistentMutationOutboxError.concurrentWriteLimitExceeded
            }
        }
    }

    private func transact<Result: Sendable>(
        accountID: StorageAccountID,
        _ body: (inout [OutboxMutationID: QueuedMutation]) throws -> (Result, Set<OutboxMutationID>)
    ) async throws -> Result {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            var entries = try decodeEntries(snapshot)
            let (result, changedIDs) = try body(&entries)
            let operations = try changedIDs.sorted { $0.rawValue < $1.rawValue }.map { id in
                guard let mutation = entries[id] else {
                    throw PersistentMutationOutboxError.corruptRecord(
                        RecordKey(namespace: Self.namespace, id: id.rawValue)
                    )
                }
                let key = RecordKey(namespace: Self.namespace, id: id.rawValue)
                let previousRevision = snapshot.records[key]?.revision ?? 0
                return StorageOperation.upsert(StoredRecord(
                    accountID: accountID,
                    key: key,
                    revision: previousRevision + 1,
                    updatedAt: mutationStateDate(mutation),
                    payload: try encoder.encode(mutation)
                ))
            }
            do {
                _ = try await repository.apply(StorageTransaction(
                    accountID: accountID,
                    expectedStoreVersion: snapshot.version,
                    operations: operations
                ))
                return result
            } catch AccountStorageError.versionConflict where attempt + 1 < maximumTransactionAttempts {
                continue
            } catch AccountStorageError.versionConflict {
                throw PersistentMutationOutboxError.concurrentWriteLimitExceeded
            }
        }
        throw PersistentMutationOutboxError.concurrentWriteLimitExceeded
    }

    private func decodeEntries(
        _ snapshot: AccountStoreSnapshot
    ) throws -> [OutboxMutationID: QueuedMutation] {
        var entries: [OutboxMutationID: QueuedMutation] = [:]
        for record in snapshot.records.values where record.key.namespace == Self.namespace {
            guard !record.isTombstone, let payload = record.payload,
                let mutation = try? decoder.decode(QueuedMutation.self, from: payload),
                mutation.draft.accountID == snapshot.accountID,
                mutation.draft.id.rawValue == record.key.id,
                entries.updateValue(mutation, forKey: mutation.draft.id) == nil
            else { throw PersistentMutationOutboxError.corruptRecord(record.key) }
            do { try validate(mutation.draft) }
            catch { throw PersistentMutationOutboxError.corruptRecord(record.key) }
        }
        return entries
    }

    private func leasedMutation(
        entries: [OutboxMutationID: QueuedMutation],
        id: OutboxMutationID,
        owner: String,
        token: String,
        now: Date
    ) throws -> QueuedMutation {
        guard let mutation = entries[id] else { throw MutationOutboxError.mutationNotFound(id) }
        guard case .leased(let lease) = mutation.state else {
            throw MutationOutboxError.invalidTransition(id, mutation.state)
        }
        guard lease.owner == owner, lease.token == token else {
            throw MutationOutboxError.leaseMismatch(id)
        }
        guard lease.expiresAt > now else { throw MutationOutboxError.leaseExpired(id) }
        return mutation
    }

    private func mutationStateDate(_ mutation: QueuedMutation) -> Date {
        switch mutation.state {
        case .pending: mutation.draft.createdAt
        case .leased(let value): value.leasedAt
        case .retryScheduled(let value): value.eligibleAt
        case .conflicted(let value): value.detectedAt
        case .acknowledged(let value): value
        case .discarded(let value, _): value
        }
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
        lhs.accountID == rhs.accountID && lhs.idempotencyKey == rhs.idempotencyKey
            && lhs.entity == rhs.entity && lhs.operation == rhs.operation
            && lhs.payload == rhs.payload
    }

    private func mutationOrder(_ lhs: QueuedMutation, _ rhs: QueuedMutation) -> Bool {
        lhs.draft.createdAt == rhs.draft.createdAt
            ? lhs.draft.id.rawValue < rhs.draft.id.rawValue
            : lhs.draft.createdAt < rhs.draft.createdAt
    }
}
