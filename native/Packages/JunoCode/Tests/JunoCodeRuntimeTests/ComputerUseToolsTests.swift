import XCTest
import JunoCodeCore
import JunoCodeLocal
import JunoScreenControl
@testable import JunoCodeRuntime

/// A screen that does what it is told and records it. No capture, no input.
final class FakeScreen: ScreenControlling, @unchecked Sendable {
    private let lock = NSLock()
    var failOn: [ScreenActionKind: ScreenControlError] = [:]
    var floor: FloorReason?
    var frameHash = "frame-1"
    var granted: Set<String> = ["com.apple.TextEdit"]
    private(set) var performed: [ScreenActionKind] = []
    private(set) var attachedFrame: [Bool] = []
    private(set) var published: [String: ScreenApprovalDetail] = [:]
    private(set) var settledCalls = 0

    static let frame = EncodedFrame(data: Data([0x89, 0x50, 0x4E, 0x47]), mediaType: "image/png", size: PixelSize(width: 1372, height: 887))

    func state(sessionID: String) async -> ScreenSessionState { .running(mode: .background, app: "TextEdit") }
    func setImageBudget(sessionID: String, budget: ImageBudget) async {}
    func listApps(sessionID: String) async -> [ScreenAppListing] {
        [ScreenAppListing(bundleID: "com.apple.TextEdit", name: "TextEdit", running: true, category: .other, grantedTier: .full, cap: .full)]
    }
    func proposeGrants(sessionID: String, apps: [String], reason: String?, clipboardRead: Bool, clipboardWrite: Bool) async throws -> GrantProposal {
        GrantProposal(sessionID: sessionID, reason: reason, offers: apps.map {
            AppGrantPolicy.offer(request: $0, bundleID: $0, displayName: $0, preferences: .default)
        })
    }
    func applyGrants(sessionID: String, proposalID: String) async throws -> [AppGrant] {
        [AppGrant(bundleID: "com.apple.TextEdit", displayName: "TextEdit", tier: .full, scope: .session(sessionID), grantedAt: Date())]
    }
    func grants(sessionID: String) async -> [AppGrant] { [] }
    func release(sessionID: String, apps: [String]) async -> [String] { apps }
    func open(sessionID: String, app: String) async throws -> ScreenActionResult {
        ScreenActionResult(summary: "Opened \(app).", frameHeader: "frame 1372×887", frame: Self.frame)
    }
    func prepare(sessionID: String, action: ScreenAction) async throws -> PreparedScreenAction {
        if let error = lock.withLock({ failOn[action.kind] }) { throw error }
        return PreparedScreenAction(
            sessionID: sessionID,
            action: action,
            target: ScreenTargetSummary(bundleID: "com.apple.TextEdit", appName: "TextEdit", element: "“Send” button"),
            floor: lock.withLock { floor },
            frameHash: lock.withLock { frameHash },
            summary: "Click the “Send” button in TextEdit",
            isInput: !action.kind.isObservation
        )
    }
    func perform(sessionID: String, prepared: PreparedScreenAction, toolCallID: String?, attachFrame: Bool) async throws -> ScreenActionResult {
        lock.withLock {
            performed.append(prepared.action.kind)
            attachedFrame.append(attachFrame)
        }
        return ScreenActionResult(
            summary: "\(prepared.action.kind.pastTense) TextEdit.",
            frameHeader: attachFrame ? "frame 1372×887 · scale 0.397 · display 1\n\(ScreenControlService.untrustedLine)" : nil,
            frame: attachFrame ? Self.frame : nil
        )
    }
    func settledFrame(sessionID: String) async throws -> ScreenActionResult {
        lock.withLock { settledCalls += 1 }
        return ScreenActionResult(summary: "Screen after the batch.", frameHeader: "frame 1372×887", frame: Self.frame)
    }
    func accessibility(sessionID: String, app: String?, query: String?, filter: AXSnapshot.Filter, depth: Int) async throws -> String {
        "Accessibility tree of TextEdit."
    }
    func prepareMenu(sessionID: String, app: String?, path: [String]) async throws -> PreparedScreenAction {
        PreparedScreenAction(
            sessionID: sessionID, action: ScreenAction(kind: .key, text: path.joined(separator: " › ")),
            target: ScreenTargetSummary(bundleID: "com.apple.TextEdit", appName: "TextEdit"),
            floor: ConsequentialActionFloor.matchingWord(in: [path.last ?? ""]).map(FloorReason.consequentialControl),
            frameHash: frameHash, summary: "Choose \(path.joined(separator: " › ")) in TextEdit", isInput: true
        )
    }
    func performMenu(sessionID: String, prepared: PreparedScreenAction, path: [String], toolCallID: String?) async throws -> ScreenActionResult {
        ScreenActionResult(summary: "Chose \(path.joined(separator: " › ")) in TextEdit.")
    }
    func displays(sessionID: String) async -> [DisplayInfo] { [] }
    func requestTakeover(sessionID: String, displayID: UInt32?) async throws -> ScreenApprovalDetail {
        .takeover(sessionID: sessionID, display: "Built-in Retina Display")
    }
    func beginTakeover(sessionID: String, displayID: UInt32?) async throws -> String { "Taken over." }
    func endTakeover(sessionID: String) async -> String { "Released." }
    func publishApprovalDetail(_ detail: ScreenApprovalDetail, digest: String) async {
        lock.withLock { published[digest] = detail }
    }
    func clearApprovalDetail(digest: String) async {}
    func approvalDetail(digest: String) async -> ScreenApprovalDetail? { lock.withLock { published[digest] } }
    func updateGrantChoices(proposalID: String, offers: [AppGrantOffer]) async {}
    func isGranted(sessionID: String, bundleID: String) async -> Bool { lock.withLock { granted.contains(bundleID) } }
}

