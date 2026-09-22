import XCTest
import JunoCodeBridge
import JunoCodeCore
import JunoCodeKit
import JunoCodeLocal
import JunoCodeRuntime
import JunoCore
@testable import JunoCodeUI

/// The Mac side of Remote against a real workbench: what a phone is shown,
/// under which id a phone's session opens, and that a message from the phone
/// leaves the reader's own draft alone.
@MainActor
final class WorkbenchRemoteBridgeTests: XCTestCase {
    private var workspaceURL: URL!
    private var storageURL: URL!
    private var model: WorkbenchModel!

    override func setUp() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-remote-bridge-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        workspaceURL = root.appendingPathComponent("workspace")
        storageURL = root.appendingPathComponent("storage")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        model = makeModel()
        await model.bootstrap()
    }

    private func makeModel() -> WorkbenchModel {
        WorkbenchModel(
            dependencies: WorkbenchModel.Dependencies(
                storageRootURL: storageURL,
                modelClient: RemoteBridgeModelClient(),
                availableModels: [ModelOption(modelID: "test-model", displayName: "Test Model")]
            )
        )
    }

    // MARK: - Opening a phone's session

    func testAPhonesSessionOpensUnderItsIDWithoutTakingTheWindow() async throws {
        let record = try await sharedWorkspace()
        let bridge = makeBridge(shared: [record.id.value])
        let before = model.selectedSessionID

        let created = try await bridge.createSession(
            CodeRemoteSessionRequest(
                requestedID: "remote-6f1c", workspaceID: record.id.value, title: "Fix login",
                permissionMode: .askBeforeChanges, modelID: nil, reasoningEffort: nil
            )
        )

        XCTAssertEqual(created, CodeRemoteCreatedSession(id: "remote-6f1c", isNew: true))
        let session = try XCTUnwrap(model.sessions.first { $0.id.value == "remote-6f1c" })
        XCTAssertEqual(session.title, "Fix login")
        XCTAssertEqual(model.selectedSessionID, before, "the reader at the Mac keeps their place")

        let again = try await bridge.createSession(
            CodeRemoteSessionRequest(
                requestedID: "remote-6f1c", workspaceID: record.id.value, title: nil,
                permissionMode: .askBeforeChanges, modelID: nil, reasoningEffort: nil
            )
        )
        XCTAssertEqual(again, CodeRemoteCreatedSession(id: "remote-6f1c", isNew: false))
        XCTAssertEqual(model.sessions.filter { $0.id.value == "remote-6f1c" }.count, 1)
    }

    // MARK: - The reader's draft

    func testAMessageFromThePhoneLeavesTheLocalDraftAlone() async throws {
        let record = try await sharedWorkspace()
        let session = try await newSession(in: record.id)
        let resolved = await model.controller(for: session.id)
        let controller = try XCTUnwrap(resolved)
        controller.composerText = "half-written thought"
        let bridge = makeBridge(shared: [record.id.value])

        try await bridge.sendMessage(sessionID: session.id.value, text: "Run the tests")

        XCTAssertEqual(controller.composerText, "half-written thought")
        let events = await model.sessionStore.events(for: session.id)
        let prompts = events.compactMap { event -> String? in
            if case .userPrompt(let prompt) = event.payload { return prompt.text }
            return nil
        }
        XCTAssertEqual(prompts, ["Run the tests"])
    }

    // MARK: - What the phone is shown

    func testOnlySessionsInSharedWorkspacesAreListed() async throws {
        let shared = try await sharedWorkspace()
        let otherURL = workspaceURL.deletingLastPathComponent().appendingPathComponent("private")
        try FileManager.default.createDirectory(at: otherURL, withIntermediateDirectories: true)
        let added = await model.addWorkspace(grantedURL: otherURL)
        let other = try XCTUnwrap(added)
        let listedSession = try await newSession(in: shared.id)
        _ = await model.createSession(workspaceID: other.id, configuration: AgentConfiguration(modelID: "test-model"))
        _ = await model.createSession(workspaceID: nil, configuration: AgentConfiguration(modelID: "test-model"))
        let bridge = makeBridge(shared: [shared.id.value])

        let answer = await bridge.remoteVisibleSessions()
        let visible = try XCTUnwrap(answer)

        XCTAssertEqual(visible.map(\.summary.sessionID), [listedSession.id.value])
        XCTAssertEqual(visible.first?.summary.workspaceKey, shared.id.value)
        XCTAssertEqual(visible.first?.summary.permissionMode, "approvalRequired")
        let count = await model.sessionStore.eventCount(for: listedSession.id)
        XCTAssertEqual(visible.first?.eventCount, count)
    }

    func testTheTranscriptIsServedFromTheCursorAndNothingOutsideTheListIs() async throws {
        let shared = try await sharedWorkspace()
        let session = try await newSession(in: shared.id)
        _ = try await model.sessionStore.appendEvent(
            sessionID: session.id, payload: .userPrompt(UserPromptEvent(text: "hello"))
        )
        let bridge = makeBridge(shared: [shared.id.value])

        let all = await bridge.relayEvents(sessionID: session.id.value, after: 0, limit: 100)
        XCTAssertEqual(all.map(\.seq), [1, 2])
        XCTAssertEqual(all.map(\.kind), ["session_created", "user_message"])

        let rest = await bridge.relayEvents(sessionID: session.id.value, after: 1, limit: 100)
        XCTAssertEqual(rest.map(\.seq), [2])

        let unshared = makeBridge(shared: [])
        let hidden = await unshared.relayEvents(sessionID: session.id.value, after: 0, limit: 100)
        XCTAssertTrue(hidden.isEmpty, "a session outside the shared workspaces has no transcript here")
    }

    func testTheListIsBoundedAndWorkingSessionsComeFirst() {
        let now = Date(timeIntervalSince1970: 10_000_000)
        let workspace = WorkspaceID(value: "ws-1")
        func session(_ id: String, age: TimeInterval, status: SessionStatus = .completed) -> CodeSession {
            var session = CodeSession(
                id: CodeSessionID(value: id), workspaceID: workspace, title: id,
                configuration: AgentConfiguration(modelID: "m"),
                createdAt: now.addingTimeInterval(-age), updatedAt: now.addingTimeInterval(-age)
            )
            session.status = status
            return session
        }
        let sessions = [
            session("recent", age: 60),
            session("stale", age: WorkbenchRemoteBridge.remoteVisibleWindow + 60),
            session("stale-but-working", age: WorkbenchRemoteBridge.remoteVisibleWindow + 60, status: .running),
            CodeSession(
                id: CodeSessionID(value: "sub-agent"), workspaceID: workspace,
                parentSessionID: CodeSessionID(value: "recent"), title: "child",
                configuration: AgentConfiguration(modelID: "m"), createdAt: now, updatedAt: now
            ),
        ]

        let visible = WorkbenchRemoteBridge.remoteVisible(sessions, shared: ["ws-1"], now: now)
        XCTAssertEqual(visible.map(\.id.value), ["stale-but-working", "recent"])

        let many = (0..<40).map { session("s\($0)", age: TimeInterval($0)) }
        XCTAssertEqual(
            WorkbenchRemoteBridge.remoteVisible(many, shared: ["ws-1"], now: now).count,
            WorkbenchRemoteBridge.remoteVisibleLimit
        )
    }

    // MARK: - After a relaunch

    /// Remote starts at launch; the Code view reads the sessions only when it
    /// appears. A Mac that relaunched onto Chat used to answer the uploader
    /// with no sessions at all, which took every one the phone was showing off
    /// it and forgot where each transcript's upload had got to.
    func testTheUploaderReadsAWorkbenchNobodyHasOpenedAndTakesNothingOffThePhone() async throws {
        let shared = try await sharedWorkspace()
        let session = try await newSession(in: shared.id)
        let uploaded = await model.sessionStore.eventCount(for: session.id)
        XCTAssertGreaterThan(uploaded, 0)

        // The next launch: same storage, a workbench no view has bootstrapped,
        // and the bridge composed as the app composes it.
        let relaunched = makeModel()
        XCTAssertFalse(relaunched.hasLoaded)
        let bridge = WorkbenchRemoteBridge(
            model: relaunched,
            sharedWorkspaceIDs: { Set(relaunched.workspaces.map(\.id.value)) },
            defaultModelID: { "test-model" },
            ceiling: { _ in .askBeforeChanges }
        )
        let relay = BridgeRelay()
        let store = InMemoryCodeRemoteSyncStateStore(
            CodeRemoteSyncState(
                deviceID: "device-1", cursors: [session.id.value: uploaded],
                listedSessionIDs: [session.id.value], listVersion: 3
            )
        )
        let sync = makeSync(bridge: bridge, relay: relay, store: store)

        await sync.start()
        // A whole pass: the list, then whatever events it would send.
        try await settle {
            if case .synced = await sync.phase { return true }
            return false
        }
        await sync.stop()

        let put = await relay.puts.first
        XCTAssertEqual(put?.sessionIDs, [session.id.value], "the session is still listed")
        XCTAssertEqual(put?.deleted, [], "and nothing is tombstoned")
        let posts = await relay.posts
        XCTAssertTrue(posts.isEmpty, "a transcript already uploaded is not sent again")
        let saved = await store.state
        XCTAssertEqual(saved?.cursors[session.id.value], uploaded, "its cursor survives")
        XCTAssertTrue(relaunched.hasLoaded)
    }

    // MARK: - The ceiling

    func testAllowingARequestInASessionAboveTheCeilingIsRefused() async throws {
        let shared = try await sharedWorkspace()
        let session = try await newSession(in: shared.id, mode: .fullAccess)
        let bridge = makeBridge(shared: [shared.id.value], ceiling: .askBeforeChanges)
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(
                CodeRemoteCommand(
                    id: "c-2", sessionID: session.id.value, kind: "approval_decision",
                    payload: ["requestId": .string("a-1"), "approved": .bool(true)], status: "claimed"
                )
            )
            XCTFail("a phone must not allow what a full-access session asks at the desk")
        } catch let error as CodeRemoteCommandError {
            guard case .aboveRemoteCeiling = error else {
                return XCTFail("expected the ceiling refusal, got \(error)")
            }
        }
    }

    func testASessionAboveTheReadersCeilingRefusesThePhone() async throws {
        let shared = try await sharedWorkspace()
        let session = try await newSession(in: shared.id, mode: .fullAccess)
        let bridge = makeBridge(shared: [shared.id.value], ceiling: .askBeforeChanges)
        let adapter = RemoteCommandAdapter(bridge: bridge)

        do {
            _ = try await adapter.execute(
                CodeRemoteCommand(
                    id: "c-1", sessionID: session.id.value, kind: "send_message",
                    payload: ["text": .string("deploy")], status: "claimed"
                )
            )
            XCTFail("a full-access session must not take a prompt from the phone")
        } catch let error as CodeRemoteCommandError {
            guard case .aboveRemoteCeiling = error else {
                return XCTFail("expected the ceiling refusal, got \(error)")
            }
        }
        let events = await model.sessionStore.events(for: session.id)
        XCTAssertFalse(events.contains {
            if case .userPrompt = $0.payload { return true }
            return false
        })
    }

    func testRejectingAChangeTheSessionNeverMadeFailsInsteadOfPassing() async throws {
        let shared = try await sharedWorkspace()
        let session = try await newSession(in: shared.id)
        let bridge = makeBridge(shared: [shared.id.value])

        do {
            try await bridge.applyChange(sessionID: session.id.value, changeID: "src/none.swift", accept: true)
            XCTFail("accepting a change that does not exist must not report success")
        } catch let error as CodeRemoteCommandError {
            guard case .invalidField("changeId", _) = error else {
                return XCTFail("expected an invalid changeId, got \(error)")
            }
        }
    }

    // MARK: - Helpers

    private func sharedWorkspace() async throws -> WorkspaceRecord {
        let record = await model.addWorkspace(grantedURL: workspaceURL)
        return try XCTUnwrap(record)
    }

    private func newSession(
        in workspace: WorkspaceID, mode: PermissionMode = .askBeforeChanges
    ) async throws -> CodeSession {
        let session = await model.createSession(
            workspaceID: workspace,
            configuration: AgentConfiguration(modelID: "test-model", permissionMode: mode)
        )
        return try XCTUnwrap(session)
    }

    private func makeBridge(
        shared: Set<String>, ceiling: PermissionMode = .askBeforeChanges
    ) -> WorkbenchRemoteBridge {
        WorkbenchRemoteBridge(
            model: model,
            sharedWorkspaceIDs: { shared },
            defaultModelID: { "test-model" },
            ceiling: { _ in ceiling }
        )
    }

    /// Changes reach it only through an observation: the reconcile is an hour.
    private func makeSync(
        bridge: WorkbenchRemoteBridge, relay: BridgeRelay, store: InMemoryCodeRemoteSyncStateStore
    ) -> CodeRemoteSessionSync {
        CodeRemoteSessionSync(
            deviceID: "device-1",
            accountID: try! AccountID("account-a"),
            source: bridge,
            transport: relay,
            stateStore: store,
            debounce: .milliseconds(1),
            reconcileInterval: .seconds(3_600)
        )
    }

    private func settle(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<600 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition never became true")
    }
}

