import Foundation
import SQLite3
import XCTest

@testable import JunoStorage

/// Schema 2 (`message_branches`) from two directions: that a database written by
/// the shipped version-1 build still opens and still has everything in it, and
/// that the new table behaves like a tree rather than a bag of rows.
final class SQLiteMessageBranchTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let recordKey = RecordKey(namespace: "message", id: "message-1")
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Backward compatibility

    /// The migration proof: a **pre-migration database keeps its data**.
    ///
    /// The version-1 schema below is a frozen copy, not a reference to the
    /// production constant. That is the point — if someone edits the shipped v1
    /// DDL, this test must fail, because a reader's phone still has the old
    /// bytes on disk and the migration has to work against *those*.
    func testVersionOneDatabaseOpensOnSchemaTwoWithEveryRowIntact() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let cipher = try AESGCMAccountDataCipher(
            keyData: Data(repeating: 0x5A, count: 32)
        )
        let plaintext = Data("a message written before branching existed".utf8)
        let sealed = try cipher.seal(
            plaintext,
            context: AccountDataCipherContext(
                accountID: accountA,
                recordKey: recordKey,
                revision: 4,
                updatedAt: timestamp
            )
        )

        try execute(
            at: location.databaseURL,
            sql: """
                \(Self.frozenSchemaV1)
                INSERT INTO accounts(account_id, store_version)
                    VALUES('account-a', 9);
                INSERT INTO records(
                    account_id, namespace, record_id, revision, updated_at,
                    is_tombstone, payload
                ) VALUES(
                    'account-a', 'message', 'message-1', 4, 1700000000.0, 0,
                    X'\(sealed.hexadecimal)'
                );
                INSERT INTO metadata(account_id, metadata_key, value)
                    VALUES('account-a', 'sync.changeCursor', X'3432');
                PRAGMA user_version = 1;
                """
        )
        XCTAssertEqual(try userVersion(at: location.databaseURL), 1)
        XCTAssertFalse(
            try tableExists("message_branches", at: location.databaseURL),
            "The fixture must genuinely predate the branch table"
        )

        let migrated = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        let snapshot = try await migrated.snapshot(for: accountA)

        XCTAssertEqual(snapshot.version, 9)
        XCTAssertEqual(snapshot.records[recordKey]?.payload, plaintext)
        XCTAssertEqual(snapshot.records[recordKey]?.revision, 4)
        XCTAssertEqual(snapshot.records[recordKey]?.updatedAt, timestamp)
        XCTAssertEqual(snapshot.metadata["sync.changeCursor"], Data("42".utf8))
        // The rows that came from a branch-unaware build have no topology, and
        // that absence is the honest answer: they are a plain linear transcript,
        // not a tree with unknown edges.
        let migratedLinks = try await migrated.messageBranchLinks(for: accountA)
        XCTAssertTrue(migratedLinks.isEmpty)
        try await migrated.close()

        XCTAssertEqual(try userVersion(at: location.databaseURL), 2)
        XCTAssertTrue(try tableExists("message_branches", at: location.databaseURL))

        // And it is still openable a second time: the migration is idempotent
        // because `user_version` now says the step has run.
        let reopened = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        let again = try await reopened.snapshot(for: accountA)
        XCTAssertEqual(again.records[recordKey]?.payload, plaintext)
        XCTAssertEqual(again.version, 9)
        try await reopened.close()
    }

    /// A migrated version-1 database can then be branched — proving the new
    /// table is fully usable on a file that was not created by schema 2.
    func testMigratedDatabaseAcceptsBranchLinks() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let cipher = try AESGCMAccountDataCipher(
            keyData: Data(repeating: 0x11, count: 32)
        )
        try execute(
            at: location.databaseURL,
            sql: """
                \(Self.frozenSchemaV1)
                INSERT INTO accounts(account_id, store_version) VALUES('account-a', 1);
                PRAGMA user_version = 1;
                """
        )

        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        try await store.recordMessageBranchLinks(
            [link(messageID: "m1", parent: nil), link(messageID: "m2", parent: "m1")],
            for: accountA
        )
        let links = try await store.messageBranchLinks(for: accountA)
        XCTAssertEqual(Set(links.map(\.messageID)), ["m1", "m2"])
        XCTAssertEqual(links.first { $0.messageID == "m2" }?.parentMessageID, "m1")
        try await store.close()
    }

    // MARK: - Tree behaviour

    func testBranchLinksSurviveReopenAndKeepParentChildLinks() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let cipher = try AESGCMAccountDataCipher(
            keyData: Data(repeating: 0x22, count: 32)
        )
        let first = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        try await first.recordMessageBranchLinks(
            [
                link(messageID: "root", parent: nil),
                link(messageID: "answer", parent: "root"),
                link(messageID: "revision", parent: nil, branchIndex: 1),
            ],
            for: accountA
        )
        try await first.close()

        let reopened = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: cipher
        )
        let links = try await reopened.messageBranchLinks(for: accountA)
        XCTAssertEqual(links.count, 3)
        XCTAssertNil(links.first { $0.messageID == "root" }?.parentMessageID)
        XCTAssertEqual(links.first { $0.messageID == "answer" }?.parentMessageID, "root")
        XCTAssertEqual(links.first { $0.messageID == "revision" }?.branchIndex, 1)
        try await reopened.close()
    }

    /// Two active siblings is not a state the timeline can render, so the write
    /// path must make it unreachable rather than trust every caller.
    func testRecordingAnActiveSiblingDeactivatesTheOthers() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: try AESGCMAccountDataCipher(keyData: Data(repeating: 0x33, count: 32))
        )
        try await store.recordMessageBranchLinks(
            [
                link(messageID: "question", parent: nil),
                link(messageID: "answer-a", parent: "question", branchIndex: 0),
            ],
            for: accountA
        )
        try await store.recordMessageBranchLinks(
            [link(messageID: "answer-b", parent: "question", branchIndex: 1)],
            for: accountA
        )

        let links = try await store.messageBranchLinks(for: accountA)
        let active = links.filter { $0.parentMessageID == "question" && $0.isActiveBranch }
        XCTAssertEqual(active.map(\.messageID), ["answer-b"])
        // The deactivated sibling is still there — deactivating is not deleting.
        XCTAssertTrue(links.contains { $0.messageID == "answer-a" })

        let reactivated = try await store.activateMessageBranch(
            messageID: "answer-a",
            for: accountA
        )
        XCTAssertTrue(reactivated)
        let switched = try await store.messageBranchLinks(for: accountA)
        XCTAssertEqual(
            switched.filter { $0.parentMessageID == "question" && $0.isActiveBranch }
                .map(\.messageID),
            ["answer-a"]
        )
        try await store.close()
    }

    /// Roots are siblings too. A NULL parent compared with `= ?` matches nothing
    /// in SQLite, so this is the case a naive single-statement implementation
    /// silently gets wrong.
    func testRootSiblingsAlsoHaveExactlyOneActiveBranch() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: try AESGCMAccountDataCipher(keyData: Data(repeating: 0x44, count: 32))
        )
        try await store.recordMessageBranchLinks(
            [link(messageID: "opening", parent: nil, branchIndex: 0)],
            for: accountA
        )
        try await store.recordMessageBranchLinks(
            [link(messageID: "reworded-opening", parent: nil, branchIndex: 1)],
            for: accountA
        )

        let roots = try await store.messageBranchLinks(for: accountA)
            .filter { $0.parentMessageID == nil && $0.isActiveBranch }
        XCTAssertEqual(roots.map(\.messageID), ["reworded-opening"])
        try await store.close()
    }

    func testActivatingAnUnbranchedMessageReportsThatNothingHappened() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: try AESGCMAccountDataCipher(keyData: Data(repeating: 0x55, count: 32))
        )
        let switched = try await store.activateMessageBranch(
            messageID: "never-branched",
            for: accountA
        )
        XCTAssertFalse(switched)
        let links = try await store.messageBranchLinks(for: accountA)
        XCTAssertTrue(links.isEmpty)
        try await store.close()
    }

    func testSelfParentedLinkIsRejectedAndTakesTheWholeBatchWithIt() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: try AESGCMAccountDataCipher(keyData: Data(repeating: 0x66, count: 32))
        )
        do {
            try await store.recordMessageBranchLinks(
                [
                    link(messageID: "fine", parent: nil),
                    link(messageID: "loop", parent: "loop"),
                ],
                for: accountA
            )
            XCTFail("A message parented to itself must not be written")
        } catch {
            XCTAssertEqual(
                error as? AccountStorageError,
                .invalidBranchLink(messageID: "loop")
            )
        }
        let links = try await store.messageBranchLinks(for: accountA)
        XCTAssertTrue(links.isEmpty)
        try await store.close()
    }

    func testWipeAndConversationDeleteRemoveOnlyTheirOwnEdges() async throws {
        let location = try BranchDatabaseLocation()
        defer { location.remove() }
        let store = try SQLiteAccountRepository(
            databaseURL: location.databaseURL,
            cipher: try AESGCMAccountDataCipher(keyData: Data(repeating: 0x77, count: 32))
        )
        try await store.recordMessageBranchLinks(
            [
                link(messageID: "a1", parent: nil, conversationID: "conversation-1"),
                link(messageID: "b1", parent: nil, conversationID: "conversation-2"),
            ],
            for: accountA
        )
        try await store.recordMessageBranchLinks(
            [link(messageID: "other-account", parent: nil)],
            for: accountB
        )

        try await store.removeMessageBranchLinks(
            conversationID: "conversation-1",
            for: accountA
        )
        let remaining = try await store.messageBranchLinks(for: accountA)
        XCTAssertEqual(remaining.map(\.messageID), ["b1"])

        try await store.wipe(accountID: accountA)
        let wiped = try await store.messageBranchLinks(for: accountA)
        let preserved = try await store.messageBranchLinks(for: accountB)
        XCTAssertTrue(wiped.isEmpty)
        XCTAssertEqual(preserved.map(\.messageID), ["other-account"])
        try await store.close()
    }

    // MARK: - Helpers

    private func link(
        messageID: String,
        parent: String?,
        branchIndex: Int = 0,
        conversationID: String = "conversation-1"
    ) -> MessageBranchLink {
        MessageBranchLink(
            conversationID: conversationID,
            messageID: messageID,
            parentMessageID: parent,
            branchIndex: branchIndex,
            isActiveBranch: true,
            createdAt: timestamp
        )
    }

    private func execute(at url: URL, sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open_v2(
            url.path,
            &database,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
            nil
        ) == SQLITE_OK, let database else {
            throw BranchTestError.open
        }
        defer { sqlite3_close_v2(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw BranchTestError.statement(String(cString: sqlite3_errmsg(database)))
        }
    }

    private func userVersion(at url: URL) throws -> Int32 {
        try scalar(at: url, sql: "PRAGMA user_version") { sqlite3_column_int($0, 0) }
    }

    private func tableExists(_ name: String, at url: URL) throws -> Bool {
        try scalar(
            at: url,
            sql: "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='\(name)'"
        ) { sqlite3_column_int($0, 0) == 1 }
    }

    private func scalar<Value>(
        at url: URL,
        sql: String,
        _ read: (OpaquePointer) -> Value
    ) throws -> Value {
        var database: OpaquePointer?
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK,
            let database
        else { throw BranchTestError.open }
        defer { sqlite3_close_v2(database) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
            let statement
        else { throw BranchTestError.statement(sql) }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw BranchTestError.statement(sql)
        }
        return read(statement)
    }

    /// The version-1 schema exactly as the shipped build wrote it.
    ///
    /// Frozen on purpose. A migration test that built its fixture from the
    /// current source would pass no matter how the old schema was rewritten,
    /// which is the one thing it is here to catch.
    private static let frozenSchemaV1 = """
        CREATE TABLE accounts (
            account_id TEXT PRIMARY KEY NOT NULL,
            store_version INTEGER NOT NULL CHECK(store_version >= 0)
        );
        CREATE TABLE records (
            account_id TEXT NOT NULL,
            namespace TEXT NOT NULL,
            record_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision >= 0),
            updated_at REAL NOT NULL,
            is_tombstone INTEGER NOT NULL CHECK(is_tombstone IN (0, 1)),
            payload BLOB,
            PRIMARY KEY(account_id, namespace, record_id),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
            CHECK(is_tombstone = 0 OR payload IS NULL)
        ) WITHOUT ROWID;
        CREATE TABLE metadata (
            account_id TEXT NOT NULL,
            metadata_key TEXT NOT NULL,
            value BLOB NOT NULL,
            PRIMARY KEY(account_id, metadata_key),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        """
}

private enum BranchTestError: Error {
    case open
    case statement(String)
}

private final class BranchDatabaseLocation: @unchecked Sendable {
    let directoryURL: URL
    let databaseURL: URL

    init() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-branch-tests-\(UUID().uuidString)")
        databaseURL = directoryURL.appendingPathComponent("accounts.sqlite3")
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: false
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: directoryURL)
    }
}

private extension Data {
    /// Hex for an `X'…'` literal, so the fixture can be written with plain
    /// `sqlite3_exec` rather than a bound-parameter dance.
    var hexadecimal: String {
        map { String(format: "%02X", $0) }.joined()
    }
}
