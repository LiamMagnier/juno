import Foundation

enum StorageValidation {
    static func accountID(_ accountID: StorageAccountID) throws {
        guard validText(accountID.rawValue, maximumUTF8Bytes: 256) else {
            throw AccountStorageError.invalidAccountID
        }
    }

    static func key(_ key: RecordKey) throws {
        guard validText(key.namespace, maximumUTF8Bytes: 128),
            validText(key.id, maximumUTF8Bytes: 512)
        else {
            throw AccountStorageError.invalidRecordKey(key)
        }
    }

    static func metadataKey(_ key: String) throws {
        guard validText(key, maximumUTF8Bytes: 256) else {
            throw AccountStorageError.invalidMetadataKey(key)
        }
    }

    static func record(
        _ record: StoredRecord,
        expectedAccountID: StorageAccountID
    ) throws {
        try key(record.key)
        guard record.accountID == expectedAccountID else {
            throw AccountStorageError.recordAccountMismatch(
                expected: expectedAccountID,
                actual: record.accountID
            )
        }
    }

    /// Rejects a branch edge that could not describe a real tree.
    ///
    /// The self-parent check is the important one: a message named as its own
    /// parent makes the active-timeline walk loop forever, and the failure would
    /// surface as a hung transcript rather than as the bad write it actually is.
    /// Cycles longer than one hop cannot be caught here — a single edge carries
    /// no path — so the projection is separately written to stop at a message it
    /// has already visited.
    static func branchLink(_ link: MessageBranchLink) throws {
        guard validText(link.conversationID, maximumUTF8Bytes: 512),
            validText(link.messageID, maximumUTF8Bytes: 512),
            link.parentMessageID.map({ validText($0, maximumUTF8Bytes: 512) }) ?? true,
            link.parentMessageID != link.messageID,
            link.branchIndex >= 0,
            link.createdAt.timeIntervalSince1970.isFinite
        else {
            throw AccountStorageError.invalidBranchLink(messageID: link.messageID)
        }
    }

    static func transaction(_ transaction: StorageTransaction) throws {
        try accountID(transaction.accountID)
        for operation in transaction.operations {
            switch operation {
            case .upsert(let storedRecord):
                try record(
                    storedRecord,
                    expectedAccountID: transaction.accountID
                )
            case .remove(let key):
                try self.key(key)
            case .setMetadata(let key, _), .removeMetadata(let key):
                try metadataKey(key)
            }
        }
    }

    private static func validText(
        _ value: String,
        maximumUTF8Bytes: Int
    ) -> Bool {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            value.utf8.count <= maximumUTF8Bytes
        else {
            return false
        }
        return !value.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0)
        }
    }
}