/// The computer tools against a fake screen and the real permission ladder.
final class ComputerUseToolsTests: XCTestCase {
    private let sessionID = CodeSessionID()

    private func context(_ call: String = "call") -> ToolContext {
        ToolContext(sessionID: sessionID, toolCallID: call, emitOutput: { _, _ in })
    }

    /// Approves every question, recording it.
    private func autoApprove(_ permissions: PermissionCoordinator) async -> LockedRequests {
        let asked = LockedRequests()
        await permissions.addObserver { update in
            guard case let .requested(request) = update else { return }
            asked.append(request)
            Task { await permissions.resolve(approvalID: request.id, decision: .approved) }
        }
        return asked
    }

    // MARK: Batches and frames

    func testABatchStopsAtTheFirstFailureWithTheExactText() async throws {
        let screen = FakeScreen()
        screen.failOn[.type] = .tierTooLow("Terminal is granted for clicks only; typing, keys, right-click and drags were not sent.")
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let tool = ComputerBatchTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        let result = try await tool.execute(input: [
            "actions": [
                ["action": "left_click", "coordinate": [10, 10]],
                ["action": "type", "text": "rm -rf ~"],
                ["action": "key", "text": "return"],
                ["action": "screenshot"],
            ],
        ], context: context())
        XCTAssertTrue(result.isError)
        let lines = result.content.components(separatedBy: "\n")
        XCTAssertEqual(lines[0], "1. Clicked TextEdit.")
        XCTAssertEqual(lines[1], "2. Terminal is granted for clicks only; typing, keys, right-click and drags were not sent.")
        XCTAssertEqual(lines[2], "3. Not executed: an earlier computer action in this turn failed.")
        XCTAssertEqual(lines[3], "4. Not executed: an earlier computer action in this turn failed.")
        XCTAssertEqual(screen.performed, [.leftClick], "nothing after the failure ran")
        XCTAssertEqual(screen.settledCalls, 1, "a failed batch still hands back the screen")
        XCTAssertEqual(result.images.count, 1)
    }

