import Foundation

/// An immutable backend account identifier used to partition all local data.
///
/// The value is intentionally opaque. Validation happens at the repository
/// boundary so decoded values can still be represented and rejected safely.
public struct StorageAccountID: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.init(rawValue: rawValue)
    }
}

/// A stable key inside an account partition.
public struct RecordKey: Hashable, Codable, Sendable {
    public let namespace: String
    public let id: String

    public init(namespace: String, id: String) {
        self.namespace = namespace
        self.id = id
    }
}

/// The platform-neutral record representation shared by storage and sync.
///
/// `payload` is an opaque, contract-versioned byte sequence. A production
/// adapter is responsible for encrypting sensitive values before persistence.
/// Tombstones never retain a payload.
public struct StoredRecord: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let key: RecordKey
    public let revision: UInt64
    public let updatedAt: Date
    public let isTombstone: Bool
    public let payload: Data?

    public init(
        accountID: StorageAccountID,
        key: RecordKey,
        revision: UInt64,
        updatedAt: Date,
        isTombstone: Bool = false,
        payload: Data? = nil
    ) {
        self.accountID = accountID
        self.key = key
        self.revision = revision
        self.updatedAt = updatedAt
        self.isTombstone = isTombstone
        self.payload = isTombstone ? nil : payload
    }
}

public struct AccountStoreSnapshot: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let version: UInt64
    public let records: [RecordKey: StoredRecord]
    public let metadata: [String: Data]

    public init(
        accountID: StorageAccountID,
        version: UInt64,
        records: [RecordKey: StoredRecord],
        metadata: [String: Data]
    ) {
        self.accountID = accountID
        self.version = version
        self.records = records
        self.metadata = metadata
    }
}

public enum StorageOperation: Equatable, Sendable {
    case upsert(StoredRecord)
    case remove(RecordKey)
    case setMetadata(key: String, value: Data)
    case removeMetadata(key: String)
}

/// A transaction is applied entirely or not at all within one account.
public struct StorageTransaction: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let expectedStoreVersion: UInt64?
    public let operations: [StorageOperation]

    public init(
        accountID: StorageAccountID,
        expectedStoreVersion: UInt64? = nil,
        operations: [StorageOperation]
    ) {
        self.accountID = accountID
        self.expectedStoreVersion = expectedStoreVersion
        self.operations = operations
    }
}

public struct StorageCommit: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let version: UInt64
    public let changedRecords: Set<RecordKey>
    public let changedMetadataKeys: Set<String>

    public init(
        accountID: StorageAccountID,
        version: UInt64,
        changedRecords: Set<RecordKey>,
        changedMetadataKeys: Set<String>
    ) {
        self.accountID = accountID
        self.version = version
        self.changedRecords = changedRecords
        self.changedMetadataKeys = changedMetadataKeys
    }
}

public enum AccountStorageError: Error, Equatable, Sendable {
    case invalidAccountID
    case invalidRecordKey(RecordKey)
    case invalidMetadataKey(String)
    case recordAccountMismatch(expected: StorageAccountID, actual: StorageAccountID)
    case versionConflict(expected: UInt64, actual: UInt64)
}

extension AccountStorageError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidAccountID:
            "The account identifier is empty."
        case let .invalidRecordKey(key):
            "The record key is invalid: \(key.namespace)/\(key.id)."
        case let .invalidMetadataKey(key):
            "The metadata key is invalid: \(key)."
        case let .recordAccountMismatch(expected, actual):
            "The record belongs to \(actual.rawValue), not \(expected.rawValue)."
        case let .versionConflict(expected, actual):
            "The store changed concurrently (expected \(expected), actual \(actual))."
        }
    }
}

/// Repository boundary implemented later by the production SQLite adapter.
public protocol AccountScopedRepository: Sendable {
    func snapshot(for accountID: StorageAccountID) async throws -> AccountStoreSnapshot

    @discardableResult
    func apply(_ transaction: StorageTransaction) async throws -> StorageCommit

    func wipe(accountID: StorageAccountID) async throws
}