/// Stores what it is sent.
private actor BridgeRelay: CodeRemoteSyncTransport {
    struct Put: Equatable {
        let sessionIDs: [String]
        let deleted: [String]
    }

    private(set) var puts: [Put] = []
    private(set) var posts: [(sessionID: String, seqs: [Int])] = []
    private var stored: [String: Int] = [:]

    func putSessions(
        deviceID: String, listVersion: Int, sessions: [CodeRemoteSessionUpload],
        deletedSessionIDs: [String], for accountID: AccountID
    ) async throws {
        puts.append(Put(sessionIDs: sessions.map(\.sessionID), deleted: deletedSessionIDs))
    }

    func postEvents(
        deviceID: String, sessionID: String, events: [CodeRemoteSessionEvent],
        for accountID: AccountID
    ) async throws -> Int {
        posts.append((sessionID, events.map(\.seq)))
        stored[sessionID] = max(stored[sessionID] ?? 0, events.map(\.seq).max() ?? 0)
        return stored[sessionID] ?? 0
    }
}

/// Answers every turn at once, so a delivered prompt runs to completion.
private final class RemoteBridgeModelClient: AgentModelClient, @unchecked Sendable {
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("Done."))
            continuation.yield(.turnCompleted(.endTurn))
            continuation.finish()
        }
    }
}