    func testTheSettledFrameIsAttachedToTheLastResultOnly() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let tool = ComputerBatchTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        let result = try await tool.execute(input: [
            "actions": [["action": "left_click", "coordinate": [1, 1]], ["action": "key", "text": "cmd+s"]],
        ], context: context())
        XCTAssertFalse(result.isError)
        XCTAssertEqual(screen.attachedFrame, [false, true])
        XCTAssertEqual(result.images.count, 1)
        XCTAssertEqual(result.images.first?.detail, .original, "already scaled to the route's budget")
        XCTAssertTrue(result.content.contains(ScreenControlService.untrustedLine))
    }

    func testEveryActionReturnsItsFrameWithTheHeader() async throws {
        let screen = FakeScreen()
        let tool = ComputerTool(computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess), budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5]], context: context())
        XCTAssertEqual(result.content.components(separatedBy: "\n").first, "Clicked TextEdit.")
        XCTAssertTrue(result.content.contains("frame 1372×887"))
        XCTAssertEqual(result.images.count, 1, "no extra screenshot round trip (CU-06)")
    }

    // MARK: Errors and the stop

    func testErrorsAreSentencesNotEnumNames() async throws {
        let screen = FakeScreen()
        screen.failOn[.leftClick] = .appNotGranted(app: "Notes")
        let tool = ComputerTool(computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess), budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5], "app": "Notes"], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "Notes is not granted for this session. Ask the reader to grant it with computer_apps request.")
        XCTAssertNil(result.endsRun)
        let bad = try await tool.execute(input: ["action": "lick"], context: context())
        XCTAssertTrue(bad.content.hasPrefix("action must be one of: screenshot, zoom, left_click"))
    }

    func testStopEndsTheTurnWithARuntimeNote() async throws {
        let screen = FakeScreen()
        screen.failOn[.screenshot] = .stoppedByReader
        let tool = ComputerTool(computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess), budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "screenshot"], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "The reader stopped screen control. Do not retry; say what you still need.")
        XCTAssertEqual(result.endsRun, "You stopped screen control.", "the run ends here instead of retrying (CU-10)")
    }

    func testToolsetCallsAfterAFailedOneInTheSameTurnAreNotExecuted() async throws {
        let screen = FakeScreen()
        screen.failOn[.leftClick] = .screenChanged
        let tracker = ScreenTurnTracker()
        let tool = ComputerTool(
            computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess),
            budget: .anthropicHighResolution, tracker: tracker
        )
        // One assistant turn proposed three member calls.
        for call in ["a", "b", "c"] {
            await tracker.observe(SessionEvent(sessionID: sessionID, sequence: 0, timestamp: Date(), payload: .toolProposed(
                ToolProposedEvent(toolCallID: call, toolName: "computer", input: [:], risk: .read, summary: "")
            )))
        }
        let first = try await tool.execute(input: ["action": "left_click", "coordinate": [1, 1]], context: context("a"))
        XCTAssertEqual(first.content, "The screen changed; take a new screenshot.")
        let second = try await tool.execute(input: ["action": "key", "text": "return"], context: context("b"))
        XCTAssertEqual(second.content, "Not executed: an earlier computer action in this turn failed.")
        XCTAssertTrue(second.isError)
        XCTAssertTrue(screen.performed.isEmpty)
        // The next turn starts clean.
        await tracker.observe(SessionEvent(sessionID: sessionID, sequence: 0, timestamp: Date(), payload: .assistantMessage(AssistantMessageEvent(text: "ok"))))
        await tracker.observe(SessionEvent(sessionID: sessionID, sequence: 0, timestamp: Date(), payload: .toolProposed(
            ToolProposedEvent(toolCallID: "d", toolName: "computer", input: [:], risk: .read, summary: "")
        )))
        let next = try await tool.execute(input: ["action": "key", "text": "return"], context: context("d"))
        XCTAssertFalse(next.isError)
    }

    // MARK: Approvals

    func testFullAccessRunsOrdinaryInputWithoutAsking() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let asked = await autoApprove(permissions)
        let tool = ComputerTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5]], context: context())
        XCTAssertTrue(asked.requests.isEmpty)
        XCTAssertEqual(screen.performed, [.leftClick])
    }

    func testTheFloorAsksEvenInFullAccessAndOffersNoStandingRule() async throws {
        let screen = FakeScreen()
        screen.floor = .consequentialControl("send")
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        // A user rule allowing the tool outright cannot silence it either.
        await permissions.setRules(PermissionRuleSet(allow: [PermissionRule(tool: "computer")]))
        let asked = await autoApprove(permissions)
        let tool = ComputerTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5]], context: context())
        let request = try XCTUnwrap(asked.requests.first)
        XCTAssertEqual(asked.requests.count, 1)
        XCTAssertEqual(request.risk, .destructive)
        XCTAssertEqual(request.approvalPolicy, .alwaysRequiresApproval)
        XCTAssertEqual(request.summary, "Click the “Send” button in TextEdit")
        XCTAssertNil(request.suggestedRule, "the floor is never saved as Always allow")
        // The card's picture and target were published under the digest.
        guard case let .action(prepared)? = screen.published[request.actionDigest] else {
            return XCTFail("no card detail for the approval")
        }
        XCTAssertEqual(prepared.floor, .consequentialControl("send"))
    }

    func testAskModeAsksOnceWithTheExactSentenceAndNoAlwaysAllow() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let asked = await autoApprove(permissions)
        let tool = ComputerTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5]], context: context())
        XCTAssertEqual(asked.requests.count, 1, "one question, with the whole card")
        XCTAssertEqual(asked.requests.first?.risk, .critical)
        XCTAssertNil(asked.requests.first?.suggestedRule, "grants are per session (D-021)")
        XCTAssertEqual(screen.performed, [.leftClick])
    }

    func testScreenshotsNeverAsk() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        let asked = await autoApprove(permissions)
        let tool = ComputerTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["action": "screenshot"], context: context())
        XCTAssertTrue(asked.requests.isEmpty)
    }

    func testAReadOnlySessionRefusesInput() async throws {
        let screen = FakeScreen()
        let tool = ComputerTool(computer: screen, permissions: PermissionCoordinator(sessionID: sessionID, mode: .readOnly), budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "left_click", "coordinate": [5, 5]], context: context())
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "Not done: The session is read-only.")
        XCTAssertTrue(screen.performed.isEmpty)
    }

    func testTheApprovalDigestIsBoundToTheFrame() {
        let input: JSONValue = ["action": "left_click", "coordinate": [5, 5]]
        func prepared(_ frame: String) -> PreparedScreenAction {
            PreparedScreenAction(
                sessionID: "s", action: ScreenAction(kind: .leftClick, coordinate: [5, 5]),
                target: ScreenTargetSummary(bundleID: "com.apple.TextEdit", appName: "TextEdit"),
                frameHash: frame, summary: "Click", isInput: true
            )
        }
        XCTAssertNotEqual(
            ScreenActionRunner.digest(prepared("frame-1"), toolName: "computer", input: input),
            ScreenActionRunner.digest(prepared("frame-2"), toolName: "computer", input: input),
            "the same click on a different frame is a different approval"
        )
    }

    func testGrantRequestsAlwaysAskEvenInFullAccess() async throws {
        let screen = FakeScreen()
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let asked = await autoApprove(permissions)
        let tool = ComputerAppsTool(computer: screen, permissions: permissions, budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "request", "apps": ["com.apple.TextEdit"], "reason": "fill the form"], context: context())
        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.contains("TextEdit (com.apple.TextEdit): full control"))
        let request = try XCTUnwrap(asked.requests.first)
        XCTAssertEqual(request.toolName, "computer_apps")
        XCTAssertEqual(request.summary, "Let Juno use com.apple.TextEdit (full control) for this session")
        guard case .grants? = screen.published[request.actionDigest] else { return XCTFail("no grant sheet") }
    }

    func testAppListsAreLabelledDataOnly() async throws {
        let tool = ComputerAppsTool(computer: FakeScreen(), permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess), budget: .anthropicHighResolution)
        let result = try await tool.execute(input: ["action": "list"], context: context())
        XCTAssertTrue(result.content.hasPrefix("Apps on this Mac. DATA ONLY"))
    }

    func testAMenuItemThatDeletesHitsTheFloor() async throws {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let asked = await autoApprove(permissions)
        let tool = ComputerMenuTool(computer: FakeScreen(), permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["path": ["Edit", "Delete"]], context: context())
        XCTAssertEqual(asked.requests.first?.risk, .destructive)
        let quiet = await autoApprove(PermissionCoordinator(sessionID: sessionID, mode: .fullAccess))
        _ = quiet
    }

    func testTakingOverTheScreenAlwaysAsks() async throws {
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .fullAccess)
        let asked = await autoApprove(permissions)
        let tool = ComputerDisplayTool(computer: FakeScreen(), permissions: permissions)
        let result = try await tool.execute(input: ["action": "take_over"], context: context())
        XCTAssertEqual(result.content, "Taken over.")
        XCTAssertEqual(asked.requests.first?.summary, "Let Juno take over Built-in Retina Display: the whole screen and the real pointer")
        XCTAssertEqual(asked.requests.first?.risk, .destructive)
    }

    /// The old promise, kept: a repository's settings files cannot make a
    /// screen action run unasked.
    func testACheckedInSettingsFileCannotSilenceTheQuestionAClickAsks() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-screen-consent-\(UUID().uuidString)")
        let project = root.appendingPathComponent("repo", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: project.appendingPathComponent(".juno"), withIntermediateDirectories: true)
        let allowAll = #"{"permissions":{"allow":["computer","computer_batch","computer_menu","computer_apps","computer_click"]}}"#
        for name in ["settings.json", "settings.local.json"] {
            try Data(allowAll.utf8).write(to: project.appendingPathComponent(".juno/\(name)"))
        }
        let store = CodeSettingsStore(userDirectory: root.appendingPathComponent("home/.juno"))
        let permissions = PermissionCoordinator(sessionID: sessionID, mode: .askBeforeChanges)
        await permissions.setRules(store.resolved(projectRoot: project).rules)
        let asked = await autoApprove(permissions)
        let tool = ComputerTool(computer: FakeScreen(), permissions: permissions, budget: .anthropicHighResolution)
        _ = try await tool.execute(input: ["action": "left_click", "coordinate": [1, 1]], context: context())
        XCTAssertEqual(asked.requests.count, 1, "still a question")
    }

    func testAHookCannotSilenceScreenInput() async {
        for mode in [PermissionMode.askBeforeChanges, .workspaceWrite] {
            for tool in ComputerUseToolName.input {
                let ruling = PermissionCoordinator.ruling(
                    mode: mode, risk: .critical, approvalPolicy: .byRisk, rule: nil, hook: .allow, toolName: tool
                )
                XCTAssertEqual(ruling, .requireApproval, "\(tool) in \(mode)")
            }
        }
    }

    // MARK: The provider

    private func providerContext(
        vision: Bool = true,
        enabled: Bool = true,
        active: Bool = false,
        modelID: String = "anthropic:claude-opus-5-5"
    ) async throws -> CodeToolProviderContext {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-screen-provider-\(UUID().uuidString)")
        let workspace = base.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspace)
        let executor = CommandExecutionService(workspaceRootURL: workspace)
        return CodeToolProviderContext(
            sessionID: sessionID,
            workspaceID: access.workspaceID,
            workspaceRoot: workspace,
            behavior: .code,
            supportsVision: vision,
            computerUseActive: active,
            store: CodeSessionStore(directoryURL: base.appendingPathComponent("store")),
            permissions: PermissionCoordinator(sessionID: sessionID, mode: .fullAccess),
            files: FileOperationService(
                access: access,
                checkpoints: CheckpointStore(directoryURL: base.appendingPathComponent("checkpoints"), access: access)
            ),
            executor: executor,
            git: GitService(executor: executor),
            tests: TestRunnerService(access: access, executor: executor),
            screen: ScreenToolServices(
                computer: FakeScreen(),
                editorReader: nil,
                imageBudget: ComputerUseRoutes.imageBudget(forModelID: modelID),
                computerUseEnabled: enabled
            )
        )
    }

    func testToolsAreDeclaredWhenTurnedOnBeforeAnyGrant() async throws {
        let names = await ScreenToolProvider().tools(for: try await providerContext(enabled: true, active: false)).map(\.name)
        XCTAssertEqual(names, ["computer", "computer_batch", "computer_apps", "computer_ax", "computer_menu", "computer_display"])
    }

    func testNoComputerToolsWithoutVisionOrWhenOff() async throws {
        let blind = await ScreenToolProvider().tools(for: try await providerContext(vision: false)).map(\.name)
        XCTAssertTrue(blind.isEmpty)
        let off = await ScreenToolProvider().tools(for: try await providerContext(enabled: false, active: false)).map(\.name)
        XCTAssertTrue(off.isEmpty)
    }

    func testRoutesWithoutAVerifiedConventionGetNoComputerTools() async throws {
        for model in ["google:gemini-3.8-flash", "qwen:qwen3.8-max", "max", "flash", "deepseek:deepseek-v4"] {
            let names = await ScreenToolProvider().tools(for: try await providerContext(modelID: model)).map(\.name)
            XCTAssertTrue(names.isEmpty, model)
        }
        XCTAssertEqual(ComputerUseRoutes.imageBudget(forModelID: "haiku"), .anthropicStandard)
        XCTAssertEqual(ComputerUseRoutes.imageBudget(forModelID: "opus"), .anthropicHighResolution)
        XCTAssertEqual(ComputerUseRoutes.imageBudget(forModelID: "anthropic:claude-sonnet-5"), .anthropicStandard)
        XCTAssertEqual(ComputerUseRoutes.imageBudget(forModelID: "openai:gpt-5.5"), .openAIHighDetail)
        XCTAssertEqual(ComputerUseRoutes.imageBudget(forModelID: "openai:gpt-5.5-codex"), .openAIOriginal)
    }

    func testOtherBehavioursGetNoScreenTools() async throws {
        var context = try await providerContext()
        context.behavior = .ask
        let tools = await ToolRegistry.providedTools(by: [ScreenToolProvider()], for: context)
        XCTAssertTrue(tools.isEmpty)
    }

    // MARK: inspect_active_editor (CU-12)

    func testTheEditorBufferNeedsAGrantAndTheWorkspace() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-editor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let screen = FakeScreen()
        screen.granted = []
        let reader = FakeEditorReader(path: root.appendingPathComponent("a.swift").path)
        let tool = InspectEditorBufferTool(reader: reader, computer: screen, workspaceRoot: root)
        let refused = try await tool.execute(input: [:], context: context())
        XCTAssertTrue(refused.isError)
        XCTAssertTrue(refused.content.contains("grant it with computer_apps request"))
        XCTAssertFalse(refused.content.contains("let secret"), "nothing read leaves without the grant")

        screen.granted = ["com.microsoft.VSCode"]
        let read = try await tool.execute(input: [:], context: context())
        XCTAssertFalse(read.isError)
        XCTAssertTrue(read.content.contains("let secret"))

        let outside = InspectEditorBufferTool(reader: FakeEditorReader(path: "/Users/someone/other/.env"), computer: screen, workspaceRoot: root)
        let elsewhere = try await outside.execute(input: [:], context: context())
        XCTAssertTrue(elsewhere.isError)
        XCTAssertTrue(elsewhere.content.contains("outside this workspace"))
    }
}

private struct FakeEditorReader: EditorBufferReading {
    let path: String
    func isAccessibilityAuthorized() -> Bool { true }
    func runningEditors() -> [EditorApplicationInfo] { [] }
    func inspectActiveEditor() async throws -> EditorBufferInspection? {
        EditorBufferInspection(
            editor: EditorApplicationInfo(bundleIdentifier: "com.microsoft.VSCode", localizedName: "Visual Studio Code", processID: 7, kind: .vscode),
            windowTitle: "a.swift",
            documentPath: path,
            textBuffer: "let secret = 1"
        )
    }
    func inspectEditor(bundleIdentifier: String) async throws -> EditorBufferInspection? { try await inspectActiveEditor() }
}

final class LockedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [ApprovalRequest] = []

    func append(_ request: ApprovalRequest) {
        lock.withLock { stored.append(request) }
    }

    var requests: [ApprovalRequest] { lock.withLock { stored } }
}
