import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers each turn from a script: tool calls, then text.
final class ShipScriptedModel: AgentModelClient, @unchecked Sendable {
    private let lock = NSLock()
    private var steps: [[ModelStreamEvent]]
    private var received: [ModelTurnRequest] = []

    init(_ steps: [[ModelStreamEvent]]) {
        self.steps = steps
    }

    var requests: [ModelTurnRequest] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        lock.lock()
        received.append(request)
        let events = steps.isEmpty ? Self.reply("Done.") : steps.removeFirst()
        lock.unlock()
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }

    static func call(_ id: String, _ name: String, _ input: JSONValue) -> [ModelStreamEvent] {
        [.toolCallRequested(id: id, name: name, input: input), .turnCompleted(.toolUse)]
    }

    static func reply(_ text: String) -> [ModelStreamEvent] {
        [.textDelta(text), .turnCompleted(.endTurn)]
    }
}

/// A temporary project, store and workbench for the ship lane's session
/// tests.
@MainActor
struct ShipFixture {
    let root: URL
    let workspace: URL
    let workbench: WorkbenchModel
    let record: WorkspaceRecord

    static func make(
        model: any AgentModelClient,
        git: Bool = false,
        files: [String: String] = ["notes.txt": "hello\n"]
    ) async throws -> ShipFixture {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-ship-\(UUID().uuidString)")
        let workspace = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        for (path, content) in files {
            let url = workspace.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try content.write(to: url, atomically: true, encoding: .utf8)
        }
        if git {
            try ShipFixture.shell("git init -q -b main && git config user.email t@t.local && git config user.name T && git add -A && git commit -qm initial", in: workspace)
        }
        let workbench = WorkbenchModel(dependencies: WorkbenchModel.Dependencies(
            storageRootURL: root.appendingPathComponent("storage"),
            modelClient: model,
            availableModels: [ModelOption(modelID: "test-model", displayName: "Test")]
        ))
        workbench.resumesInterruptedRunsOnLaunch = { false }
        workbench.worktreeSetupApprovals = WorktreeSetupApprovals(
            fileURL: root.appendingPathComponent("setup-approvals.json")
        )
        await workbench.bootstrap()
        let added = await workbench.addWorkspace(grantedURL: workspace)
        let record = try XCTUnwrap(added)
        return ShipFixture(root: root, workspace: workspace, workbench: workbench, record: record)
    }

    func session(_ mode: PermissionMode = .workspaceWrite, isolated: Bool = false) async throws -> (CodeSession, SessionController) {
        let created = await workbench.createSession(
            workspaceID: record.id,
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: mode),
            isolatedWorktree: isolated
        )
        let session = try XCTUnwrap(created)
        let loaded = await workbench.controller(for: session.id)
        return (session, try XCTUnwrap(loaded))
    }

    func send(_ text: String, on controller: SessionController) async throws {
        controller.composerText = text
        await controller.send()
        await controller.awaitCurrentRun()
        for _ in 0..<400 where controller.isRunning {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func read(_ path: String, in base: URL? = nil) throws -> String {
        try String(contentsOf: (base ?? workspace).appendingPathComponent(path), encoding: .utf8)
    }

    @discardableResult
    static func shell(_ command: String, in directory: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = directory
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "shell", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: output])
        }
        return output
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

/// Fork: a new session from any of the reader's messages, the original left
/// alone (CODE_AGENT_SPEC §5.6).
@MainActor
final class SessionForkTests: XCTestCase {
    private func threeTurns() async throws -> (ShipFixture, CodeSession, SessionController) {
        let model = ShipScriptedModel([
            ShipScriptedModel.reply("First answer."),
            ShipScriptedModel.call("create", "create_file", ["path": "second.txt", "content": "two\n"]),
            ShipScriptedModel.reply("Second answer."),
            ShipScriptedModel.reply("Third answer."),
        ])
        let fixture = try await ShipFixture.make(model: model)
        let (session, controller) = try await fixture.session()
        try await fixture.send("One", on: controller)
        try await fixture.send("Two", on: controller)
        try await fixture.send("Three", on: controller)
        return (fixture, session, controller)
    }

