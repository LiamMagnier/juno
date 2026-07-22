import XCTest
import JunoCodeCore
@testable import JunoCodeUI

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
        XCTAssertEqual(
            controller.events.count, before + 1,
            "the prompt is appended locally so the transcript stays inspectable"
        )
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
                case .statusChanged: payloadKinds.insert("statusChanged")
                case let .errorOccurred(error):
                    payloadKinds.insert("errorOccurred")
                    sawRecoverableError = sawRecoverableError || error.isRecoverable
                    sawFatalError = sawFatalError || !error.isRecoverable
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

        for kind in ["sessionCreated", "userPrompt", "assistantMessage", "reasoningSummary",
                     "toolProposed", "toolStarted", "toolOutput", "toolCompleted",
                     "approvalRequested", "approvalResolved", "fileChanged",
                     "testRunCompleted", "errorOccurred", "runCompleted"] {
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
    /// raw absolute home path.
    func testWorkspacePathIsAbbreviatedForDisplay() throws {
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: .transcript)
        )
        XCTAssertFalse(controller.workspaceDisplayName.isEmpty)
        XCTAssertFalse(
            controller.workspacePathDisplay.hasPrefix("/Users/\(NSUserName())/"),
            "the current user's home directory must be abbreviated to ~"
        )
    }
}
