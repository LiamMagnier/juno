import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

/// Turn checkpoints: what each of the reader's turns changed, captured before
/// the agent's first write to each path, and put back on rewind.
final class TurnCheckpointStoreTests: XCTestCase {
    private var baseURL: URL!
    private var workspaceURL: URL!
    private var access: WorkspaceAccess!
    private var turns: TurnCheckpointStore!
    /// The reader's path to the disk: the same service, not snapshotted.
    private var service: FileOperationService!
    /// The agent's path: the service behind the capturing wrapper.
    private var agent: TurnCapturingFileOperations!
    private let sessionID = CodeSessionID()

    override func setUpWithError() throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-turn-checkpoints-\(UUID().uuidString)")
        workspaceURL = baseURL.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        rebuild(limits: .standard)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: baseURL)
    }

    private func rebuild(
        limits: TurnCheckpointStore.Limits,
        serviceMaximumFileBytes: Int = FileOperationService.defaultMaximumFileBytes
    ) {
        turns = TurnCheckpointStore(
            directoryURL: baseURL.appendingPathComponent("turns"),
            access: access,
            limits: limits
        )
        service = FileOperationService(
            access: access,
            checkpoints: CheckpointStore(
                directoryURL: baseURL.appendingPathComponent("checkpoints"),
                access: access
            ),
            maximumFileBytes: serviceMaximumFileBytes
        )
        agent = TurnCapturingFileOperations(base: service, turns: turns)
    }

    private var blobsURL: URL {
        baseURL.appendingPathComponent("turns/\(sessionID.value)/blobs")
    }

    private func storedBlobs() -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: blobsURL.path)) ?? [])
    }

    private func path(_ value: String) throws -> WorkspacePath {
        try WorkspacePath(value)
    }

    private func url(_ relative: String) -> URL {
        workspaceURL.appendingPathComponent(relative)
    }

    private func put(_ relative: String, _ content: String) throws {
        try FileManager.default.createDirectory(
            at: url(relative).deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try content.write(to: url(relative), atomically: true, encoding: .utf8)
    }

    private func read(_ relative: String) throws -> String {
        try String(contentsOf: url(relative), encoding: .utf8)
    }

    private func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: url(relative).path)
    }

    private func open(_ id: String) async {
        await turns.openTurn(id: id, sessionID: sessionID, openedAt: Date())
    }

    /// An agent overwrite, the way `write_file` does it.
    private func agentWrite(_ relative: String, _ content: String) async throws {
        let current = try read(relative)
        _ = try await agent.write(
            path(relative),
            content: content,
            expectedBase: FileFingerprint(of: current),
            sessionID: sessionID
        )
    }

    // MARK: - Capture

    func testCapturesThePreImageOnlyOnTheFirstWriteInATurn() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")

        try await agentWrite("notes.txt", "v1\n")
        try await agentWrite("notes.txt", "v2\n")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.map(\.id), ["turn-1"])
        let files = try XCTUnwrap(recorded.first?.files)
        XCTAssertEqual(files.count, 1, "one snapshot per path per turn")
        XCTAssertEqual(files[0].before.sha256, Digests.sha256Hex("v0\n"), "the first write's pre-image")
        XCTAssertEqual(files[0].after.sha256, Digests.sha256Hex("v2\n"), "the agent's last write")
    }

    func testNothingIsCapturedWithoutAnOpenTurn() async throws {
        try put("notes.txt", "v0\n")
        try await agentWrite("notes.txt", "v1\n")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertTrue(recorded.isEmpty)
    }

    func testTheReadersOwnWritesAreNotCaptured() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")

        _ = try await service.write(
            path("notes.txt"),
            content: "the reader's\n",
            expectedBase: FileFingerprint(of: "v0\n"),
            sessionID: sessionID
        )

        let files = await turns.turns(for: sessionID).first?.files
        XCTAssertEqual(files, [])
    }

    func testARefusedWriteLeavesNothingToRestore() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")

        do {
            _ = try await agent.write(
                path("notes.txt"),
                content: "stale\n",
                expectedBase: FileFingerprint(of: "not what is on disk"),
                sessionID: sessionID
            )
            XCTFail("a stale base must be refused")
        } catch {}

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertTrue(preview.isEmpty)
        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.first?.files, [], "a refused write is no file the turn edited")
        XCTAssertTrue(storedBlobs().isEmpty, "and costs no stored bytes")
    }

    /// The file service refuses anything over its limit before touching the
    /// disk. A refused delete of a large log must cost the turn nothing: not
    /// its restorability, not the snapshots it already took.
    func testARefusedDeleteOfAFileTooLargeToKeepLeavesTheTurnRestorable() async throws {
        rebuild(
            limits: .init(maximumTurns: 100, maximumBytes: 1_024 * 1_024, maximumFileBytes: 64),
            serviceMaximumFileBytes: 32
        )
        try put("notes.txt", "v0\n")
        try put("build.log", String(repeating: "x", count: 100))
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")

        do {
            _ = try await agent.delete(path("build.log"), sessionID: sessionID)
            XCTFail("the service refuses a file over its limit")
        } catch {}
        try await agentWrite("notes.txt", "v2\n")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertNil(recorded.first?.gap, "nothing changed that could not be put back")
        XCTAssertEqual(recorded.first?.files.map(\.path.value), ["notes.txt"])
        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
        XCTAssertEqual(try read("notes.txt"), "v0\n")
        XCTAssertTrue(exists("build.log"))
    }

    /// Between the service's limit and the store's, the pre-image is read —
    /// but a refused operation must not keep it, count it against the cap, or
    /// list the file as one the turn edited.
    func testARefusedOperationOnAFileTheStoreCouldKeepStoresNothing() async throws {
        rebuild(
            limits: .init(maximumTurns: 100, maximumBytes: 1_024 * 1_024, maximumFileBytes: 1_024),
            serviceMaximumFileBytes: 32
        )
        try put("fixture.json", String(repeating: "y", count: 100))
        await open("turn-1")

        do {
            _ = try await agent.applyPatch(
                path("fixture.json"),
                patch: TextPatch(target: "y", replacement: "z"),
                expectedBase: nil,
                sessionID: sessionID
            )
            XCTFail("the service refuses a file over its limit")
        } catch {}

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.first?.files, [])
        XCTAssertNil(recorded.first?.gap)
        XCTAssertTrue(storedBlobs().isEmpty)
    }

    /// The other side: a file too large to keep that a tool did change cannot
    /// be put back, so the turn says so rather than restoring half of itself.
    func testAChangedFileTooLargeToKeepMakesTheTurnUnrestorable() async throws {
        rebuild(limits: .init(maximumTurns: 100, maximumBytes: 1_024 * 1_024, maximumFileBytes: 16))
        try put("notes.txt", "v0\n")
        try put("data.txt", String(repeating: "z", count: 100))
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")
        try await agentWrite("data.txt", "small now\n")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.first?.gap, .notCaptured)
        do {
            _ = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
            XCTFail("a turn missing a pre-image cannot be restored")
        } catch let TurnCheckpointError.incomplete(gap) {
            XCTAssertEqual(gap, .notCaptured)
        }
    }

    // MARK: - Restore

    func testRestoringAnEarlierTurnUsesTheEarliestPreImage() async throws {
        try put("a.txt", "a0\n")
        try put("b.txt", "b0\n")
        await open("turn-1")
        try await agentWrite("a.txt", "a1\n")
        await open("turn-2")
        try await agentWrite("a.txt", "a2\n")
        try await agentWrite("b.txt", "b2\n")

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertEqual(preview.map(\.path.value), ["a.txt", "b.txt"])
        XCTAssertEqual(Set(preview.map(\.change)), [.revert])
        XCTAssertFalse(preview.contains(where: \.hasDiverged))

        let restored = try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)

        XCTAssertEqual(Set(restored.map(\.value)), ["a.txt", "b.txt"])
        XCTAssertEqual(try read("a.txt"), "a0\n", "back past both turns, not to turn 2's pre-image")
        XCTAssertEqual(try read("b.txt"), "b0\n")
        let after = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertTrue(after.isEmpty, "a restored turn has nothing left to restore")
    }

    func testRestoringALaterTurnLeavesEarlierTurnsWork() async throws {
        try put("a.txt", "a0\n")
        await open("turn-1")
        try await agentWrite("a.txt", "a1\n")
        await open("turn-2")
        try await agentWrite("a.txt", "a2\n")

        try await turns.restore(sessionID: sessionID, toTurn: "turn-2", force: false)

        XCTAssertEqual(try read("a.txt"), "a1\n")
        // Turn 1's snapshot still stands: the reader can go further back.
        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
        XCTAssertEqual(try read("a.txt"), "a0\n")
    }

    func testCreatedFilesAreRemovedAndDeletedOnesComeBackWithTheirMode() async throws {
        try put("tools/run.sh", "#!/bin/sh\necho hi\n")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url("tools/run.sh").path)
        await open("turn-1")

        _ = try await agent.create(path("src/new.swift"), content: "let x = 1\n", sessionID: sessionID)
        _ = try await agent.delete(path("tools/run.sh"), sessionID: sessionID)

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: preview.map { ($0.path.value, $0.change) }),
            ["src/new.swift": .remove, "tools/run.sh": .recreate]
        )

        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)

        XCTAssertFalse(exists("src/new.swift"), "a file the turn created is removed")
        XCTAssertEqual(try read("tools/run.sh"), "#!/bin/sh\necho hi\n")
        let mode = try FileManager.default.attributesOfItem(atPath: url("tools/run.sh").path)[.posixPermissions]
        XCTAssertEqual((mode as? NSNumber)?.intValue, 0o755, "the script is still executable")
    }

    func testAMoveIsUndoneAtBothEnds() async throws {
        try put("old.txt", "body\n")
        await open("turn-1")

        _ = try await agent.move(from: path("old.txt"), to: path("new.txt"), sessionID: sessionID)
        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)

        XCTAssertEqual(try read("old.txt"), "body\n")
        XCTAssertFalse(exists("new.txt"))
    }

    // MARK: - Divergence

    func testAFileEditedSinceTheAgentWroteItNeedsAnExplicitConfirm() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")
        try put("notes.txt", "the reader's edit\n")

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertEqual(preview.map(\.hasDiverged), [true])

        do {
            try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
            XCTFail("a diverged file must not be overwritten without asking")
        } catch let TurnCheckpointError.diverged(paths) {
            XCTAssertEqual(paths, ["notes.txt"])
        }
        XCTAssertEqual(try read("notes.txt"), "the reader's edit\n", "refusal changes nothing")

        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: true)
        XCTAssertEqual(try read("notes.txt"), "v0\n")
    }

    /// The reader edits a file between two turns and the second turn's agent
    /// patches elsewhere in it. The disk then matches the agent's last write,
    /// but rewinding to the first turn would still discard the reader's edit.
    func testAnEditBetweenTurnsNeedsAnExplicitConfirm() async throws {
        try put("a.swift", "line 1\nline 2\n")
        await open("turn-1")
        try await agentWrite("a.swift", "line 1 (agent)\nline 2\n")
        try put("a.swift", "line 1 (agent)\nline 2 (reader)\n")
        await open("turn-2")
        try await agentWrite("a.swift", "line 1 (agent, again)\nline 2 (reader)\n")

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertEqual(preview.map(\.hasDiverged), [true])
        do {
            try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
            XCTFail("the reader's edit must not go without asking")
        } catch let TurnCheckpointError.diverged(paths) {
            XCTAssertEqual(paths, ["a.swift"])
        }
        XCTAssertEqual(try read("a.swift"), "line 1 (agent, again)\nline 2 (reader)\n")

        // Rewinding only the second turn keeps the reader's edit, so it asks
        // nothing.
        let later = try await turns.preview(sessionID: sessionID, toTurn: "turn-2")
        XCTAssertEqual(later.map(\.hasDiverged), [false])

        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: true)
        XCTAssertEqual(try read("a.swift"), "line 1\nline 2\n")
    }

    /// The same inside one turn: an edit between two of the agent's writes is
    /// folded into its last one, and has to be remembered — across a relaunch
    /// too — for the rewind to ask.
    func testAnEditBetweenTwoWritesInOneTurnNeedsAnExplicitConfirm() async throws {
        try put("a.swift", "v0\n")
        await open("turn-1")
        try await agentWrite("a.swift", "v1\n")
        try put("a.swift", "v1 and the reader's line\n")
        try await agentWrite("a.swift", "v2 and the reader's line\n")

        rebuild(limits: .standard)

        let preview = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
        XCTAssertEqual(preview.map(\.hasDiverged), [true])
        do {
            try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
            XCTFail("the reader's edit must not go without asking")
        } catch TurnCheckpointError.diverged {}
    }

    func testARefusalLeavesEveryFileAlone() async throws {
        try put("a.txt", "a0\n")
        try put("b.txt", "b0\n")
        await open("turn-1")
        try await agentWrite("a.txt", "a1\n")
        try await agentWrite("b.txt", "b1\n")
        try put("b.txt", "edited\n")

        do {
            try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
            XCTFail("expected a divergence")
        } catch TurnCheckpointError.diverged {}

        XCTAssertEqual(try read("a.txt"), "a1\n", "no partial restore before the question is answered")
    }

    // MARK: - Persistence and limits

    func testCheckpointsSurviveARelaunch() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")
        _ = try await agent.create(path("added.txt"), content: "new\n", sessionID: sessionID)

        rebuild(limits: .standard)

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.map(\.id), ["turn-1"])
        XCTAssertEqual(recorded.first?.files.map(\.path.value), ["notes.txt", "added.txt"])
        try await turns.restore(sessionID: sessionID, toTurn: "turn-1", force: false)
        XCTAssertEqual(try read("notes.txt"), "v0\n")
        XCTAssertFalse(exists("added.txt"))
    }

    func testTurnsPastTheCapLoseTheirSnapshotsOldestFirst() async throws {
        rebuild(limits: .init(maximumTurns: 2, maximumBytes: 1_024 * 1_024, maximumFileBytes: 1_024 * 1_024))
        try put("notes.txt", "v0\n")
        for turn in 1...3 {
            await open("turn-\(turn)")
            try await agentWrite("notes.txt", "v\(turn)\n")
        }

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.map(\.gap), [.pruned, nil, nil])
        XCTAssertEqual(
            storedBlobs(),
            [Digests.sha256Hex("v1\n"), Digests.sha256Hex("v2\n")],
            "the pruned turn's bytes leave the disk with it"
        )
        do {
            _ = try await turns.preview(sessionID: sessionID, toTurn: "turn-1")
            XCTFail("a pruned turn cannot be restored")
        } catch let TurnCheckpointError.incomplete(gap) {
            XCTAssertEqual(gap, .pruned)
        }
        try await turns.restore(sessionID: sessionID, toTurn: "turn-2", force: false)
        XCTAssertEqual(try read("notes.txt"), "v1\n")
    }

    func testATurnOverTheByteCapGivesUpItsSnapshots() async throws {
        rebuild(limits: .init(maximumTurns: 100, maximumBytes: 64, maximumFileBytes: 1_024))
        try put("big.txt", String(repeating: "x", count: 100))
        await open("turn-1")
        try await agentWrite("big.txt", "small\n")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.first?.gap, .notCaptured)
        XCTAssertEqual(recorded.first?.files, [])
        XCTAssertTrue(storedBlobs().isEmpty, "the bytes that did not fit are not kept")
    }

    func testForgettingTurnsDropsThemAndTheirBytes() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")
        await open("turn-2")
        try await agentWrite("notes.txt", "v2\n")

        await turns.forgetTurns(sessionID: sessionID, from: "turn-2")

        let recorded = await turns.turns(for: sessionID)
        XCTAssertEqual(recorded.map(\.id), ["turn-1"])
        let blobs = baseURL.appendingPathComponent("turns/\(sessionID.value)/blobs")
        let stored = try FileManager.default.contentsOfDirectory(atPath: blobs.path)
        XCTAssertEqual(stored, [Digests.sha256Hex("v0\n")])
    }

    func testRemovingASessionDeletesItsSnapshots() async throws {
        try put("notes.txt", "v0\n")
        await open("turn-1")
        try await agentWrite("notes.txt", "v1\n")

        try await turns.removeSession(sessionID)

        XCTAssertFalse(FileManager.default.fileExists(
            atPath: baseURL.appendingPathComponent("turns/\(sessionID.value)").path
        ))
    }

    // MARK: - Net changes

    func testNetChangesKeepTheEarliestBeforeAndTheLatestAfter() throws {
        let path = try WorkspacePath("a.txt")
        let states = (0...2).map {
            TurnFileState.file(sha256: "sha\($0)", byteCount: 1, permissions: nil)
        }
        let first = TurnCheckpoint(
            id: "1",
            sessionID: sessionID,
            openedAt: Date(),
            files: [TurnFileSnapshot(path: path, before: states[0], after: states[1])]
        )
        let second = TurnCheckpoint(
            id: "2",
            sessionID: sessionID,
            openedAt: Date(),
            files: [TurnFileSnapshot(path: path, before: states[1], after: states[2])]
        )

        let merged = TurnCheckpoint.netChanges(of: [first, second])

        XCTAssertEqual(merged, [TurnFileSnapshot(path: path, before: states[0], after: states[2])])
        XCTAssertFalse(merged[0].hasOutsideEdits, "turn 2 found what turn 1 left")
    }

    func testNetChangesRememberAnEditBetweenTurns() throws {
        let path = try WorkspacePath("a.txt")
        let states = (0...3).map {
            TurnFileState.file(sha256: "sha\($0)", byteCount: 1, permissions: nil)
        }
        let first = TurnCheckpoint(
            id: "1",
            sessionID: sessionID,
            openedAt: Date(),
            files: [TurnFileSnapshot(path: path, before: states[0], after: states[1])]
        )
        // Turn 2 found sha2, not the sha1 turn 1 left.
        let second = TurnCheckpoint(
            id: "2",
            sessionID: sessionID,
            openedAt: Date(),
            files: [TurnFileSnapshot(path: path, before: states[2], after: states[3])]
        )

        let merged = TurnCheckpoint.netChanges(of: [first, second])

        XCTAssertEqual(merged.map(\.before), [states[0]])
        XCTAssertEqual(merged.map(\.after), [states[3]])
        XCTAssertEqual(merged.map(\.hasOutsideEdits), [true])
    }
}
