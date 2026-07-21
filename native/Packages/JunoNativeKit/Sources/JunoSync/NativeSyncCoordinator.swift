import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage

public struct NativeSyncResult: Equatable, Sendable {
    public let cursor: String
    public let pageCount: Int
    public let changedRecordCount: Int
    public let rebuiltBaseline: Bool
}

public enum NativeSyncCoordinatorError: Error, Equatable, Sendable {
    case corruptStoredCursor
    case repeatedIndexCursor
    case staleHydration(type: String, id: String, expectedRevision: UInt64, receivedRevision: UInt64)
    case repeatedCompaction
    case retryLimitExceeded
    case concurrentWriteLimitExceeded
}

public struct NativeSyncBackoffPolicy: Equatable, Sendable {
    public let initialDelay: TimeInterval
    public let maximumDelay: TimeInterval
    public let multiplier: Double
    public let jitterRatio: Double

    public init(
        initialDelay: TimeInterval = 0.5,
        maximumDelay: TimeInterval = 30,
        multiplier: Double = 2,
        jitterRatio: Double = 0.25
    ) {
        self.initialDelay = max(0, initialDelay)
        self.maximumDelay = max(self.initialDelay, maximumDelay)
        self.multiplier = max(1, multiplier)
        self.jitterRatio = min(max(0, jitterRatio), 1)
    }

    public func delay(attempt: Int, randomUnit: Double) -> TimeInterval {
        let exponential = min(
            maximumDelay,
            initialDelay * pow(multiplier, Double(max(0, attempt)))
        )
        let centered = min(max(randomUnit, 0), 1) * 2 - 1
        return max(0, exponential * (1 + centered * jitterRatio))
    }
}

public protocol NativeSyncSleeping: Sendable {
    func sleep(seconds: TimeInterval) async throws
}

public protocol NativeSyncJitterSource: Sendable {
    func nextUnit() async -> Double
}

public struct SystemNativeSyncSleeper: NativeSyncSleeping {
    public init() {}

    public func sleep(seconds: TimeInterval) async throws {
        let milliseconds = Int64(max(0, seconds * 1_000).rounded())
        try await ContinuousClock().sleep(for: .milliseconds(milliseconds))
    }
}

public actor SystemNativeSyncJitterSource: NativeSyncJitterSource {
    public init() {}
    public func nextUnit() -> Double { Double.random(in: 0...1) }
}

