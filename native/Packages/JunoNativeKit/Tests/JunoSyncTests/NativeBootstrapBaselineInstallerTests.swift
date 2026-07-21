import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import XCTest
@testable import JunoSync

final class NativeBootstrapBaselineInstallerTests: XCTestCase {
    private let storageAccountID = StorageAccountID("account-a")
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testHydratedRecordsAndCursorCommitAtomically() async throws {
        let repository = InMemoryTransactionalStore()
        let installer = NativeBootstrapBaselineInstaller(repository: repository)
        let records = [record(id: "conversation-1"), record(id: "message-1")]

        let commit = try await installer.install(
            checkpoint: try checkpoint(cursor: "42"),
            records: records
        )

        XCTAssertEqual(commit.version, 1)
        XCTAssertEqual(commit.changedRecords.count, 2)
        let snapshot = try await repository.snapshot(for: storageAccountID)
        XCTAssertEqual(snapshot.records.count, 2)
        XCTAssertEqual(
            snapshot.metadata[CursorPageApplier<InMemoryTransactionalStore>
                .cursorMetadataKey],
            Data("42".utf8)
        )
        XCTAssertEqual(
            snapshot.metadata[NativeBootstrapBaselineInstaller<
                InMemoryTransactionalStore
            >.compactionFloorMetadataKey],
            Data("10".utf8)
        )
    }

    func testReplayIsIdempotentAndDifferentBaselineRequiresExplicitReset() async throws {
        let repository = InMemoryTransactionalStore()
        let installer = NativeBootstrapBaselineInstaller(repository: repository)
        let records = [record(id: "conversation-1")]
        _ = try await installer.install(
            checkpoint: try checkpoint(cursor: "42"),
            records: records
        )

        let replay = try await installer.install(
            checkpoint: try checkpoint(cursor: "42"),
            records: records
        )
        XCTAssertEqual(replay.version, 1)
        XCTAssertTrue(replay.changedRecords.isEmpty)
        XCTAssertTrue(replay.changedMetadataKeys.isEmpty)

        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "43"),
                records: records
            )
            XCTFail("A second baseline must not silently replace a live cursor")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .baselineAlreadyInstalled(
                    storedCursor: "42",
                    receivedCursor: "43"
                )
            )
        }
    }

    func testInvalidRecordCannotPersistCursor() async throws {
        let repository = InMemoryTransactionalStore()
        let installer = NativeBootstrapBaselineInstaller(repository: repository)
        let wrongAccountRecord = StoredRecord(
            accountID: StorageAccountID("account-b"),
            key: RecordKey(namespace: "conversation", id: "conversation-1"),
            revision: 1,
            updatedAt: timestamp,
            payload: Data("payload".utf8)
        )

        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "42"),
                records: [wrongAccountRecord]
            )
            XCTFail("Cross-account baseline records must fail closed")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .accountMismatch
            )
        }

        let snapshot = try await repository.snapshot(for: storageAccountID)
        XCTAssertEqual(snapshot.version, 0)
        XCTAssertTrue(snapshot.records.isEmpty)
        XCTAssertTrue(snapshot.metadata.isEmpty)
    }

    func testCorruptStoredCursorFailsWithoutMutation() async throws {
        let repository = InMemoryTransactionalStore()
        _ = try await repository.apply(
            StorageTransaction(
                accountID: storageAccountID,
                operations: [
                    .setMetadata(
                        key: CursorPageApplier<InMemoryTransactionalStore>
                            .cursorMetadataKey,
                        value: Data([0xFF])
                    )
                ]
            )
        )
        let installer = NativeBootstrapBaselineInstaller(repository: repository)

        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "42"),
                records: []
            )
            XCTFail("A corrupt cursor must fail closed")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .corruptStoredCursor
            )
        }
        let snapshot = try await repository.snapshot(for: storageAccountID)
        XCTAssertEqual(snapshot.version, 1)
    }

    func testInvalidCheckpointAndConflictingRecordsFailBeforeCommit() async throws {
        let repository = InMemoryTransactionalStore()
        let installer = NativeBootstrapBaselineInstaller(repository: repository)
        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "0042"),
                records: []
            )
            XCTFail("A noncanonical bootstrap cursor must fail")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .invalidCheckpoint
            )
        }
        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "9"),
                records: []
            )
            XCTFail("A compaction floor above the current cursor must fail")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .invalidCheckpoint
            )
        }

        let first = record(id: "conversation-1")
        let conflicting = StoredRecord(
            accountID: storageAccountID,
            key: first.key,
            revision: 2,
            updatedAt: timestamp,
            payload: Data("different".utf8)
        )
        do {
            _ = try await installer.install(
                checkpoint: try checkpoint(cursor: "42"),
                records: [first, conflicting]
            )
            XCTFail("Conflicting baseline records must fail")
        } catch {
            XCTAssertEqual(
                error as? NativeBootstrapBaselineError,
                .conflictingRecord(first.key)
            )
        }

        let snapshot = try await repository.snapshot(for: storageAccountID)
        XCTAssertEqual(snapshot.version, 0)
    }

    private func checkpoint(cursor: String) throws -> NativeBootstrapCheckpoint {
        NativeBootstrapCheckpoint(
            profile: NativeAccountProfile(
                id: try AccountID("account-a"),
                name: "Tester",
                email: "tester@juno.test",
                imageURL: nil
            ),
            currentChangeCursor: cursor,
            compactionFloorCursor: "10",
            modelManifestVersion: "models-1",
            minimumClientVersions: ["macOS": "3.0.0"]
        )
    }

    private func record(id: String) -> StoredRecord {
        StoredRecord(
            accountID: storageAccountID,
            key: RecordKey(namespace: "entity", id: id),
            revision: 1,
            updatedAt: timestamp,
            payload: Data(id.utf8)
        )
    }
}
