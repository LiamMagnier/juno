import Foundation
import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

private final class PreviewNotificationBox: @unchecked Sendable {
    var value: CodePreviewTarget?
}

/// Proves the DEBUG preview harness is inert *by construction* and
/// deterministic between launches.
///
/// The central claim these tests defend: a preview `SessionController` is built
/// without a `Live` bundle, so `WorkspaceContext` — and with it
/// `CommandExecutionService`, `GitService`, `CheckpointStore`,
/// `WorkspaceIndexService`, `ToolRegistry` and the model transport — is absent
/// from the object graph rather than merely unused. There is no flag a future
/// edit could forget to check.
@MainActor
final class CodePreviewHarnessTests: XCTestCase {

    // MARK: - Structural unreachability

    func testPreviewControllersHaveNoRuntimeAttached() async throws {
        let model = WorkbenchModel.preview()
        await model.bootstrap()

        for scenario in CodePreviewScenario.allCases {
            let resolved = await model.controller(for: scenario.sessionID)
            let controller = try XCTUnwrap(
                resolved,
                "\(scenario.rawValue) must produce a controller"
            )
            XCTAssertNil(
                controller.live,
                "\(scenario.rawValue): preview must carry no live runtime bundle"
            )
            XCTAssertNil(
                controller.context,
                """
                \(scenario.rawValue): preview must have no WorkspaceContext. \
                Without it there is no CommandExecutionService, GitService, \
                CheckpointStore, WorkspaceIndexService, ToolRegistry or model \
                client reachable from the UI.
                """
            )
        }
    }

    func testPreviewInspectorIsReadOnlyAndFailsClosedWithoutAnActiveSurface() async throws {
        let tool = CodePreviewInspectTool()

        XCTAssertEqual(tool.name, "inspect_preview")
        XCTAssertEqual(tool.assessRisk(input: [:]), .read)
        XCTAssertTrue(tool.description.contains("optional screenshot"))

        do {
            _ = try await tool.execute(
                input: ["include_screenshot": false],
                context: ToolContext(
                    sessionID: CodeSessionID(),
                    toolCallID: "preview-inspection-test",
                    emitOutput: { _, _ in }
                )
            )
            XCTFail("an inspection must not invent a preview when no surface is open")
        } catch let error as ToolError {
            guard case let .executionFailed(message) = error else {
                return XCTFail("unexpected tool error: \(error)")
            }
            XCTAssertTrue(message.contains("No active local Preview"))
        }
    }

