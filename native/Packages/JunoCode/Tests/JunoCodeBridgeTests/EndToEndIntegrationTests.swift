import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
@testable import JunoCodeBridge

/// A byte-stream transport that replays a queued Anthropic SSE response per
/// call, so a multi-turn agent run drives the real BackendCodeModelClient over
/// a real orchestrator, tool registry, and workspace.
private final class ScriptedByteStreamer: NativeAuthenticatedByteStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [String]
    private(set) var callCount = 0
    /// When true, every call drops mid-stream to simulate a persistent network
    /// failure with no terminal event.
    var alwaysDrop = false

    init(responses: [String]) {
        self.responses = responses
    }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let (sse, drop): (String, Bool) = lock.withLock {
            callCount += 1
            return (responses.isEmpty ? "" : responses.removeFirst(), alwaysDrop)
        }

        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            for byte in Data(sse.utf8) { continuation.yield(byte) }
            if drop {
                struct Dropped: Error {}
                continuation.finish(throwing: Dropped())
            } else {
                continuation.finish()
            }
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["Content-Type": "text/event-stream"]),
            bytes: bytes
        )
    }
}

private enum SSE {
    static func toolUse(id: String, name: String, inputJSON: String) -> String {
        """
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"\(id)","name":"\(name)","input":{}}}

        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":\(encode(inputJSON))}}

        data: {"type":"content_block_stop","index":0}

        data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}

        data: {"type":"message_stop"}

        """
    }

    static func text(_ text: String) -> String {
        """
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":\(encode(text))}}

        data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

        data: {"type":"message_stop"}

        """
    }

    /// JSON-encodes a string as a quoted literal for embedding in the payload.
    private static func encode(_ value: String) -> String {
        let data = try! JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    }
}

final class EndToEndIntegrationTests: XCTestCase {
    private var workspaceURL: URL!
    private var storeURL: URL!
    private var store: CodeSessionStore!
    private var registry: ToolRegistry!
    private var session: CodeSession!
    private let accountID = try! AccountID("account-e2e")