    private func prompts(_ events: [SessionEvent]) -> [String] {
        events.compactMap { if case let .userPrompt(prompt) = $0.payload { return prompt.text } else { return nil } }
    }

    func testAForkAtTurnNCopiesExactlyTheFirstNTurnsAndLeavesTheOriginalAlone() async throws {
        let (fixture, session, controller) = try await threeTurns()
        defer { fixture.remove() }
        let store = fixture.workbench.sessionStore
        let originalEvents = await store.events(for: session.id)
        let originalConversation = await store.loadConversation(sessionID: session.id)
        let second = try XCTUnwrap(controller.rewindTurns.dropFirst().first)

        let forked = await fixture.workbench.fork(session.id, throughTurn: second.id)
        let fork = try XCTUnwrap(forked, fixture.workbench.lastError ?? "no fork")

        XCTAssertNotEqual(fork.id, session.id, "a fork is a new session")
        XCTAssertEqual(fork.title, "Fork of \(session.title)")
        XCTAssertEqual(fixture.workbench.selectedSessionID, fork.id)
        let forkEvents = await store.events(for: fork.id)
        XCTAssertEqual(prompts(forkEvents), ["One", "Two"], "exactly the first two turns")
        XCTAssertTrue(forkEvents.contains {
            if case let .assistantMessage(message) = $0.payload { return message.text == "Second answer." }
            return false
        })
        XCTAssertFalse(forkEvents.contains {
            if case let .assistantMessage(message) = $0.payload { return message.text == "Third answer." }
            return false
        })
        let forkConversation = await store.loadConversation(sessionID: fork.id)
        XCTAssertEqual(forkConversation.first, .user("One"))
        XCTAssertFalse(forkConversation.contains(.user("Three")))
        XCTAssertTrue(forkConversation.contains(.assistant("Second answer.")))

        let afterEvents = await store.events(for: session.id)
        let afterConversation = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(afterEvents, originalEvents, "the original transcript is untouched")
        XCTAssertEqual(afterConversation, originalConversation, "and so is its conversation")
        XCTAssertEqual(prompts(afterEvents), ["One", "Two", "Three"])
    }

    func testAForkOfTheWholeSessionCarriesOnFromTheEnd() async throws {
        let (fixture, session, _) = try await threeTurns()
        defer { fixture.remove() }
        let forked = await fixture.workbench.fork(session.id, throughTurn: nil, select: false)
        let fork = try XCTUnwrap(forked)
        let events = await fixture.workbench.sessionStore.events(for: fork.id)
        XCTAssertEqual(prompts(events), ["One", "Two", "Three"])
        XCTAssertEqual(fixture.workbench.selectedSessionID, session.id, "select: false leaves the window where it is")
        XCTAssertFalse(fork.status.isActive)
    }

    func testAForkInItsOwnWorktreeHoldsTheFilesAsOfThatTurn() async throws {
        let model = ShipScriptedModel([
            ShipScriptedModel.call("one", "write_file", [
                "path": "notes.txt",
                "content": "after one\n",
                "base_sha256": .string(FileFingerprint(of: "hello\n").sha256),
            ]),
            ShipScriptedModel.reply("Changed once."),
            ShipScriptedModel.call("two", "write_file", [
                "path": "notes.txt",
                "content": "after two\n",
                "base_sha256": .string(FileFingerprint(of: "after one\n").sha256),
            ]),
            ShipScriptedModel.reply("Changed twice."),
        ])
        let fixture = try await ShipFixture.make(model: model, git: true)
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        try await fixture.send("Change it once", on: controller)
        try await fixture.send("Change it again", on: controller)
        XCTAssertEqual(try fixture.read("notes.txt"), "after two\n")
        let first = try XCTUnwrap(controller.rewindTurns.first)

        let forked = await fixture.workbench.fork(session.id, throughTurn: first.id, inNewWorktree: true)
        let fork = try XCTUnwrap(forked, fixture.workbench.lastError ?? "no fork")
        let root = try XCTUnwrap(fork.executionRootPath)
        XCTAssertTrue(root.contains("/.juno/worktrees/"), root)
        XCTAssertEqual(
            try String(contentsOfFile: root + "/notes.txt", encoding: .utf8),
            "after one\n",
            "the fork's worktree holds the files as they were after the forked turn"
        )
        XCTAssertEqual(try fixture.read("notes.txt"), "after two\n", "the original checkout is untouched")
        XCTAssertNotNil(fork.gitBranch)
    }