    func testPreviewOpenToolRequestsTheOwningWorkspaceSurface() async throws {
        let sessionID = CodeSessionID(value: "preview-open-tool-\(UUID().uuidString)")
        let root = URL(fileURLWithPath: "/tmp/juno-preview-open", isDirectory: true)
        let tool = CodePreviewOpenTool(workspaceRoot: root)
        let expectation = expectation(description: "preview request posted")
        let received = PreviewNotificationBox()
        let observer = NotificationCenter.default.addObserver(
            forName: .junoCodePreviewOpenRequested,
            object: nil,
            queue: .main
        ) { notification in
            received.value = notification.object as? CodePreviewTarget
            expectation.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        XCTAssertEqual(tool.assessRisk(input: [:]), .critical)
        let result = try await tool.execute(
            input: [:],
            context: ToolContext(
                sessionID: sessionID,
                toolCallID: "preview-open-tool-call",
                emitOutput: { _, _ in }
            )
        )

        await fulfillment(of: [expectation], timeout: 1)
        XCTAssertEqual(received.value?.sessionID, sessionID)
        XCTAssertEqual(received.value?.workspaceRootPath, root.path)
        XCTAssertTrue(result.content.contains("Opened the local Preview"))
    }

    func testPreviewBrowserIsScopedAndFailsClosedWithoutAnActiveSurface() async throws {
        let tool = CodePreviewBrowserTool()

        XCTAssertEqual(
            tool.assessRisk(input: ["action": "snapshot"]),
            .read
        )
        XCTAssertEqual(
            tool.assessRisk(input: ["action": "click", "ref": "e1"]),
            .critical
        )

        do {
            _ = try await tool.execute(
                input: ["action": "snapshot"],
                context: ToolContext(
                    sessionID: CodeSessionID(),
                    toolCallID: "preview-browser-test",
                    emitOutput: { _, _ in }
                )
            )
            XCTFail("browser QA must not invent a page when no Preview is open")
        } catch let error as ToolError {
            guard case let .executionFailed(message) = error else {
                return XCTFail("unexpected tool error: (error)")
            }
            XCTAssertTrue(message.contains("Use open_preview first"))
        }
    }

    func testPreviewInspectionPolicyAllowsOnlyTheActiveLoopbackOrigin() {
        XCTAssertTrue(CodePreviewInspectionPolicy.canInspectOrigin(URL(string: "http://localhost:5173/")!))
        XCTAssertTrue(CodePreviewInspectionPolicy.canInspectOrigin(URL(string: "http://127.0.0.1:4173/")!))
        XCTAssertTrue(CodePreviewInspectionPolicy.canInspectOrigin(URL(string: "http://[::1]:3000/")!))
        XCTAssertFalse(CodePreviewInspectionPolicy.canInspectOrigin(URL(string: "https://example.com/")!))
        XCTAssertFalse(CodePreviewInspectionPolicy.canInspectOrigin(URL(string: "http://192.168.1.5:3000/")!))

        let preview = URL(string: "http://localhost:5173/")!
        XCTAssertTrue(
            CodePreviewInspectionPolicy.sharesInspectableOrigin(
                URL(string: "http://localhost:5173/dashboard")!,
                with: preview
            )
        )
        XCTAssertFalse(
            CodePreviewInspectionPolicy.sharesInspectableOrigin(
                URL(string: "http://localhost:5174/")!,
                with: preview
            )
        )
        XCTAssertFalse(
            CodePreviewInspectionPolicy.sharesInspectableOrigin(
                URL(string: "https://example.com/")!,
                with: preview
            )
        )
    }

    func testPreviewTargetBindsTheOwningSessionAndReadsLegacySceneValues() throws {
        let owner = CodeSessionID(value: "preview-owner")
        let target = CodePreviewTarget(
            previewID: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!,
            workspaceRoot: URL(fileURLWithPath: "/tmp/project", isDirectory: true),
            sessionID: owner
        )
        let encoded = try JSONEncoder().encode(target)
        let decoded = try JSONDecoder().decode(CodePreviewTarget.self, from: encoded)

        XCTAssertEqual(decoded, target)

        let legacy = Data(
            "{\"previewID\":\"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\",\"workspaceRootPath\":\"/tmp/project\"}".utf8
        )
        let restoredLegacy = try JSONDecoder().decode(CodePreviewTarget.self, from: legacy)
        XCTAssertNil(restoredLegacy.sessionID)
        XCTAssertEqual(restoredLegacy.workspaceRootPath, "/tmp/project")
    }

    /// The preview workspaces are never registered and carry no bookmark, so
    /// even the workspace-directory path cannot hand out filesystem access.
    func testPreviewWorkspacesCarryNoBookmarkAndNeverOpen() async throws {
        let model = WorkbenchModel.preview()
        await model.bootstrap()

        XCTAssertFalse(model.workspaces.isEmpty)
        for workspace in model.workspaces {
            XCTAssertTrue(
                workspace.bookmarkData.isEmpty,
                "\(workspace.descriptor.displayName): preview workspaces must hold no security-scoped bookmark"
            )
            let context = await model.context(for: workspace.id)
            XCTAssertNil(
                context,
                "\(workspace.descriptor.displayName): preview must never open a workspace"
            )
        }
    }

    /// Preview storage points at a throwaway path that is never created: the
    /// production session store and checkpoint store are never opened.
    func testPreviewNeverTouchesItsStorageRoot() async throws {
        let model = WorkbenchModel.preview()
        await model.bootstrap()
        for scenario in CodePreviewScenario.allCases {
            _ = await model.controller(for: scenario.sessionID)
        }

        let root = model.dependencies.storageRootURL
        XCTAssertTrue(root.path.hasPrefix(FileManager.default.temporaryDirectory.path))
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: root.path),
            "preview must not create anything on disk at \(root.path)"
        )
    }

    // MARK: - Inert actions

    func testPreviewSendCannotStartAnAgentTurn() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .empty)
        )
        let before = controller.events.count

        controller.composerText = "Refactor everything"
        await controller.send()

        XCTAssertEqual(controller.composerText, "", "the composer still clears")
        // Two events, in this order, and the order is the point: the turn's
        // contract is recorded *before* the prompt, so the behaviour, permission
        // mode, model and reasoning effort a past turn ran under can still be read
        // off the transcript long after the composer has moved to a different
        // mode. Asserting the payloads rather than a count means a change to what
        // is recorded fails here instead of silently passing on an equal total.
        XCTAssertEqual(
            controller.events.count, before + 2,
            "the contract and the prompt are both appended locally"
        )
        let appended = controller.events.suffix(2).map(\.payload)
        guard case .turnConfiguration(let configuration) = appended.first else {
            return XCTFail("expected the turn contract first, got \(String(describing: appended.first))")
        }
        XCTAssertEqual(configuration.behavior, controller.session.configuration.behavior)
        XCTAssertEqual(
            configuration.permissionMode,
            controller.session.configuration.permissionMode
        )
        guard case .userPrompt(let userPrompt) = appended.last else {
            return XCTFail("expected the prompt second, got \(String(describing: appended.last))")
        }
        XCTAssertEqual(userPrompt.text, "Refactor everything")
        XCTAssertEqual(
            controller.transientError,
            "Preview mode does not run the agent: no model transport is attached."
        )
        // Nothing started, so the session never leaves its fixture status.
        XCTAssertEqual(controller.session.status, .idle)
        XCTAssertNil(controller.runStartedAt)
    }

    func testPreviewRunTestCannotExecuteACommand() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .tests)
        )
        let terminalBefore = controller.terminal

        await controller.runTest(command: "swift test")

        XCTAssertEqual(
            controller.transientError,
            "Preview mode does not run tests: no command executor is attached."
        )
        XCTAssertEqual(
            controller.terminal.map(\.text), terminalBefore.map(\.text),
            "no command ran, so no new output can appear"
        )
    }

    func testPreviewCommitCannotRunGit() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .diffs)
        )
        let historyBefore = controller.gitHistory

        let committed = await controller.commit(message: "chore: preview")

        XCTAssertFalse(committed)
        XCTAssertEqual(
            controller.transientError,
            "Preview mode does not run Git: no repository is attached."
        )
        XCTAssertEqual(controller.gitHistory, historyBefore)
    }

    /// Rejecting a change in preview records the review state without asking a
    /// checkpoint store to restore anything — there is no checkpoint store.
    func testPreviewRejectDoesNotRestoreCheckpoints() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .diffs)
        )
        let path = try XCTUnwrap(controller.changes.first?.path)

        await controller.rejectChange(path: path)

        XCTAssertEqual(
            controller.changes.first(where: { $0.path == path })?.reviewState,
            .rejected
        )
        XCTAssertNil(controller.transientError, "no restore was attempted, so no failure to report")
    }

    func testPreviewApprovalResolutionIsLocalOnly() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .approval)
        )
        let pending = try XCTUnwrap(controller.pendingApprovals.first)
        XCTAssertEqual(controller.session.status, .waitingForApproval)

        await controller.approve(pending.id)

        XCTAssertTrue(controller.pendingApprovals.isEmpty)
        XCTAssertTrue(
            controller.events.contains {
                if case let .approvalResolved(resolved) = $0.payload {
                    return resolved.approvalID == pending.id && resolved.decision == .approved
                }
                return false
            },
            "the resolution is recorded in the local transcript"
        )
    }

    func testPreviewFileListingsComeFromFixturesNotDisk() async throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .transcript)
        )
        XCTAssertFalse(controller.rootEntries.isEmpty)

        let sources = try XCTUnwrap(
            controller.rootEntries.first { $0.path.value == "Sources" }
        )
        let children = await controller.listDirectory(sources.path)
        XCTAssertFalse(children.isEmpty)
        XCTAssertTrue(children.allSatisfy { $0.path.value.hasPrefix("Sources/") })

        let matches = await controller.findFiles(nameContains: "DiffEngine", limit: 10)
        XCTAssertFalse(matches.isEmpty)
        XCTAssertTrue(matches.allSatisfy { !$0.isDirectory })

        // Refreshing the panels is a no-op: there is nothing to reload from.
        let before = controller.rootEntries
        await controller.refreshWorkspacePanels()
        XCTAssertEqual(controller.rootEntries, before)
    }

    // MARK: - Determinism

    /// Identifiers must derive from stable strings. `UUID()` and `hashValue`
    /// both vary per launch and would break selection restore, screenshot
    /// comparison and UI-test targeting.
    func testScenarioIdentifiersAreLaunchIndependent() throws {
        for scenario in CodePreviewScenario.allCases {
            XCTAssertEqual(scenario.sessionID.value, "sess-preview-\(scenario.rawValue)")

            let fixture = CodePreviewData.fixture(for: scenario)
            for (index, event) in fixture.events.enumerated() {
                XCTAssertEqual(event.sequence, index + 1, "\(scenario.rawValue): sequences are dense and ordered")
                XCTAssertEqual(
                    event.id,
                    "preview-\(scenario.sessionID.value)-\(index + 1)",
                    "\(scenario.rawValue): event identifiers must be derived, not random"
                )
            }
            for change in fixture.events.compactMap({ event -> FileChangedEvent? in
                if case let .fileChanged(change) = event.payload { return change }
                return nil
            }) {
                let checkpointID = try XCTUnwrap(change.checkpointID)
                XCTAssertTrue(
                    checkpointID.hasPrefix("preview-checkpoint-"),
                    "\(scenario.rawValue): checkpoint labels must be derived from the path"
                )
            }
        }
    }

    func testRebuildingAFixtureProducesTheSameState() throws {
        for scenario in CodePreviewScenario.allCases {
            let first = CodePreviewData.fixture(for: scenario)
            let second = CodePreviewData.fixture(for: scenario)
            XCTAssertEqual(first.events, second.events, "\(scenario.rawValue) transcript")
            XCTAssertEqual(first.pendingApprovals, second.pendingApprovals, "\(scenario.rawValue) approvals")
            XCTAssertEqual(first.terminal, second.terminal, "\(scenario.rawValue) terminal")
            XCTAssertEqual(first.gitStatus, second.gitStatus, "\(scenario.rawValue) git status")
            XCTAssertEqual(first.session, second.session, "\(scenario.rawValue) session")
        }
    }

    func testScenarioParsesFromLaunchArguments() {
        XCTAssertEqual(
            CodePreviewScenario.fromArguments(["app", "--juno-code-preview-scenario", "terminal"]),
            .terminal
        )
        XCTAssertEqual(
            CodePreviewScenario.fromArguments(["app", "--juno-code-preview-scenario", "longText"]),
            .longText
        )
        // Absent, unknown, and truncated arguments all fall back rather than
        // crashing, so a typo still yields an inspectable window.
        XCTAssertEqual(CodePreviewScenario.fromArguments(["app"]), .transcript)
        XCTAssertEqual(
            CodePreviewScenario.fromArguments(["app", "--juno-code-preview-scenario", "nope"]),
            .transcript
        )
        XCTAssertEqual(
            CodePreviewScenario.fromArguments(["app", "--juno-code-preview-scenario"]),
            .transcript
        )
    }

    func testLaunchArgumentSelectsTheMatchingSession() async throws {
        for scenario in CodePreviewScenario.allCases {
            let model = WorkbenchModel.preview(scenario: scenario)
            await model.bootstrap()
            XCTAssertEqual(model.selectedSessionID, scenario.sessionID)
            // Every other scenario stays reachable from the sidebar.
            XCTAssertEqual(model.sessions.count, CodePreviewScenario.allCases.count)
        }
    }

    // MARK: - Coverage of the QA matrix

    /// The fixtures must exercise every state the workbench can render, or the
    /// visual sweep silently skips surfaces.
    func testFixturesCoverEveryRenderableState() throws {
        var statuses: Set<SessionStatus> = []
        var toolStatuses: Set<ToolCompletionStatus> = []
        var changeKinds: Set<FileChangeKind> = []
        var channels: Set<ToolOutputChannel> = []
        var decisions: Set<ApprovalDecision> = []
        var risks: Set<ActionRisk> = []
        var subagentStatuses: Set<SubagentStatus> = []
        var payloadKinds: Set<String> = []
        var sawPendingApproval = false
        var sawRunningTool = false
        var sawPassingTests = false
        var sawFailingTests = false
        var sawRecoverableError = false
        var sawFatalError = false
        var sawConflictedGit = false
        var sawCleanGit = false

        for scenario in CodePreviewScenario.allCases {
            let fixture = CodePreviewData.fixture(for: scenario)
            statuses.insert(fixture.session.status)
            sawPendingApproval = sawPendingApproval || !fixture.pendingApprovals.isEmpty
            channels.formUnion(fixture.terminal.map(\.channel))
            if let status = fixture.gitStatus {
                sawConflictedGit = sawConflictedGit || status.hasConflicts
                sawCleanGit = sawCleanGit || status.isClean
            }

            var proposedTools: Set<String> = []
            var startedTools: Set<String> = []
            var completedTools: Set<String> = []
            for event in fixture.events {
                switch event.payload {
                case .sessionCreated: payloadKinds.insert("sessionCreated")
                case .turnConfiguration: payloadKinds.insert("turnConfiguration")
                case .userPrompt: payloadKinds.insert("userPrompt")
                case .assistantMessage: payloadKinds.insert("assistantMessage")
                case .reasoningSummary: payloadKinds.insert("reasoningSummary")
                case let .toolProposed(proposed):
                    payloadKinds.insert("toolProposed")
                    risks.insert(proposed.risk)
                    proposedTools.insert(proposed.toolCallID)
                case let .toolStarted(started):
                    payloadKinds.insert("toolStarted")
                    startedTools.insert(started.toolCallID)
                case let .toolOutput(output):
                    payloadKinds.insert("toolOutput")
                    channels.insert(output.channel)
                case let .toolCompleted(completed):
                    payloadKinds.insert("toolCompleted")
                    toolStatuses.insert(completed.status)
                    completedTools.insert(completed.toolCallID)
                case let .approvalRequested(request):
                    payloadKinds.insert("approvalRequested")
                    risks.insert(request.risk)
                case let .approvalResolved(resolved):
                    payloadKinds.insert("approvalResolved")
                    decisions.insert(resolved.decision)
                case let .fileChanged(change):
                    payloadKinds.insert("fileChanged")
                    changeKinds.insert(change.kind)
                case let .testRunCompleted(run):
                    payloadKinds.insert("testRunCompleted")
                    sawPassingTests = sawPassingTests || run.passed
                    sawFailingTests = sawFailingTests || !run.passed
                case let .subagentUpdated(update):
                    payloadKinds.insert("subagentUpdated")
                    subagentStatuses.insert(update.status)
                case .goalUpdated: payloadKinds.insert("goalUpdated")
                case .statusChanged: payloadKinds.insert("statusChanged")
                case let .errorOccurred(error):
                    payloadKinds.insert("errorOccurred")
                    sawRecoverableError = sawRecoverableError || error.isRecoverable
                    sawFatalError = sawFatalError || !error.isRecoverable
                case .userInstruction: payloadKinds.insert("userInstruction")
                case .userInstructionApplied: payloadKinds.insert("userInstructionApplied")
                case .runCompleted: payloadKinds.insert("runCompleted")
                }
            }
            sawRunningTool = sawRunningTool || !startedTools.subtracting(completedTools).isEmpty
            // TranscriptRow only draws a tool row for a `toolProposed` event, so
            // a start or completion without one is invisible in the canvas.
            XCTAssertTrue(
                startedTools.union(completedTools).subtracting(proposedTools).isEmpty,
                """
                \(scenario.rawValue): tool calls \
                \(startedTools.union(completedTools).subtracting(proposedTools).sorted()) \
                have no toolProposed event, so the transcript cannot render them
                """
            )
        }

        XCTAssertEqual(
            statuses, Set(SessionStatus.allCases),
            "every session status must appear so the sidebar glyphs and header badges are all inspectable"
        )
        XCTAssertEqual(
            toolStatuses, Set([.succeeded, .failed, .denied, .cancelled]),
            "every tool-call outcome must be rendered"
        )
        XCTAssertEqual(
            changeKinds, Set([.created, .modified, .deleted]),
            "added, modified and deleted files must all appear"
        )
        XCTAssertEqual(channels, Set([.stdout, .stderr, .log]), "stdout, stderr and log")
        XCTAssertEqual(decisions, Set([.approved, .denied]), "approved and denied requests")
        XCTAssertTrue(risks.isSuperset(of: [.read, .write, .execute, .critical]), "every risk level")
        XCTAssertTrue(sawPendingApproval, "a pending approval must drive the banner")
        XCTAssertTrue(sawRunningTool, "a started-but-uncompleted tool call must show the running state")
        XCTAssertTrue(sawPassingTests, "a successful test run")
        XCTAssertTrue(sawFailingTests, "a failed test run")
        XCTAssertTrue(sawRecoverableError, "a recoverable error")
        XCTAssertTrue(sawFatalError, "a non-recoverable error")
        XCTAssertTrue(sawConflictedGit, "a conflicted Git status")
        XCTAssertTrue(sawCleanGit, "a clean Git status")

        // Both halves of the Sub-agents pane must be inspectable, or the sweep
        // proves nothing about the Active/Done split or the live elapsed timer.
        XCTAssertTrue(
            subagentStatuses.contains(.running),
            "a running sub-agent must appear so the Active section and its timer are inspectable"
        )
        XCTAssertTrue(
            subagentStatuses.contains(.completed),
            "a finished sub-agent must appear so the Done section is inspectable"
        )

        for kind in ["sessionCreated", "turnConfiguration", "userPrompt",
                     "assistantMessage", "reasoningSummary",
                     "toolProposed", "toolStarted", "toolOutput", "toolCompleted",
                     "approvalRequested", "approvalResolved", "fileChanged",
                     "testRunCompleted", "subagentUpdated", "errorOccurred",
                     "runCompleted"] {
            XCTAssertTrue(payloadKinds.contains(kind), "no fixture renders \(kind)")
        }
    }

    /// Long content must actually be long, or the truncation and overflow
    /// checks in the visual sweep prove nothing.
    func testLongTextAndTerminalFixturesAreGenuinelyOversized() throws {
        let long = CodePreviewData.fixture(for: .longText)
        let prompt = try XCTUnwrap(long.events.compactMap { event -> String? in
            if case let .userPrompt(prompt) = event.payload { return prompt.text }
            return nil
        }.first)
        XCTAssertGreaterThan(prompt.count, 600, "the long prompt must overflow a single line")

        let answer = try XCTUnwrap(long.events.compactMap { event -> String? in
            if case let .assistantMessage(message) = event.payload { return message.text }
            return nil
        }.first)
        XCTAssertGreaterThan(answer.count, 1_200, "the long answer must span many lines")
        XCTAssertFalse(long.composerText.isEmpty, "a long composer draft must be pre-filled")

        let longestPath = long.events.compactMap { event -> Int? in
            if case let .fileChanged(change) = event.payload { return change.path.value.count }
            return nil
        }.max() ?? 0
        XCTAssertGreaterThan(longestPath, 90, "a path long enough to force middle truncation")

        let terminal = CodePreviewData.fixture(for: .terminal)
        XCTAssertGreaterThan(
            terminal.terminal.count, 400,
            "the terminal fixture must be long enough to expose unbounded growth"
        )
        XCTAssertTrue(terminal.terminal.contains { $0.channel == .stderr }, "interleaved stderr")
        XCTAssertEqual(
            terminal.terminal.map(\.id), Array(1...terminal.terminal.count),
            "terminal line identities must be dense and stable"
        )
    }

    /// Every scenario has a diff for each of its tracked changes, so the Diff
    /// tab is never an empty panel during the sweep.
    func testEveryTrackedChangeHasADiff() async throws {
        for scenario in CodePreviewScenario.allCases {
            let controller = SessionController(
                previewFixture: CodePreviewData.fixture(for: scenario)
            )
            for change in controller.changes {
                let diff = await controller.diff(for: change.path)
                XCTAssertNotNil(
                    diff,
                    "\(scenario.rawValue): \(change.path) is listed in Changes but has no diff"
                )
                XCTAssertFalse(
                    diff?.hunks.isEmpty ?? true,
                    "\(scenario.rawValue): \(change.path) has an empty diff"
                )
            }
        }
    }

    /// The workspace path shown in the Context tab must be abbreviated, never a
    /// raw absolute home path. The `.transcript` fixture deliberately lives
    /// under the real home so this actually exercises the abbreviation.
    func testWorkspacePathIsAbbreviatedForDisplay() throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .transcript)
        )
        XCTAssertFalse(controller.workspaceDisplayName.isEmpty)
        XCTAssertTrue(
            controller.workspacePathDisplay.hasPrefix("~/"),
            """
            expected a tilde-abbreviated path, got \(controller.workspacePathDisplay). \
            A home path must never be shown raw.
            """
        )
        XCTAssertFalse(controller.workspacePathDisplay.contains(NSHomeDirectory()))

        // A workspace outside the home stays absolute, which is correct.
        let outside = SessionController(
            previewFixture: CodePreviewData.fixture(for: .longText)
        )
        XCTAssertEqual(outside.workspacePathDisplay, "/Volumes/Team/design-notes")
    }

    // MARK: - Path presentation

    /// Middle-truncating a whole path eats the filename, which is the only part
    /// that identifies the file. Splitting keeps it readable at any width.
    func testPathDisplaySplitsFilenameFromDirectory() {
        let long = "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift"
        XCTAssertEqual(PathDisplay.fileName(long), "MutationOutboxDrainerConfiguration.swift")
        XCTAssertEqual(
            PathDisplay.directory(long),
            "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination"
        )

        // A root-level file has no directory line to show.
        XCTAssertEqual(PathDisplay.fileName("README.md"), "README.md")
        XCTAssertNil(PathDisplay.directory("README.md"))
    }

    func testFileCountIsPluralised() {
        XCTAssertEqual(PathDisplay.fileCount(0), "0 files")
        XCTAssertEqual(PathDisplay.fileCount(1), "1 file")
        XCTAssertEqual(PathDisplay.fileCount(2), "2 files")
    }

    // MARK: - Live preview discovery

    /// A repository can keep its browser app below `apps/` or `packages/` while
    /// the root package only owns orchestration scripts. The preview must offer
    /// the nested server and run it from the package that owns the script.
    func testPreviewDiscoveryFindsNestedServerAndKeepsRootPackageManager() async throws {
        let root = try makeTemporaryPreviewWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }

        try writePackage(
            at: root,
            scripts: ["lint": "eslint ."]
        )
        try Data("lockfileVersion: '9.0'\n".utf8)
            .write(to: root.appendingPathComponent("pnpm-lock.yaml"))

        let webRoot = root.appendingPathComponent("apps/web", isDirectory: true)
        try FileManager.default.createDirectory(
            at: webRoot,
            withIntermediateDirectories: true
        )
        try writePackage(
            at: webRoot,
            scripts: ["dev": "vite --host 0.0.0.0"]
        )

        // A dependency package must never appear as a user-selectable project.
        let dependencyRoot = root.appendingPathComponent("node_modules/fake-app", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dependencyRoot,
            withIntermediateDirectories: true
        )
        try writePackage(at: dependencyRoot, scripts: ["dev": "vite"])

        let result = await CodePreviewProjectDiscovery.scan(workspaceRoot: root)
        let webCommand = try XCTUnwrap(
            result.commands.first {
                $0.workspaceDisplayName == "apps/web" && $0.name == "dev"
            }
        )

        XCTAssertEqual(webCommand.commandLine, "pnpm run dev")
        XCTAssertEqual(webCommand.workspaceDisplayName, "apps/web")
        XCTAssertEqual(result.suggested?.id, webCommand.id)
        XCTAssertFalse(
            result.commands.contains { $0.workspaceRoot.path.contains("node_modules") },
            "dependency manifests must not become preview targets"
        )
    }

    /// Two packages can expose the same script name. Their stable IDs and menu
    /// labels must remain distinct so selecting one never starts the other.
    func testPreviewDiscoveryDisambiguatesMultipleNestedServers() async throws {
        let root = try makeTemporaryPreviewWorkspace()
        defer { try? FileManager.default.removeItem(at: root) }

        let webRoot = root.appendingPathComponent("apps/web", isDirectory: true)
        let docsRoot = root.appendingPathComponent("packages/docs", isDirectory: true)
        for packageRoot in [webRoot, docsRoot] {
            try FileManager.default.createDirectory(
                at: packageRoot,
                withIntermediateDirectories: true
            )
            try writePackage(at: packageRoot, scripts: ["dev": "vite"])
        }

        let result = await CodePreviewProjectDiscovery.scan(workspaceRoot: root)
        let devCommands = result.commands.filter { $0.name == "dev" }

        XCTAssertEqual(devCommands.count, 2)
        XCTAssertEqual(
            Set(devCommands.map(\.id)).count,
            2,
            "same-named scripts in different packages need different selections"
        )
        XCTAssertEqual(
            Set(devCommands.map(\.workspaceDisplayName)),
            ["apps/web", "packages/docs"]
        )
    }

    private func makeTemporaryPreviewWorkspace() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-code-preview-project-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        return root
    }

    private func writePackage(at root: URL, scripts: [String: String]) throws {
        let object: [String: Any] = ["scripts": scripts]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: root.appendingPathComponent("package.json"))
    }
}