    override func setUp() async throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-e2e-\(UUID().uuidString)")
        workspaceURL = base.appendingPathComponent("workspace")
        storeURL = base.appendingPathComponent("store")
        try FileManager.default.createDirectory(
            at: workspaceURL.appendingPathComponent("src"),
            withIntermediateDirectories: true
        )
        try "let value = 1\n".write(
            to: workspaceURL.appendingPathComponent("src/main.swift"),
            atomically: true,
            encoding: .utf8
        )
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        let checkpoints = CheckpointStore(
            directoryURL: base.appendingPathComponent("checkpoints"),
            access: access
        )
        let executor = CommandExecutionService(workspaceRootURL: workspaceURL)
        registry = ToolRegistry.standard(
            files: FileOperationService(access: access, checkpoints: checkpoints),
            index: WorkspaceIndexService(access: access),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor)
        )
        store = CodeSessionStore(directoryURL: storeURL)
        session = try await store.createSession(
            workspaceID: access.workspaceID,
            workspaceName: "Demo",
            title: "E2E",
            configuration: AgentConfiguration(modelID: "claude-sonnet-5"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: workspaceURL.deletingLastPathComponent())
    }

    private func makeOrchestrator(
        streamer: ScriptedByteStreamer,
        mode: PermissionMode
    ) -> (AgentOrchestrator, PermissionCoordinator) {
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let permissions = PermissionCoordinator(sessionID: session.id, mode: mode)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: client,
            registry: registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "You are Juno Code."),
            modelID: "claude-sonnet-5",
            reasoningEffort: .medium
        )
        return (orchestrator, permissions)
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    /// workspace → instruction → real model client → tool calls → modification
    /// → diff → tests → completion, all through the real orchestrator.
    func testFullVerticalSliceThroughRealModelClient() async throws {
        let streamer = ScriptedByteStreamer(responses: [
            SSE.toolUse(id: "c1", name: "read_file", inputJSON: #"{"path":"src/main.swift"}"#),
            SSE.toolUse(
                id: "c2",
                name: "apply_patch",
                inputJSON: #"{"path":"src/main.swift","target":"let value = 1","replacement":"let value = 2"}"#
            ),
            SSE.toolUse(id: "c3", name: "run_command", inputJSON: #"{"command":"echo verified"}"#),
            SSE.text("Bumped the value and verified the build."),
        ])
        let (orchestrator, _) = makeOrchestrator(streamer: streamer, mode: .fullAccess)
        try await orchestrator.submit(prompt: "Change value to 2 and verify")
        await orchestrator.awaitCompletion()

        // Real file mutation on disk.
        let content = try String(
            contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
            encoding: .utf8
        )
        XCTAssertEqual(content, "let value = 2\n")

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)

        let events = await payloads()
        func count(_ predicate: (SessionEventPayload) -> Bool) -> Int {
            events.filter(predicate).count
        }
        XCTAssertEqual(count { if case .toolProposed = $0 { return true }; return false }, 3)
        XCTAssertEqual(count { if case .toolCompleted = $0 { return true }; return false }, 3)
        XCTAssertEqual(count { if case .fileChanged = $0 { return true }; return false }, 1)
        XCTAssertTrue(events.contains {
            if case let .toolOutput(output) = $0 { return output.text.contains("verified") }
            return false
        })
        XCTAssertEqual(streamer.callCount, 4, "four real model turns")

        // A real diff is reconstructable from the tracked change.
        guard case let .fileChanged(change)? = events.first(where: {
            if case .fileChanged = $0 { return true }
            return false
        }) else {
            return XCTFail("missing fileChanged")
        }
        XCTAssertEqual(change.linesAdded, 1)
        XCTAssertEqual(change.linesRemoved, 1)
    }

    /// The approval genuinely suspends the tool driven by the real model client;
    /// approving resumes and applies the change.
    func testApprovalSuspendsRealToolCall() async throws {
        let streamer = ScriptedByteStreamer(responses: [
            SSE.toolUse(
                id: "c1",
                name: "write_file",
                inputJSON: #"{"path":"src/new.swift","content":"// new\n"}"#
            ),
            SSE.text("Created the file."),
        ])
        let (orchestrator, permissions) = makeOrchestrator(
            streamer: streamer,
            mode: .askBeforeChanges
        )
        let requested = expectation(description: "approval requested")
        nonisolated(unsafe) var approvalID: String?
        await permissions.addObserver { update in
            if case let .requested(request) = update {
                approvalID = request.id
                requested.fulfill()
            }
        }
        try await orchestrator.submit(prompt: "Create a file")
        await fulfillment(of: [requested], timeout: 5)

        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/new.swift").path
            ),
            "the tool must not run while approval is pending"
        )
        await permissions.resolve(approvalID: approvalID!, decision: .approved)
        await orchestrator.awaitCompletion()

        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: workspaceURL.appendingPathComponent("src/new.swift").path
            )
        )
        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
    }

    /// A persistent network drop (initial call and its retry) fails the session
    /// cleanly: no mutation, no false success.
    func testPersistentNetworkDropFailsSession() async throws {
        let streamer = ScriptedByteStreamer(responses: [])
        streamer.alwaysDrop = true
        let (orchestrator, _) = makeOrchestrator(streamer: streamer, mode: .fullAccess)
        try await orchestrator.submit(prompt: "Break the build")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .failed, "a dropped turn is never a completed run")

        let content = try String(
            contentsOf: workspaceURL.appendingPathComponent("src/main.swift"),
            encoding: .utf8
        )
        XCTAssertEqual(content, "let value = 1\n", "no mutation on a failed turn")
        XCTAssertGreaterThanOrEqual(streamer.callCount, 2, "initial call plus one retry")
    }

    /// A transient drop on the first call recovers on the retry and completes.
    func testTransientDropRecoversOnRetry() async throws {
        // The first model call drops; the retry returns a clean text turn.
        let streamer = OneDropThenScriptedStreamer(
            recovery: SSE.text("Recovered and finished.")
        )
        let client = BackendCodeModelClient(streamer: streamer, accountID: accountID)
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: client,
            registry: registry,
            permissions: permissions,
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "claude-sonnet-5",
            reasoningEffort: .medium
        )
        try await orchestrator.submit(prompt: "hi")
        await orchestrator.awaitCompletion()

        let final = try await store.session(id: session.id)
        XCTAssertEqual(final.status, .completed)
        let events = await payloads()
        let errors = events.filter {
            if case .errorOccurred = $0 { return true }
            return false
        }
        XCTAssertEqual(errors.count, 1, "the dropped turn is recorded as a recoverable error")
    }
}

/// Drops the first stream, then serves a fixed recovery response.
private final class OneDropThenScriptedStreamer: NativeAuthenticatedByteStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var served = 0
    private let recovery: String

    init(recovery: String) {
        self.recovery = recovery
    }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse {
        let index = lock.withLock {
            let current = served
            served += 1
            return current
        }
        let recovery = self.recovery
        let bytes = AsyncThrowingStream<UInt8, any Error> { continuation in
            if index == 0 {
                struct Dropped: Error {}
                continuation.finish(throwing: Dropped())
            } else {
                for byte in Data(recovery.utf8) { continuation.yield(byte) }
                continuation.finish()
            }
        }
        return HTTPByteStreamResponse(
            statusCode: 200,
            headers: try! HTTPHeaders(["Content-Type": "text/event-stream"]),
            bytes: bytes
        )
    }
}
