import Foundation
import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
@testable import JunoCodeUI

/// The visual verify loop end to end (CODE_AGENT_SPEC §4.6, §6.4): a scripted
/// model edits a page, tries to finish, is sent back with `ui_unchecked`
/// naming the route, starts the preview, looks at it, and the runtime mints
/// the evidence. Real offscreen WebKit, Juno's in-process static server, a
/// temporary workspace and store; no network, no screen.
@MainActor
final class PreviewVerifyLoopTests: XCTestCase {
    private var base: URL!
    private var root: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        PreviewPage.backgroundHostMode = .offscreen
        base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-verify-loop-\(UUID().uuidString)")
        root = base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("site"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".juno"), withIntermediateDirectories: true)
        try #"{ "version": "0.0.1", "configurations": [ { "name": "site", "runtimeExecutable": "juno:static", "cwd": "site" } ] }"#
            .write(to: root.appendingPathComponent(".juno/launch.json"), atomically: true, encoding: .utf8)
        try "<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>"
            .write(to: root.appendingPathComponent("site/index.html"), atomically: true, encoding: .utf8)
        store = CodeSessionStore(directoryURL: base.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Site",
            title: "Settings",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() async throws {
        let key = PreviewKey(checkoutRoot: root, name: "site")
        await PreviewRegistry.shared.remove(key)
        PreviewPageRegistry.shared.remove(key)
        try? FileManager.default.removeItem(at: base)
    }

    // MARK: - Fakes

    /// Writes a page and reports the change the way the edit tools do.
    private struct EditPageTool: CodeTool {
        let root: URL
        let name = "edit_page"
        let description = "Writes a page."
        let inputSchema: JSONValue = ["type": "object", "properties": ["path": ["type": "string"], "html": ["type": "string"]]]

        func assessRisk(input _: JSONValue) -> ActionRisk { .write }
        func summary(input _: JSONValue) -> String { "Edit a page" }

        func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
            let path = input["path"]?.stringValue ?? ""
            try (input["html"]?.stringValue ?? "").write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
            return ToolResult(
                content: "Wrote \(path).",
                sideEffects: [.fileChanged(FileChangedEvent(path: try WorkspacePath(path), kind: .modified, linesAdded: 3, linesRemoved: 0, checkpointID: nil))]
            )
        }
    }

    /// A model that plays a script, one step per request.
    private final class ScriptedModel: AgentModelClient, @unchecked Sendable {
        enum Step {
            case text(String)
            case call(String, JSONValue)
        }

        private let lock = NSLock()
        private var steps: [Step]
        private(set) var requests: [ModelTurnRequest] = []

        init(_ steps: [Step]) { self.steps = steps }

        var receivedRequests: [ModelTurnRequest] { lock.withLock { requests } }

        func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
            let step: Step = lock.withLock {
                requests.append(request)
                return steps.isEmpty ? .text("Done.") : steps.removeFirst()
            }
            return AsyncThrowingStream { continuation in
                switch step {
                case let .text(text):
                    continuation.yield(.textDelta(text))
                    continuation.yield(.turnCompleted(.endTurn))
                case let .call(name, input):
                    continuation.yield(.toolCallRequested(id: "call-\(UUID().uuidString.prefix(8))", name: name, input: input))
                    continuation.yield(.turnCompleted(.toolUse))
                }
                continuation.finish()
            }
        }
    }

    private func runtime(_ model: ScriptedModel) async -> AgentOrchestrator {
        await PreviewSessionHub.shared.observe(store: store, sessionID: session.id, workspaceRoot: root)
        let services = PreviewToolServices(
            workspaceRoot: root,
            evidenceDirectory: base.appendingPathComponent("evidence")
        )
        let gate = PreviewUIGate(
            base: ReportOnlyCompletionGate(),
            advisor: PreviewSessionHub.shared.entry(for: session.id, workspaceRoot: root).verify
        )
        return AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [
                EditPageTool(root: root),
                PreviewServerTool(services: services),
                PreviewBrowserTool(services: services),
            ]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(compactionSummary: nil, systemPrompt: "You are Alevr Code."),
            modelID: "test-model",
            reasoningEffort: nil,
            completionGate: gate
        )
    }

    private func payloads() async -> [SessionEventPayload] {
        await store.events(for: session.id).map(\.payload)
    }

    private func continuations() async -> [RunContinuedEvent] {
        await payloads().compactMap { if case let .runContinued(event) = $0 { return event } else { return nil } }
    }

    private func uiRecords() async -> [UIVerificationRecord] {
        await payloads().compactMap { if case let .uiVerificationRecorded(record) = $0 { return record } else { return nil } }
    }

    private static let goodPage = "<!doctype html><html><head><title>Settings</title></head><body><button>Open menu</button></body></html>"
    private static let brokenPage = """
        <!doctype html><html><head><title>Settings</title></head><body><button>Open menu</button>
        <script>console.error("TypeError: menu is undefined")</script></body></html>
        """

    // MARK: - Tests

    func testAUIEditIsCheckedInThePreviewBeforeTheRunEnds() async throws {
        let model = ScriptedModel([
            .call("edit_page", ["path": "site/settings.html", "html": .string(Self.goodPage)]),
            .text("Done: the settings page has its menu."),
            .call("preview_server", ["action": "start"]),
            .call("preview_browser", ["action": "navigate", "path": "/settings.html"]),
            .call("preview_browser", ["action": "screenshot"]),
            .text("Checked /settings.html in the Preview."),
        ])
        let runtime = await runtime(model)
        try await runtime.submit(prompt: "Add a menu to the settings page")
        await runtime.awaitCompletion()

        let continued = await continuations()
        XCTAssertEqual(continued.map(\.reason), [.gate(.uiUnchecked)])
        XCTAssertTrue(continued.first?.detail.contains("/settings.html") == true, continued.first?.detail ?? "")

        let requests = model.receivedRequests
        XCTAssertEqual(requests.count, 6)
        guard case let .user(note)? = requests[2].messages.last else { return XCTFail("the third request ends in the runtime note") }
        XCTAssertTrue(note.hasPrefix("<juno_runtime reason=\"ui_unchecked\""), note)
        XCTAssertTrue(note.contains("/settings.html"), note)

        let records = await uiRecords()
        let record = try XCTUnwrap(records.last)
        XCTAssertTrue(record.passed, "\(record.checks)")
        XCTAssertEqual(record.target, "/settings.html")
        XCTAssertEqual(record.surface, .web)
        XCTAssertNotNil(record.screenshotHash)
        XCTAssertEqual(record.workspaceRevision, 1)
        let status = try await store.session(id: session.id).status
        XCTAssertEqual(status, .completed)
    }

    /// A new console error mints a failing record; the same failure twice
    /// ends the loop instead of a third round.
    func testAConsoleErrorFailsTheCheckAndTheSameFailureTwiceStops() async throws {
        let model = ScriptedModel([
            .call("edit_page", ["path": "site/settings.html", "html": .string(Self.brokenPage)]),
            .text("Done."),
            .call("preview_server", ["action": "start"]),
            .call("preview_browser", ["action": "navigate", "path": "/settings.html"]),
            .call("preview_browser", ["action": "screenshot"]),
            .text("Looked."),
            .call("edit_page", ["path": "site/settings.html", "html": .string(Self.brokenPage)]),
            .call("preview_browser", ["action": "navigate", "history": "reload"]),
            .call("preview_browser", ["action": "screenshot"]),
            .text("Still broken, stopping."),
        ])
        let runtime = await runtime(model)
        try await runtime.submit(prompt: "Fix the menu")
        await runtime.awaitCompletion()

        let records = await uiRecords()
        XCTAssertEqual(records.count, 2)
        XCTAssertTrue(records.allSatisfy { !$0.passed })
        XCTAssertTrue(records[0].checks.contains { $0.detail == "TypeError: menu is undefined" }, "\(records[0].checks)")
        let continued = await continuations()
        XCTAssertEqual(continued.map(\.reason), [.gate(.uiUnchecked), .gate(.uiUnchecked)])
        XCTAssertTrue(continued[1].detail.contains("TypeError: menu is undefined"), continued[1].detail)
        XCTAssertEqual(model.receivedRequests.count, 10, "no third round after the repeated failure")
    }

    /// The loop is bounded: three rounds, then the run ends.
    func testAtMostThreeVerifyRounds() async throws {
        let model = ScriptedModel([
            .call("edit_page", ["path": "site/settings.html", "html": .string(Self.goodPage)]),
            .text("Done."),
            .call("edit_page", ["path": "site/notes.txt", "html": "x"]),
            .text("Done."),
            .call("edit_page", ["path": "site/notes.txt", "html": "y"]),
            .text("Done."),
            .call("edit_page", ["path": "site/notes.txt", "html": "z"]),
            .text("Done."),
        ])
        let runtime = await runtime(model)
        try await runtime.submit(prompt: "Change the page")
        await runtime.awaitCompletion()
        let continued = await continuations()
        XCTAssertEqual(continued.count, 3)
        XCTAssertEqual(model.receivedRequests.count, 8)
    }

    /// §4.6 checks UI edits under "a running or configured web
    /// configuration": what discovery merely proposes (a Node backend's `dev`
    /// script) triggers nothing until a launch file names it or it runs.
    func testOnlyConfiguredOrRunningPreviewsTriggerUIChecks() {
        let raw = [PreviewLaunchConfiguration(name: "dev", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], cwd: "server")]
        let discovered = LaunchConfigurationStore.resolve(raw, source: .discovered, workspaceRoot: root).configurations
        let configured = LaunchConfigurationStore.resolve(raw, source: .juno, workspaceRoot: root).configurations
        XCTAssertEqual(PreviewSessionHub.webRoots(PreviewLaunchCatalog(configurations: discovered)), [])
        XCTAssertEqual(PreviewSessionHub.webRoots(PreviewLaunchCatalog(configurations: discovered), running: discovered), ["server"])
        XCTAssertEqual(PreviewSessionHub.webRoots(PreviewLaunchCatalog(configurations: configured)), ["server"])
    }

    /// The gate never runs anything itself and never widens a permission: in
    /// a session that may not start servers, the agent's start is still asked
    /// about, by its bytes.
    func testStartingAnUnapprovedConfigurationStillAsks() async throws {
        let services = PreviewToolServices(workspaceRoot: root)
        let tool = PreviewServerTool(services: services)
        XCTAssertEqual(tool.assessRisk(input: ["action": "start"]), .critical)
        let summary = tool.summary(input: ["action": "start"])
        XCTAssertTrue(summary.contains("juno:static") || summary.contains("Alevr's static server"), summary)
        XCTAssertTrue(summary.contains("site"), summary)
        XCTAssertTrue(summary.contains("loopback only"), summary)
        XCTAssertTrue(summary.contains(".juno/launch.json"), summary)
        XCTAssertEqual(PreviewBrowserTool(services: services).assessRisk(input: ["action": "eval", "js": "1"]), .destructive)
        XCTAssertNotNil(PreviewBrowserTool(services: services).precheck(input: ["action": "eval", "js": "1"]), "eval is off unless enabled")
    }
}
