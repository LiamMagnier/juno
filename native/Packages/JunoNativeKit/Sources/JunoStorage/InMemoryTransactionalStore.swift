import Foundation

/// Transactional actor intended only for deterministic tests and development.
///
/// Production applications must inject a durable, encrypted SQLite-backed
/// implementation of `AccountScopedRepository`. This type deliberately never
/// serializes records to JSON, UserDefaults, or the filesystem.
public actor InMemoryTransactionalStore: AccountScopedRepository {
    private struct Bucket {
        var version: UInt64 = 0
        var records: [RecordKey: StoredRecord] = [:]
        var metadata: [String: Data] = [:]
        /// Branch edges keyed by message id, mirroring the SQLite table's
        /// primary key. Deliberately *outside* `version`: a branch edge is
        /// client-owned topology with no server revision, so bumping the store
        /// version for one would make sync think a synced record had changed.
        var branchLinks: [String: MessageBranchLink] = [:]
    }

    private var buckets: [StorageAccountID: Bucket] = [:]

    public init() {}

    public func snapshot(for accountID: StorageAccountID) throws -> AccountStoreSnapshot {
        try StorageValidation.accountID(accountID)
        let bucket = buckets[accountID] ?? Bucket()
        return AccountStoreSnapshot(
            accountID: accountID,
            version: bucket.version,
            records: bucket.records,
            metadata: bucket.metadata
        )
    }

    @discardableResult
    public func apply(_ transaction: StorageTransaction) throws -> StorageCommit {
        try StorageValidation.transaction(transaction)

        let current = buckets[transaction.accountID] ?? Bucket()
        if let expected = transaction.expectedStoreVersion, expected != current.version {
            throw AccountStorageError.versionConflict(
                expected: expected,
                actual: current.version
            )
        }

        // Work on a value copy so any validation failure rolls back the entire
        // transaction, including operations that preceded the invalid one.
        var candidate = current
        var changedRecords = Set<RecordKey>()
        var changedMetadata = Set<String>()

        for operation in transaction.operations {
            switch operation {
            case let .upsert(record):
                if candidate.records[record.key] != record {
                    candidate.records[record.key] = record
                    changedRecords.insert(record.key)
                }

            case let .remove(key):
                if candidate.records.removeValue(forKey: key) != nil {
                    changedRecords.insert(key)
                }

            case let .setMetadata(key, value):
                if candidate.metadata[key] != value {
                    candidate.metadata[key] = value
                    changedMetadata.insert(key)
                }

            case let .removeMetadata(key):
                if candidate.metadata.removeValue(forKey: key) != nil {
                    changedMetadata.insert(key)
                }
            }
        }

        if !changedRecords.isEmpty || !changedMetadata.isEmpty {
            candidate.version += 1
            buckets[transaction.accountID] = candidate
        }

        return StorageCommit(
            accountID: transaction.accountID,
            version: candidate.version,
            changedRecords: changedRecords,
            changedMetadataKeys: changedMetadata
        )
    }

    public func wipe(accountID: StorageAccountID) throws {
        try StorageValidation.accountID(accountID)
        buckets.removeValue(forKey: accountID)
    }

    // MARK: - Conversation branch topology

    public func messageBranchLinks(
        for accountID: StorageAccountID
    ) throws -> [MessageBranchLink] {
        try StorageValidation.accountID(accountID)
        return Array((buckets[accountID] ?? Bucket()).branchLinks.values)
    }

    public func recordMessageBranchLinks(
        _ links: [MessageBranchLink],
        for accountID: StorageAccountID
    ) throws {
        try StorageValidation.accountID(accountID)
        for link in links {
            try StorageValidation.branchLink(link)
        }
        guard !links.isEmpty else { return }

        // A value copy, so a rejection mid-batch leaves the store exactly as it
        // was — the same all-or-nothing guarantee `apply` gives, and the same
        // reason: a half-written tree is a transcript with a missing middle.
        var candidate = buckets[accountID] ?? Bucket()
        for link in links {
            candidate.branchLinks[link.messageID] = link
            if link.isActiveBranch {
                deactivateSiblings(of: link, in: &candidate)
            }
        }
        buckets[accountID] = candidate
    }

    @discardableResult
    public func activateMessageBranch(
        messageID: String,
        for accountID: StorageAccountID
    ) throws -> Bool {
        try StorageValidation.accountID(accountID)
        var candidate = buckets[accountID] ?? Bucket()
        guard let existing = candidate.branchLinks[messageID] else { return false }
        deactivateSiblings(of: existing, in: &candidate)
        candidate.branchLinks[messageID] = MessageBranchLink(
            conversationID: existing.conversationID,
            messageID: existing.messageID,
            parentMessageID: existing.parentMessageID,
            branchIndex: existing.branchIndex,
            isActiveBranch: true,
            createdAt: existing.createdAt
        )
        buckets[accountID] = candidate
        return true
    }

    public func removeMessageBranchLinks(
        conversationID: String,
        for accountID: StorageAccountID
    ) throws {
        try StorageValidation.accountID(accountID)
        guard var candidate = buckets[accountID] else { return }
        candidate.branchLinks = candidate.branchLinks.filter {
            $0.value.conversationID != conversationID
        }
        buckets[accountID] = candidate
    }

    private func deactivateSiblings(
        of link: MessageBranchLink,
        in bucket: inout Bucket
    ) {
        for (messageID, sibling) in bucket.branchLinks
        where messageID != link.messageID
            && sibling.conversationID == link.conversationID
            && sibling.parentMessageID == link.parentMessageID
            && sibling.isActiveBranch
        {
            bucket.branchLinks[messageID] = MessageBranchLink(
                conversationID: sibling.conversationID,
                messageID: sibling.messageID,
                parentMessageID: sibling.parentMessageID,
                branchIndex: sibling.branchIndex,
                isActiveBranch: false,
                createdAt: sibling.createdAt
            )
        }
    }
}