    func testAForkOfAWorktreeSessionStartsFromThatWorktreesCommit() async throws {
        let fixture = try await ShipFixture.make(model: ShipScriptedModel([]), git: true)
        defer { fixture.remove() }
        let (source, _) = try await fixture.session(isolated: true)
        let sourceRoot = URL(fileURLWithPath: try XCTUnwrap(source.executionRootPath), isDirectory: true)
        // A commit only the source's worktree has, then an edit on top of it.
        try ShipFixture.shell(
            "echo 'committed in the worktree' > made.txt && git add made.txt && git commit -qm 'worktree commit'",
            in: sourceRoot
        )
        try "edited after the commit\n".write(
            to: sourceRoot.appendingPathComponent("made.txt"),
            atomically: true,
            encoding: .utf8
        )

        let forked = await fixture.workbench.fork(source.id, throughTurn: nil, inNewWorktree: true)
        let fork = try XCTUnwrap(forked, fixture.workbench.lastError ?? "no fork")
        let root = URL(fileURLWithPath: try XCTUnwrap(fork.executionRootPath), isDirectory: true)
        let log = try ShipFixture.shell("git log --format=%s -1", in: root)
        XCTAssertEqual(
            log.trimmingCharacters(in: .whitespacesAndNewlines),
            "worktree commit",
            "the fork starts from the source worktree's commit, not the project's HEAD"
        )
        XCTAssertEqual(try fixture.read("made.txt", in: root), "edited after the commit\n")
        let status = try ShipFixture.shell("git status --porcelain", in: root)
        XCTAssertEqual(status.trimmingCharacters(in: .whitespacesAndNewlines), "M made.txt",
                       "the copied edit sits on the commit it was made against")
    }

    func testTheRelayForkNoLongerThrows() async throws {
        let (fixture, session, _) = try await threeTurns()
        defer { fixture.remove() }
        let bridge = WorkbenchRemoteBridge(
            model: fixture.workbench,
            sharedWorkspaceIDs: { [] },
            defaultModelID: { "test-model" }
        )
        let forkID = try await bridge.forkSession(sessionID: session.id.value)
        XCTAssertNotEqual(forkID, session.id.value)
        let events = await fixture.workbench.sessionStore.events(for: CodeSessionID(value: forkID))
        XCTAssertEqual(prompts(events), ["One", "Two", "Three"])
    }

    func testForkingARunningSessionAtItsLastTurnIsRefused() async throws {
        let store = CodeSessionStore(directoryURL: URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-fork-running-\(UUID().uuidString)"))
        let session = try await store.createSession(
            workspaceID: nil, workspaceName: nil, title: "Busy",
            configuration: AgentConfiguration(modelID: "m"), gitBranch: nil
        )
        try await store.setStatus(id: session.id, status: .running)
        do {
            _ = try await store.forkSession(session.id, throughTurn: nil)
            XCTFail("a session still being written cannot be forked whole")
        } catch let error as CodeSessionStore.ForkError {
            XCTAssertEqual(error, .sessionRunning)
        }
    }
}
