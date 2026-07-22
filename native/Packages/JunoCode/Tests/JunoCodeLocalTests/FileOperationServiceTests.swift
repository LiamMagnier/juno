import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class FileOperationServiceTests: XCTestCase {
    private var workspaceURL: URL!
    private var checkpointsURL: URL!
    private var access: WorkspaceAccess!
    private var checkpoints: CheckpointStore!
    private var service: FileOperationService!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-fops-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        checkpointsURL = base.appendingPathComponent("checkpoints")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        checkpoints = CheckpointStore(directoryURL: checkpointsURL, access: access)
        service = FileOperationService(access: access, checkpoints: checkpoints)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func path(_ value: String) throws -> WorkspacePath {
        try WorkspacePath(value)
    }

    func testCreateReadWriteRoundTrip() async throws {
        let created = try await service.create(
            path("src/hello.swift"),
            content: "print(\"hi\")\n",
            sessionID: sessionID
        )
        XCTAssertEqual(created.kind, .created)
        XCTAssertEqual(created.diff?.linesAdded, 1)
        XCTAssertNotNil(created.checkpointID)

        let read = try await service.read(path("src/hello.swift"), limit: .fileRead)
        XCTAssertEqual(read.content, "print(\"hi\")\n")
        XCTAssertEqual(read.lineCount, 1)
        XCTAssertFalse(read.wasTruncated)

        let written = try await service.write(
            path("src/hello.swift"),
            content: "print(\"bye\")\n",
            expectedBase: read.fingerprint,
            sessionID: sessionID
        )
        XCTAssertEqual(written.kind, .modified)
        XCTAssertEqual(written.diff?.linesAdded, 1)
        XCTAssertEqual(written.diff?.linesRemoved, 1)
    }

    func testCreateFailsWhenFileExists() async throws {
        _ = try await service.create(path("a.txt"), content: "x", sessionID: sessionID)
        do {
            _ = try await service.create(path("a.txt"), content: "y", sessionID: sessionID)
            XCTFail("expected failure")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .alreadyExists(path: "a.txt"))
        }
    }

    func testConcurrentModificationIsDetected() async throws {
        _ = try await service.create(path("a.txt"), content: "v1", sessionID: sessionID)
        let read = try await service.read(path("a.txt"), limit: .fileRead)
        // Simulate an external editor changing the file after the read.
        try "external".write(
            to: workspaceURL.appendingPathComponent("a.txt"),
            atomically: true,
            encoding: .utf8
        )
        do {
            _ = try await service.write(
                path("a.txt"),
                content: "v2",
                expectedBase: read.fingerprint,
                sessionID: sessionID
            )
            XCTFail("expected conflict")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .concurrentModification(path: "a.txt"))
        }
    }

    func testPatchAppliesAndRejectsAmbiguity() async throws {
        _ = try await service.create(
            path("b.txt"),
            content: "alpha\nbeta\ngamma\n",
            sessionID: sessionID
        )
        let patched = try await service.applyPatch(
            path("b.txt"),
            patch: TextPatch(target: "beta", replacement: "BETA"),
            expectedBase: nil,
            sessionID: sessionID
        )
        XCTAssertEqual(patched.diff?.linesAdded, 1)
        let read = try await service.read(path("b.txt"), limit: .fileRead)
        XCTAssertEqual(read.content, "alpha\nBETA\ngamma\n")

        do {
            _ = try await service.applyPatch(
                path("b.txt"),
                patch: TextPatch(target: "a", replacement: "z"),
                expectedBase: nil,
                sessionID: sessionID
            )
            XCTFail("expected ambiguity failure")
        } catch let error as FileOperationError {
            guard case .patchFailed(_, .ambiguousTarget) = error else {
                return XCTFail("unexpected error \(error)")
            }
        }
    }

    func testDeleteAndUndoThroughCheckpoint() async throws {
        _ = try await service.create(path("c.txt"), content: "keep me", sessionID: sessionID)
        let deletion = try await service.delete(path("c.txt"), sessionID: sessionID)
        XCTAssertEqual(deletion.kind, .deleted)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent("c.txt").path)
        )
        try await checkpoints.restore(id: deletion.checkpointID!, force: false)
        let restored = try await service.read(path("c.txt"), limit: .fileRead)
        XCTAssertEqual(restored.content, "keep me")
    }

    func testUndoCreateRemovesFile() async throws {
        let created = try await service.create(path("d.txt"), content: "temp", sessionID: sessionID)
        try await checkpoints.restore(id: created.checkpointID!, force: false)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent("d.txt").path)
        )
    }

    func testUndoRefusesWhenContentDiverged() async throws {
        let created = try await service.create(path("e.txt"), content: "v1", sessionID: sessionID)
        try "diverged".write(
            to: workspaceURL.appendingPathComponent("e.txt"),
            atomically: true,
            encoding: .utf8
        )
        do {
            try await checkpoints.restore(id: created.checkpointID!, force: false)
            XCTFail("expected divergence failure")
        } catch let error as CheckpointError {
            XCTAssertEqual(error, .currentContentDiverged(path: "e.txt"))
        }
        // Forced restore proceeds anyway.
        try await checkpoints.restore(id: created.checkpointID!, force: true)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent("e.txt").path)
        )
    }

    func testMoveFile() async throws {
        _ = try await service.create(path("old/name.txt"), content: "content", sessionID: sessionID)
        let moved = try await service.move(
            from: path("old/name.txt"),
            to: path("new/dir/name.txt"),
            sessionID: sessionID
        )
        XCTAssertEqual(moved.kind, .moved)
        let read = try await service.read(path("new/dir/name.txt"), limit: .fileRead)
        XCTAssertEqual(read.content, "content")
    }

    func testRejectsBinaryAndOversizedFiles() async throws {
        let binaryURL = workspaceURL.appendingPathComponent("bin.dat")
        try Data([0xFF, 0xFE, 0x00, 0x01]).write(to: binaryURL)
        do {
            _ = try await service.read(path("bin.dat"), limit: .fileRead)
            XCTFail("expected notUTF8 failure")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .notUTF8Text(path: "bin.dat"))
        }

        let small = FileOperationService(
            access: access,
            checkpoints: checkpoints,
            maximumFileBytes: 8
        )
        do {
            _ = try await small.create(
                path("big.txt"),
                content: "0123456789",
                sessionID: sessionID
            )
            XCTFail("expected tooLarge failure")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .tooLarge(path: "big.txt", byteCount: 10, maximumBytes: 8))
        }
    }

    func testReadTruncationKeepsFullFingerprint() async throws {
        _ = try await service.create(
            path("long.txt"),
            content: String(repeating: "a", count: 100),
            sessionID: sessionID
        )
        let read = try await service.read(
            path("long.txt"),
            limit: OutputLimit(maximumBytes: 10, truncationNotice: "…")
        )
        XCTAssertTrue(read.wasTruncated)
        XCTAssertEqual(read.byteCount, 100)
        XCTAssertEqual(
            read.fingerprint,
            FileFingerprint(of: String(repeating: "a", count: 100))
        )
    }

    func testCheckpointsPersistAcrossStoreReload() async throws {
        let created = try await service.create(path("f.txt"), content: "v1", sessionID: sessionID)
        let reloaded = CheckpointStore(directoryURL: checkpointsURL, access: access)
        let restored = await reloaded.checkpoint(id: created.checkpointID!)
        XCTAssertNotNil(restored)
        XCTAssertEqual(restored?.path.value, "f.txt")
        let list = await reloaded.checkpoints(for: sessionID)
        XCTAssertEqual(list.count, 1)
    }
}
