import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Undoing a move must leave one coherent state.
///
/// The defect: a move recorded a checkpoint for the source path only, so undo
/// wrote the source back and left the destination where it was. Undoing a
/// rename produced two files where the user had one, and the second was
/// invisible in the transcript — nothing said it was still there.
final class MoveCheckpointTests: XCTestCase {
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private var checkpoints: CheckpointStore!
    private var service: FileOperationService!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-move-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        checkpoints = CheckpointStore(
            directoryURL: base.appendingPathComponent("checkpoints"),
            access: access
        )
        service = FileOperationService(access: access, checkpoints: checkpoints)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func path(_ value: String) throws -> WorkspacePath {
        try WorkspacePath(value)
    }

    private func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: workspaceURL.appendingPathComponent(relative).path)
    }

    private func contents(_ relative: String) throws -> String {
        try String(contentsOf: workspaceURL.appendingPathComponent(relative), encoding: .utf8)
    }

    // MARK: - The duplicate

    func testUndoingAMoveRestoresTheSourceAndRemovesTheDestination() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        XCTAssertFalse(exists("a.txt"))
        XCTAssertTrue(exists("b.txt"))

        try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: false)

        XCTAssertTrue(exists("a.txt"), "the source must come back")
        XCTAssertFalse(exists("b.txt"), "and the destination must not survive as a copy")
        XCTAssertEqual(try contents("a.txt"), "body\n")
    }

    /// A rename inside one directory is the same operation and the same bug.
    func testUndoingARenameLeavesExactlyOneFile() async throws {
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        _ = try await service.create(
            path("src/old.swift"),
            content: "let a = 1\n",
            sessionID: sessionID
        )
        let move = try await service.move(
            from: path("src/old.swift"),
            to: path("src/new.swift"),
            sessionID: sessionID
        )

        try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: false)

        let listing = try FileManager.default.contentsOfDirectory(
            atPath: workspaceURL.appendingPathComponent("src").path
        )
        XCTAssertEqual(listing.sorted(), ["old.swift"])
    }

    /// Moving into a directory that did not exist creates it; undo must still
    /// take the file away rather than being defeated by the new nesting.
    func testUndoingAMoveIntoANewDirectoryRemovesTheMovedFile() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("deep/nested/b.txt"),
            sessionID: sessionID
        )
        XCTAssertTrue(exists("deep/nested/b.txt"))

        try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: false)

        XCTAssertTrue(exists("a.txt"))
        XCTAssertFalse(exists("deep/nested/b.txt"))
    }

    // MARK: - Divergence

    /// If the moved file has been edited since, undo must refuse rather than
    /// throw the edit away — and must not have half-applied on the way there.
    func testADivergedDestinationRefusesTheUndoAndChangesNothing() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        try "edited after the move\n".write(
            to: workspaceURL.appendingPathComponent("b.txt"),
            atomically: true,
            encoding: .utf8
        )

        do {
            try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: false)
            XCTFail("a diverged destination must refuse the undo")
        } catch let error as CheckpointError {
            XCTAssertEqual(error, .currentContentDiverged(path: "b.txt"))
        }

        XCTAssertFalse(exists("a.txt"), "the refused undo must not have recreated the source")
        XCTAssertEqual(try contents("b.txt"), "edited after the move\n")
    }

    /// Something reappearing at the source is divergence too: undoing would
    /// otherwise overwrite a file the user put back by hand.
    func testARecreatedSourceRefusesTheUndo() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        try "a different file, same name\n".write(
            to: workspaceURL.appendingPathComponent("a.txt"),
            atomically: true,
            encoding: .utf8
        )

        do {
            try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: false)
            XCTFail("a recreated source must refuse the undo")
        } catch let error as CheckpointError {
            XCTAssertEqual(error, .currentContentDiverged(path: "a.txt"))
        }

        XCTAssertEqual(try contents("a.txt"), "a different file, same name\n")
        XCTAssertTrue(exists("b.txt"))
    }

    /// Force is the separate, explicit action that overrides divergence.
    func testForceOverridesDivergenceAndStillLeavesOneFile() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        try "edited after the move\n".write(
            to: workspaceURL.appendingPathComponent("b.txt"),
            atomically: true,
            encoding: .utf8
        )

        try await checkpoints.restore(id: try XCTUnwrap(move.checkpointID), force: true)

        XCTAssertEqual(try contents("a.txt"), "body\n")
        XCTAssertFalse(exists("b.txt"))
    }

    // MARK: - Repetition and persistence

    /// Undo twice is a thing users do. The second must be a no-op rather than
    /// an error or a resurrection.
    func testUndoingTwiceIsIdempotent() async throws {
        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        let id = try XCTUnwrap(move.checkpointID)

        try await checkpoints.restore(id: id, force: false)
        try await checkpoints.restore(id: id, force: true)

        XCTAssertEqual(try contents("a.txt"), "body\n")
        XCTAssertFalse(exists("b.txt"))
    }

    /// A checkpoint written before operation-level entries existed still has to
    /// restore — the store reads them back from disk on the next launch.
    func testALegacySinglePathCheckpointStillRestores() async throws {
        _ = try await service.create(path("legacy.txt"), content: "v1\n", sessionID: sessionID)
        let legacy = Checkpoint(
            sessionID: sessionID,
            path: try path("legacy.txt"),
            createdAt: Date(),
            preContent: "v1\n",
            postFingerprint: FileFingerprint(of: "v2\n")
        )
        XCTAssertNil(legacy.entries, "the old shape carries no entries")
        XCTAssertEqual(legacy.resolvedEntries.count, 1)

        try await checkpoints.record(legacy)
        try "v2\n".write(
            to: workspaceURL.appendingPathComponent("legacy.txt"),
            atomically: true,
            encoding: .utf8
        )

        try await checkpoints.restore(id: legacy.id, force: false)
        XCTAssertEqual(try contents("legacy.txt"), "v1\n")
    }

    /// The move checkpoint has to survive a store reload, or undo works only
    /// until the app is restarted.
    func testAMoveCheckpointSurvivesAStoreReload() async throws {
        let directory = workspaceURL
            .deletingLastPathComponent()
            .appendingPathComponent("reloadable")
        let store = CheckpointStore(directoryURL: directory, access: access)
        let service = FileOperationService(access: access, checkpoints: store)

        _ = try await service.create(path("a.txt"), content: "body\n", sessionID: sessionID)
        let move = try await service.move(
            from: path("a.txt"),
            to: path("b.txt"),
            sessionID: sessionID
        )
        let id = try XCTUnwrap(move.checkpointID)

        let reloaded = CheckpointStore(directoryURL: directory, access: access)
        let restored = await reloaded.checkpoint(id: id)
        XCTAssertEqual(restored?.resolvedEntries.count, 2, "both ends must persist")

        try await reloaded.restore(id: id, force: false)
        XCTAssertTrue(exists("a.txt"))
        XCTAssertFalse(exists("b.txt"))
    }
}