/// Owns the persisted bootstrap and cursor lifecycle for exactly one repository.
/// Every network payload is fully validated and hydrated before a cursor and its
/// records are committed in the same account transaction.
public actor NativeSyncCoordinator<Repository: AccountScopedRepository> {
    private let repository: Repository
    private let bootstrapClient: NativeBootstrapClient
    private let apiClient: NativeSyncAPIClient
    private let baselineInstaller: NativeBootstrapBaselineInstaller<Repository>
    private let pageApplier: CursorPageApplier<Repository>
    private let maximumTransactionAttempts: Int

    public init(
        repository: Repository,
        sender: any NativeAuthenticatedRequestSending,
        maximumTransactionAttempts: Int = 4
    ) {
        self.repository = repository
        bootstrapClient = NativeBootstrapClient(sender: sender)
        apiClient = NativeSyncAPIClient(sender: sender)
        baselineInstaller = NativeBootstrapBaselineInstaller(
            repository: repository,
            maximumTransactionAttempts: maximumTransactionAttempts
        )
        pageApplier = CursorPageApplier(
            repository: repository,
            maximumTransactionAttempts: maximumTransactionAttempts
        )
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
    }

    @discardableResult
    public func bootstrap(for accountID: AccountID) async throws -> String {
        let checkpoint = try await bootstrapClient.fetch(for: accountID)
        var references: [NativeEntityReference] = []
        var after: String?
        var seenCursors = Set<String>()
        repeat {
            let page = try await apiClient.entityIndex(after: after, for: accountID)
            references.append(contentsOf: page.items)
            guard page.hasMore else { after = nil; break }
            guard let next = page.nextAfter, seenCursors.insert(next).inserted else {
                throw NativeSyncCoordinatorError.repeatedIndexCursor
            }
            after = next
        } while after != nil

        let entities = try await hydrate(references: references, accountID: accountID)
        let storageAccountID = StorageAccountID(accountID.rawValue)
        let records = try entities.map { try $0.storedRecord(accountID: storageAccountID) }
        _ = try await baselineInstaller.install(checkpoint: checkpoint, records: records)
        return checkpoint.currentChangeCursor
    }

    public func synchronize(for accountID: AccountID) async throws -> NativeSyncResult {
        let storageAccountID = StorageAccountID(accountID.rawValue)
        let snapshot = try await repository.snapshot(for: storageAccountID)
        var cursor = try decodeCursor(snapshot.metadata[CursorPageApplier<Repository>.cursorMetadataKey])
        var rebuilt = false
        if cursor == nil {
            try await resetSyncBaseline(accountID: storageAccountID)
            cursor = try await bootstrap(for: accountID)
            rebuilt = true
        }

        var pageCount = 0
        var changedRecordCount = 0
        var recoveredFromCompaction = false
        while true {
            do {
                let page = try await apiClient.changes(after: cursor!, for: accountID)
                let records = try await hydrate(page: page, accountID: accountID)
                if page.nextCursor == cursor, records.isEmpty {
                    try await persistCompactionFloor(
                        page.compactionFloorCursor,
                        accountID: storageAccountID
                    )
                } else {
                    let result = try await pageApplier.apply(
                        SyncChangePage(
                            accountID: storageAccountID,
                            previousCursor: cursor,
                            nextCursor: page.nextCursor,
                            changes: records,
                            metadataUpdates: [
                                NativeBootstrapBaselineInstaller<Repository>
                                    .compactionFloorMetadataKey: Data(page.compactionFloorCursor.utf8)
                            ]
                        )
                    )
                    changedRecordCount += result.appliedRecordCount
                }
                pageCount += 1
                cursor = page.nextCursor
                if !page.hasMore {
                    return NativeSyncResult(
                        cursor: cursor!,
                        pageCount: pageCount,
                        changedRecordCount: changedRecordCount,
                        rebuiltBaseline: rebuilt
                    )
                }
            } catch NativeSyncAPIError.cursorCompacted {
                guard !recoveredFromCompaction else {
                    throw NativeSyncCoordinatorError.repeatedCompaction
                }
                try await resetSyncBaseline(accountID: storageAccountID)
                cursor = try await bootstrap(for: accountID)
                rebuilt = true
                recoveredFromCompaction = true
            }
        }
    }

    public func synchronizeWithRetry(
        for accountID: AccountID,
        maximumAttempts: Int = 6,
        policy: NativeSyncBackoffPolicy = NativeSyncBackoffPolicy(),
        sleeper: any NativeSyncSleeping = SystemNativeSyncSleeper(),
        jitter: any NativeSyncJitterSource = SystemNativeSyncJitterSource()
    ) async throws -> NativeSyncResult {
        let attempts = max(1, maximumAttempts)
        for attempt in 0..<attempts {
            do { return try await synchronize(for: accountID) }
            catch {
                guard attempt + 1 < attempts, Self.isRetryable(error) else {
                    if attempt + 1 == attempts, Self.isRetryable(error) {
                        throw NativeSyncCoordinatorError.retryLimitExceeded
                    }
                    throw error
                }
                try await sleeper.sleep(
                    seconds: policy.delay(attempt: attempt, randomUnit: await jitter.nextUnit())
                )
            }
        }
        throw NativeSyncCoordinatorError.retryLimitExceeded
    }

    private func hydrate(
        references: [NativeEntityReference],
        accountID: AccountID
    ) async throws -> [NativeHydratedEntity] {
        let grouped = Dictionary(grouping: references, by: \.type)
        var result: [NativeHydratedEntity] = []
        for type in grouped.keys.sorted() {
            let typeReferences = grouped[type]!.sorted { $0.id < $1.id }
            for batch in typeReferences.chunked(maximumCount: 100) {
                let hydrated = try await apiClient.entities(
                    type: type,
                    ids: batch.map(\.id),
                    for: accountID
                )
                for (reference, entity) in zip(batch, hydrated) where entity.revision < reference.revision {
                    throw NativeSyncCoordinatorError.staleHydration(
                        type: type,
                        id: reference.id,
                        expectedRevision: reference.revision,
                        receivedRevision: entity.revision
                    )
                }
                result.append(contentsOf: hydrated)
            }
        }
        return result
    }

    private func hydrate(
        page: NativeChangePage,
        accountID: AccountID
    ) async throws -> [StoredRecord] {
        var newest: [RecordKey: NativeEntityReference] = [:]
        for change in page.changes {
            let key = RecordKey(namespace: change.entityType, id: change.entityID)
            if newest[key]?.revision ?? 0 < change.revision {
                newest[key] = NativeEntityReference(
                    type: change.entityType,
                    id: change.entityID,
                    revision: change.revision
                )
            }
        }
        let hydrated = try await hydrate(references: Array(newest.values), accountID: accountID)
        let storageAccountID = StorageAccountID(accountID.rawValue)
        return try hydrated.map { try $0.storedRecord(accountID: storageAccountID) }
    }

    private func resetSyncBaseline(accountID: StorageAccountID) async throws {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            var operations = snapshot.records.keys
                .filter { NativeSyncAPIClient.entityTypes.contains($0.namespace) }
                .sorted { ($0.namespace, $0.id) < ($1.namespace, $1.id) }
                .map(StorageOperation.remove)
            operations.append(contentsOf: snapshot.metadata.keys
                .filter { $0.hasPrefix("sync.") }
                .sorted()
                .map(StorageOperation.removeMetadata))
            do {
                _ = try await repository.apply(
                    StorageTransaction(
                        accountID: accountID,
                        expectedStoreVersion: snapshot.version,
                        operations: operations
                    )
                )
                return
            } catch AccountStorageError.versionConflict where attempt + 1 < maximumTransactionAttempts {
                continue
            } catch AccountStorageError.versionConflict {
                throw NativeSyncCoordinatorError.concurrentWriteLimitExceeded
            }
        }
    }

    private func persistCompactionFloor(
        _ floor: String,
        accountID: StorageAccountID
    ) async throws {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            do {
                _ = try await repository.apply(
                    StorageTransaction(
                        accountID: accountID,
                        expectedStoreVersion: snapshot.version,
                        operations: [.setMetadata(
                            key: NativeBootstrapBaselineInstaller<Repository>
                                .compactionFloorMetadataKey,
                            value: Data(floor.utf8)
                        )]
                    )
                )
                return
            } catch AccountStorageError.versionConflict where attempt + 1 < maximumTransactionAttempts {
                continue
            } catch AccountStorageError.versionConflict {
                throw NativeSyncCoordinatorError.concurrentWriteLimitExceeded
            }
        }
    }

    private func decodeCursor(_ data: Data?) throws -> String? {
        guard let data else { return nil }
        guard let cursor = String(data: data, encoding: .utf8),
            cursor == "0" || (cursor.first != "0" && cursor.utf8.allSatisfy { (48...57).contains($0) })
        else { throw NativeSyncCoordinatorError.corruptStoredCursor }
        return cursor
    }

    private static func isRetryable(_ error: any Error) -> Bool {
        if let syncError = error as? NativeSyncAPIError { return syncError.isRetryable }
        if error is URLError { return true }
        if let transportError = error as? URLSessionTransportError {
            switch transportError {
            case .invalidResponse, .invalidHeaders: return true
            case .invalidConfiguration, .requestBodyTooLarge, .responseBodyTooLarge: return false
            }
        }
        return false
    }
}

private extension Array {
    func chunked(maximumCount: Int) -> [[Element]] {
        guard !isEmpty else { return [] }
        var result: [[Element]] = []
        var index = startIndex
        while index < endIndex {
            let next = self.index(index, offsetBy: maximumCount, limitedBy: endIndex) ?? endIndex
            result.append(Array(self[index..<next]))
            index = next
        }
        return result
    }
}
