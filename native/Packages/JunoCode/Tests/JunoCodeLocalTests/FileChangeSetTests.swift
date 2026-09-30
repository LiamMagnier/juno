import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// A change set is one transaction: validated whole, checkpointed whole,
/// written in order, and put back whole when a write fails part-way.
final class FileChangeSetTests: XCTestCase {
    private var root: URL!
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private var checkpoints: CheckpointStore!
    private var service: FileOperationService!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-changeset-\(UUID().uuidString)")
        workspaceURL = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        checkpoints = CheckpointStore(directoryURL: root.appendingPathComponent("checkpoints"), access: access)
        service = FileOperationService(access: access, checkpoints: checkpoints)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func path(_ value: String) throws -> WorkspacePath { try WorkspacePath(value) }

    private func write(_ text: String, to name: String) throws {
        let url = workspaceURL.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func contents(_ name: String) -> String? {
        try? String(contentsOf: workspaceURL.appendingPathComponent(name), encoding: .utf8)
    }

    func testAppliesEveryKindOfChangeUnderOneCheckpoint() async throws {
        try write("old a\n", to: "a.txt")
        try write("gone\n", to: "b.txt")
        try write("move me\n", to: "src/c.txt")

        let results = try await service.applyChangeSet(
            [
                .update(path: path("a.txt"), content: "new a\n", expectedBase: FileFingerprint(of: "old a\n")),
                .delete(path: path("b.txt"), expectedBase: FileFingerprint(of: "gone\n")),
                .create(path: path("docs/d.md"), content: "# D\n"),
                .update(
                    path: path("src/c.txt"),
                    content: "moved\n",
                    expectedBase: FileFingerprint(of: "move me\n"),
                    moveTo: path("lib/c.txt")
                ),
            ],
            sessionID: sessionID
        )

        XCTAssertEqual(results.map(\.kind), [.modified, .deleted, .created, .moved])
        XCTAssertEqual(results[3].path.value, "lib/c.txt")
        XCTAssertEqual(contents("a.txt"), "new a\n")
        XCTAssertNil(contents("b.txt"))
        XCTAssertEqual(contents("docs/d.md"), "# D\n")
        XCTAssertNil(contents("src/c.txt"))
        XCTAssertEqual(contents("lib/c.txt"), "moved\n")

        let ids = Set(results.compactMap(\.checkpointID))
        XCTAssertEqual(ids.count, 1, "the whole set is one checkpoint")
        let checkpointID = try XCTUnwrap(ids.first)
        let stored = await checkpoints.checkpoint(id: checkpointID)
        let checkpoint = try XCTUnwrap(stored)
        XCTAssertEqual(checkpoint.resolvedEntries.count, 5, "a move records both ends")

        // Undo takes the whole operation back.
        try await checkpoints.restore(id: checkpoint.id, force: false)
        XCTAssertEqual(contents("a.txt"), "old a\n")
        XCTAssertEqual(contents("b.txt"), "gone\n")
        XCTAssertNil(contents("docs/d.md"))
        XCTAssertEqual(contents("src/c.txt"), "move me\n")
        XCTAssertNil(contents("lib/c.txt"))
    }

    func testAStaleFingerprintAnywhereRefusesTheWholeSet() async throws {
        try write("a\n", to: "a.txt")
        try write("b changed by someone\n", to: "b.txt")

        do {
            _ = try await service.applyChangeSet(
                [
                    .update(path: path("a.txt"), content: "A\n", expectedBase: FileFingerprint(of: "a\n")),
                    .update(path: path("b.txt"), content: "B\n", expectedBase: FileFingerprint(of: "b\n")),
                ],
                sessionID: sessionID
            )
            XCTFail("expected a refusal")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .concurrentModification(path: "b.txt"))
        }
        XCTAssertEqual(contents("a.txt"), "a\n", "validation runs before any write")
        let recorded = await checkpoints.checkpoints(for: sessionID)
        XCTAssertTrue(recorded.isEmpty, "nothing was checkpointed for a refused set")
    }

    func testAWriteThatFailsPartWayPutsBackWhatAlreadyChanged() async throws {
        try write("before\n", to: "a.txt")
        try write("x\n", to: "blocker")

        do {
            _ = try await service.applyChangeSet(
                [
                    .update(path: path("a.txt"), content: "after\n", expectedBase: FileFingerprint(of: "before\n")),
                    .create(path: path("created.txt"), content: "new\n"),
                    // `blocker` is a file, so its "directory" cannot be made.
                    .create(path: path("blocker/child.txt"), content: "never\n"),
                ],
                sessionID: sessionID
            )
            XCTFail("expected the third write to fail")
        } catch {
            XCTAssertTrue(String(describing: error).contains("blocker/child.txt"), "\(error)")
        }
        XCTAssertEqual(contents("a.txt"), "before\n")
        XCTAssertNil(contents("created.txt"))
        XCTAssertEqual(contents("blocker"), "x\n")
    }

    func testRefusesAPathNamedTwiceAndAMoveOntoAnExistingFile() async throws {
        try write("a\n", to: "a.txt")
        try write("b\n", to: "b.txt")
        do {
            _ = try await service.applyChangeSet(
                [
                    .update(path: path("a.txt"), content: "1\n", expectedBase: FileFingerprint(of: "a\n")),
                    .delete(path: path("a.txt"), expectedBase: FileFingerprint(of: "a\n")),
                ],
                sessionID: sessionID
            )
            XCTFail("expected a refusal")
        } catch let error as FileOperationError {
            guard case .invalidChangeSet = error else { return XCTFail("\(error)") }
        }
        do {
            _ = try await service.applyChangeSet(
                [.update(path: path("a.txt"), content: "1\n", expectedBase: FileFingerprint(of: "a\n"), moveTo: path("b.txt"))],
                sessionID: sessionID
            )
            XCTFail("expected a refusal")
        } catch let error as FileOperationError {
            XCTAssertEqual(error, .alreadyExists(path: "b.txt"))
        }
        XCTAssertEqual(contents("a.txt"), "a\n")
        XCTAssertEqual(contents("b.txt"), "b\n")
    }

    func testReadDataReturnsRawBytesWithTheFullSize() async throws {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x10, 0x20])
        try bytes.write(to: workspaceURL.appendingPathComponent("image.png"))
        let whole = try await service.readData(path("image.png"), maximumBytes: 1_024)
        XCTAssertEqual(whole.data, bytes)
        XCTAssertTrue(whole.isComplete)

        let head = try await service.readData(path("image.png"), maximumBytes: 4)
        XCTAssertEqual(head.data, bytes.prefix(4))
        XCTAssertEqual(head.totalByteCount, 8)
        XCTAssertFalse(head.isComplete)
    }

    func testTheTurnCaptureSeesEveryPathOfTheSet() async throws {
        try write("one\n", to: "a.txt")
        let turns = TurnCheckpointStore(directoryURL: root.appendingPathComponent("turns"), access: access)
        let capturing = TurnCapturingFileOperations(base: service, turns: turns)
        await turns.openTurn(id: "turn-1", sessionID: sessionID, openedAt: Date())

        _ = try await capturing.applyChangeSet(
            [
                .update(path: path("a.txt"), content: "two\n", expectedBase: FileFingerprint(of: "one\n")),
                .create(path: path("b.txt"), content: "b\n"),
            ],
            sessionID: sessionID
        )
        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(Set(recorded.first?.files.map(\.path.value) ?? []), ["a.txt", "b.txt"])

        // A rewind of the turn takes back the whole set.
        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
        XCTAssertEqual(contents("a.txt"), "one\n")
        XCTAssertNil(contents("b.txt"))
    }
}
