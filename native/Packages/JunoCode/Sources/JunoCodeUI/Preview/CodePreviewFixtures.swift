#if DEBUG
import Foundation
import JunoCodeCore

/// The workbench states the DEBUG preview harness can launch into.
///
/// Every scenario is reachable from a single launch: each one owns a session in
/// the sidebar, and the launch argument only chooses which is selected first. QA
/// can therefore sweep the whole matrix without relaunching, while screenshots
/// and UI tests can still pin one surface deterministically.
public enum CodePreviewScenario: String, CaseIterable, Sendable {
    /// A finished run: prompt, reasoning, tool calls, edits, completion.
    case transcript
    /// Mid-run: active reasoning, a streaming answer, a tool still executing.
    case streaming
    /// A pending permission request, plus an approved and a denied one.
    case approval
    /// stdout, stderr, and output long enough to exercise clamping.
    case terminal
    /// Added, modified and deleted files with real hunks.
    case diffs
    /// A passing run and a failing run with assertion output.
    case tests
    /// Overlong prompts, answers, paths and identifiers.
    case longText
    /// A failed session with a non-recoverable error.
    case error
    /// A dropped runtime connection that is retrying.
    case disconnected
    /// A brand-new session with nothing in the transcript.
    case empty

    public static let launchFlag = "--juno-code-ui-preview"
    public static let scenarioFlag = "--juno-code-preview-scenario"

    /// Reads `--juno-code-preview-scenario <name>` from a launch argument list.
    /// An absent or unrecognised name falls back to `.transcript` rather than
    /// failing, so a typo still yields an inspectable window.
    public static func fromArguments(_ arguments: [String]) -> CodePreviewScenario {
        guard let flagIndex = arguments.firstIndex(of: scenarioFlag),
              case let valueIndex = arguments.index(after: flagIndex),
              valueIndex < arguments.endIndex,
              let scenario = CodePreviewScenario(rawValue: arguments[valueIndex])
        else { return .transcript }
        return scenario
    }

    /// Stable session identifier for this scenario. Derived from the raw value
    /// rather than a UUID or `hashValue`, both of which vary per launch and
    /// would break selection restore, screenshots and UI tests.
    var sessionID: CodeSessionID { CodeSessionID(value: "sess-preview-\(rawValue)") }
}

/// A complete, self-contained snapshot of one session's UI state.
///
/// Everything the workbench renders is here, which is what lets a preview
/// `SessionController` exist with no workspace, no runtime and no transport.
struct CodePreviewFixture: Sendable {
    var session: CodeSession
    var workspaceDisplayName: String
    var workspacePathHint: String
    var isGitRepository: Bool
    var events: [SessionEvent] = []
    var pendingApprovals: [ApprovalRequest] = []
    var terminal: [TerminalLine] = []
    var lastTestRun: TestRunCompletedEvent?
    var gitStatus: GitStatusSummary?
    var gitHistory: [GitCommitInfo] = []
    var testSuggestions: [TestSuggestion] = []
    var rootEntries: [FileEntry] = []
    var instructionFiles: [FileEntry] = []
    /// Directory listings keyed by path value; `""` is the workspace root.
    var directoryChildren: [String: [FileEntry]] = [:]
    var diffs: [String: TextDiff] = [:]
    var transientError: String?
    var composerText: String = ""
    var runStartedAt: Date?

    func children(of path: WorkspacePath?) -> [FileEntry] {
        guard let path else { return rootEntries }
        return directoryChildren[path.value] ?? []
    }

    /// Every known file, for the Files tab's name filter.
    var allEntries: [FileEntry] {
        rootEntries + directoryChildren.values.flatMap { $0 }
    }
}

// MARK: - Fixture construction

/// Deterministic fixture data for every preview scenario.
///
/// Time is the one thing that cannot be frozen: the sidebar groups sessions by
/// recency, so fixtures are anchored to a single process-wide instant and every
/// timestamp is a fixed offset from it. Structure, ordering, identifiers and
/// text are byte-identical between launches; only the absolute wall clock moves,
/// which is what keeps "Today"/"Yesterday" honest.
enum CodePreviewData {
    /// Captured once per process so every fixture shares one anchor.
    static let anchor = Date()

    static func minutes(_ value: Double) -> Date {
        anchor.addingTimeInterval(-value * 60)
    }

    /// A stable, launch-independent identifier slug.
    static func slug(_ raw: String) -> String {
        let mapped = raw.lowercased().map { character -> Character in
            character.isLetter || character.isNumber ? character : "-"
        }
        return String(mapped).split(separator: "-").joined(separator: "-")
    }

    /// Fixture paths are compile-time constants; an invalid one is a bug that
    /// the preview-harness tests must fail on immediately.
    static func path(_ raw: String) -> WorkspacePath {
        do {
            return try WorkspacePath(raw)
        } catch {
            preconditionFailure("invalid preview fixture path \(raw): \(error)")
        }
    }

    // MARK: Workspaces

    static let workspaces: [WorkspaceRecord] = [
        workspace("juno", "/Users/preview/Developer/juno", git: true),
        workspace(
            "JunoNativeKit",
            "/Users/preview/Developer/juno/native/Packages/JunoNativeKit",
            git: true
        ),
        workspace("design-notes", "/Users/preview/Documents/design-notes", git: false),
    ]

    private static func workspace(
        _ name: String,
        _ path: String,
        git: Bool
    ) -> WorkspaceRecord {
        WorkspaceRecord(
            descriptor: WorkspaceDescriptor(
                id: WorkspaceID(value: "ws-preview-\(name)"),
                displayName: name,
                localPathHint: path,
                isGitRepository: git,
                lastOpenedAt: anchor
            ),
            // Deliberately empty: a preview workspace carries no security-scoped
            // bookmark, so nothing can resolve it into filesystem access.
            bookmarkData: Data()
        )
    }

    // MARK: Scenario table

    /// Which workspace, status, recency and sidebar treatment each scenario
    /// gets. Chosen so the sidebar covers all seven statuses, both favourite
    /// states, and all four date groups in a single launch.
    private struct Placement {
        let title: String
        let workspace: Int
        let status: SessionStatus
        var favorite: Bool = false
        var branch: String?
        var errorSummary: String?
        let minutesAgo: Double
    }

    private static let placements: [CodePreviewScenario: Placement] = [
        .streaming: Placement(
            title: "Refactor the sync coordinator",
            workspace: 0, status: .running, favorite: true,
            branch: "feat/sync-refactor", minutesAgo: 1
        ),
        .disconnected: Placement(
            title: "Reindex the workspace tree",
            workspace: 1, status: .stopping,
            branch: "chore/reindex", minutesAgo: 3
        ),
        .approval: Placement(
            title: "Add attachment upload contract",
            workspace: 0, status: .waitingForApproval, favorite: true,
            branch: "feat/attachments", minutesAgo: 6
        ),
        .terminal: Placement(
            title: "Profile the outbox drainer",
            workspace: 1, status: .cancelled,
            branch: "perf/outbox", minutesAgo: 24
        ),
        .diffs: Placement(
            title: "Split the permission coordinator",
            workspace: 0, status: .completed,
            branch: "refactor/permissions", minutesAgo: 48
        ),
        .tests: Placement(
            title: "Fix the outbox replay test",
            workspace: 1, status: .failed,
            branch: "fix/outbox-replay",
            errorSummary: "swift test exited with code 1", minutesAgo: 92
        ),
        .transcript: Placement(
            title: "Tidy the design tokens",
            workspace: 0, status: .completed,
            branch: "chore/tokens", minutesAgo: 300
        ),
        .longText: Placement(
            title: "Summarise the entity-revision backfill migration and its rollout constraints",
            workspace: 2, status: .completed, minutesAgo: 1_500
        ),
        .error: Placement(
            title: "Explore the artifact schema",
            workspace: 0, status: .failed,
            branch: "main",
            errorSummary: "The agent stopped: workspace write denied", minutesAgo: 2_900
        ),
        .empty: Placement(
            title: "Draft the release checklist",
            workspace: 2, status: .idle, minutesAgo: 10_200
        ),
    ]

    /// Sidebar ordering: newest first, matching the live store's sort.
    static let orderedScenarios: [CodePreviewScenario] = CodePreviewScenario.allCases
        .sorted { lhs, rhs in
            (placements[lhs]?.minutesAgo ?? 0) < (placements[rhs]?.minutesAgo ?? 0)
        }

    static var sessions: [CodeSession] {
        orderedScenarios.map { session(for: $0) }
    }

    static func session(for scenario: CodePreviewScenario) -> CodeSession {
        guard let placement = placements[scenario] else {
            preconditionFailure("preview scenario \(scenario.rawValue) has no placement")
        }
        return CodeSession(
            id: scenario.sessionID,
            workspaceID: workspaces[placement.workspace].id,
            title: placement.title,
            status: placement.status,
            configuration: AgentConfiguration(
                modelID: scenario == .longText ? "claude-opus-4-8" : "claude-sonnet-5",
                reasoningEffort: scenario == .longText ? .high : .medium,
                permissionMode: scenario == .approval ? .askBeforeChanges : .workspaceWrite
            ),
            isFavorite: placement.favorite,
            gitBranch: placement.branch,
            hasPendingApproval: scenario == .approval,
            lastErrorSummary: placement.errorSummary,
            createdAt: minutes(placement.minutesAgo + 30),
            updatedAt: minutes(placement.minutesAgo)
        )
    }

    // MARK: Fixtures

    static func fixture(for scenario: CodePreviewScenario) -> CodePreviewFixture {
        guard let placement = placements[scenario] else {
            preconditionFailure("preview scenario \(scenario.rawValue) has no placement")
        }
        let workspace = workspaces[placement.workspace].descriptor
        var fixture = CodePreviewFixture(
            session: session(for: scenario),
            workspaceDisplayName: workspace.displayName,
            workspacePathHint: workspace.localPathHint,
            isGitRepository: workspace.isGitRepository
        )
        fixture.rootEntries = rootEntries(git: workspace.isGitRepository)
        fixture.directoryChildren = directoryChildren
        fixture.instructionFiles = workspace.isGitRepository
            ? [FileEntry(path: path("CLAUDE.md"), isDirectory: false, byteCount: 4_210)]
            : []
        fixture.testSuggestions = workspace.isGitRepository
            ? [
                TestSuggestion(command: "swift test", toolchain: "SwiftPM"),
                TestSuggestion(command: "npm test", toolchain: "Node"),
            ]
            : []
        if workspace.isGitRepository {
            fixture.gitStatus = gitStatus(branch: placement.branch, scenario: scenario)
            fixture.gitHistory = gitHistory
        }
        apply(scenario, to: &fixture)
        return fixture
    }

    // swiftlint:disable:next cyclomatic_complexity
    private static func apply(_ scenario: CodePreviewScenario, to fixture: inout CodePreviewFixture) {
        var builder = TranscriptBuilder(sessionID: scenario.sessionID, start: fixture.session.createdAt)
        builder.created(
            workspaceID: fixture.session.workspaceID,
            workspaceName: fixture.workspaceDisplayName,
            configuration: fixture.session.configuration
        )

        switch scenario {
        case .empty:
            // Nothing beyond creation: the canvas must show its pre-run state.
            fixture.composerText = ""

        case .transcript:
            builder.user("Tidy the design tokens: fold the duplicated spacing constants into one scale and update every call site.")
            builder.reasoning("Read the token file, found two overlapping spacing scales, and planned a single source of truth.")
            builder.assistant("I found two spacing scales — `JunoCodeTheme.Spacing` and a private `Metrics` enum in the inspector. I folded the second into the first and updated the call sites.")
            builder.toolRun(
                id: "call-read-tokens", name: "read_file",
                summary: "Read Sources/JunoCodeUI/Theme/JunoCodeTheme.swift",
                risk: .read, status: .succeeded,
                result: "95 lines read.", duration: 0.2
            )
            builder.toolRun(
                id: "call-grep-metrics", name: "grep",
                summary: "Search for “private enum Metrics”",
                risk: .read, status: .succeeded,
                result: "3 matches in 2 files.", duration: 0.6
            )
            builder.fileChanged("Sources/JunoCodeUI/Theme/JunoCodeTheme.swift", .modified, 12, 4)
            builder.fileChanged("Sources/JunoCodeUI/Views/Inspector/InspectorView.swift", .modified, 6, 11)
            builder.assistant("Both files now read from the shared scale. The inspector's local constants are gone.")
            builder.testRun("swift test", passed: true, tests: 179, failures: 0, duration: 42.8)
            builder.runCompleted("Unified the spacing scale", files: 2, testsPassed: true, duration: 96.4)
            fixture.lastTestRun = TestRunCompletedEvent(
                command: "swift test", passed: true, testsRun: 179, failures: 0, durationSeconds: 42.8
            )
            fixture.diffs = [
                "Sources/JunoCodeUI/Theme/JunoCodeTheme.swift": tokenDiff,
                "Sources/JunoCodeUI/Views/Inspector/InspectorView.swift": inspectorDiff,
            ]

        case .streaming:
            builder.user("Refactor the sync coordinator so reconnect backoff is testable without sleeping.")
            builder.reasoning("Reading the coordinator to find where the backoff delay is computed.")
            builder.toolRun(
                id: "call-read-coordinator", name: "read_file",
                summary: "Read Sources/JunoSync/NativeSyncCoordinator.swift",
                risk: .read, status: .succeeded,
                result: "612 lines read.", duration: 0.3
            )
            builder.assistant("The backoff is computed inline in `reconnectLoop()`. I'll extract it into a `BackoffSchedule` value so it can be tested without waiting on the clock. Starting with the extraction —")
            // A proposed-but-uncompleted call: the row must show its spinner.
            builder.toolProposed(
                id: "call-write-backoff", name: "write_file",
                summary: "Create Sources/JunoSync/BackoffSchedule.swift",
                risk: .write
            )
            builder.toolStarted("call-write-backoff")
            fixture.runStartedAt = minutes(0.6)

        case .approval:
            builder.user("Add the attachment upload contract and regenerate the Swift client.")
            builder.reasoning("The generator writes outside the workspace, so this needs an explicit approval.")
            builder.toolRun(
                id: "call-read-openapi", name: "read_file",
                summary: "Read contracts/openapi/juno-native-v1.yaml",
                risk: .read, status: .succeeded,
                result: "1 842 lines read.", duration: 0.4
            )
            // One already approved and one already denied, so the resolved rows
            // render both outcomes.
            let approved = approval(
                id: "approval-preview-granted",
                session: scenario.sessionID,
                tool: "write_file",
                summary: "Write contracts/openapi/juno-native-v1.yaml",
                risk: .write,
                at: minutes(5.2)
            )
            builder.approvalRequested(approved)
            builder.approvalResolved(approved.id, .approved)
            builder.toolRun(
                id: "call-write-openapi", name: "write_file",
                summary: "Write contracts/openapi/juno-native-v1.yaml",
                risk: .write, status: .succeeded,
                result: "+188 −0", duration: 0.9
            )
            builder.fileChanged("contracts/openapi/juno-native-v1.yaml", .modified, 188, 0)
            let denied = approval(
                id: "approval-preview-denied",
                session: scenario.sessionID,
                tool: "run_command",
                summary: "Run rm -rf .build/checkouts",
                risk: .critical,
                at: minutes(4.6)
            )
            builder.approvalRequested(denied)
            builder.approvalResolved(denied.id, .denied)
            // A full propose → start → denied cycle, so the denied tool row
            // actually renders. A bare completion has no row to attach to.
            builder.toolRun(
                id: "call-clean", name: "run_command",
                summary: "Run rm -rf .build/checkouts",
                risk: .critical, status: .denied,
                result: "Denied by the user.", duration: 0
            )
            builder.assistant("Understood — I left `.build/checkouts` alone and regenerated in place instead.")
            // And one still pending, which drives the banner and the badge.
            let pending = approval(
                id: "approval-preview-pending",
                session: scenario.sessionID,
                tool: "run_command",
                summary: "Run npm run native:contract:generate",
                risk: .execute,
                at: minutes(4.1)
            )
            builder.approvalRequested(pending)
            fixture.pendingApprovals = [pending]
            fixture.runStartedAt = minutes(6)
            fixture.diffs = ["contracts/openapi/juno-native-v1.yaml": contractDiff]

        case .terminal:
            builder.user("Profile the outbox drainer and show me where the time goes.")
            builder.toolRun(
                id: "call-run-profile", name: "run_command",
                summary: "Run swift run juno-profile --target outbox-drainer",
                risk: .execute, status: .cancelled,
                result: "Stopped by the user after 3 200 lines of output.", duration: 18.4,
                output: terminalOutput
            )
            builder.assistant("I stopped the profiler — it was still warming up and had already produced a few thousand lines.")
            fixture.terminal = terminalLines

        case .diffs:
            builder.user("Split the permission coordinator: move the policy table into its own file and delete the dead legacy shim.")
            builder.reasoning("Three files are involved: a new policy file, the coordinator itself, and an obsolete shim.")
            builder.toolRun(
                id: "call-write-policy", name: "write_file",
                summary: "Create Sources/JunoCodeRuntime/PermissionPolicyTable.swift",
                risk: .write, status: .succeeded, result: "+34 −0", duration: 0.3
            )
            builder.fileChanged("Sources/JunoCodeRuntime/PermissionPolicyTable.swift", .created, 34, 0)
            builder.fileChanged("Sources/JunoCodeRuntime/PermissionCoordinator.swift", .modified, 9, 31)
            builder.fileChanged("Sources/JunoCodeRuntime/LegacyPermissionShim.swift", .deleted, 0, 58)
            builder.fileChanged(
                "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift",
                .modified, 3, 3
            )
            builder.assistant("The policy table is now standalone, the coordinator only dispatches, and the legacy shim is gone.")
            builder.runCompleted("Split the permission coordinator", files: 4, testsPassed: nil, duration: 61.2)
            fixture.diffs = [
                "Sources/JunoCodeRuntime/PermissionPolicyTable.swift": createdDiff,
                "Sources/JunoCodeRuntime/PermissionCoordinator.swift": modifiedDiff,
                "Sources/JunoCodeRuntime/LegacyPermissionShim.swift": deletedDiff,
                "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift": longPathDiff,
            ]

        case .tests:
            builder.user("The outbox replay test is failing. Find out why and fix it.")
            builder.reasoning("Running the suite first to see the actual assertion.")
            builder.toolRun(
                id: "call-run-tests-fail", name: "run_tests",
                summary: "Run swift test --filter OutboxReplayTests",
                risk: .execute, status: .failed,
                result: "1 of 4 tests failed.", duration: 31.7,
                output: failingTestOutput
            )
            builder.testRun("swift test --filter OutboxReplayTests", passed: false, tests: 4, failures: 1, duration: 31.7)
            builder.assistant("`testReplayKeepsOriginalIdempotencyKey` fails because the drainer regenerates the key when the response is ambiguous. The key must be persisted with the mutation, not derived at submit time.")
            builder.fileChanged("Sources/JunoSync/MutationOutboxDrainer.swift", .modified, 7, 3)
            builder.toolRun(
                id: "call-run-tests-pass", name: "run_tests",
                summary: "Run swift test --filter OutboxReplayTests",
                risk: .execute, status: .succeeded,
                result: "4 of 4 tests passed.", duration: 29.9
            )
            builder.testRun("swift test --filter OutboxReplayTests", passed: true, tests: 4, failures: 0, duration: 29.9)
            builder.errorOccurred(
                "The full suite was not re-run: only the filtered tests were verified.",
                recoverable: true
            )
            builder.runCompleted("Fixed the replay key", files: 1, testsPassed: true, duration: 148.3)
            // The session is failed overall even though the filtered run passed,
            // so the failed badge and the green last-run can be checked together.
            fixture.lastTestRun = TestRunCompletedEvent(
                command: "swift test --filter OutboxReplayTests",
                passed: false, testsRun: 4, failures: 1, durationSeconds: 31.7
            )
            fixture.terminal = failingTestTerminalLines
            fixture.diffs = ["Sources/JunoSync/MutationOutboxDrainer.swift": modifiedDiff]

        case .longText:
            builder.user(longPrompt)
            builder.reasoning(longReasoning)
            builder.assistant(longAnswer)
            builder.toolRun(
                id: "call-read-migration-with-a-deliberately-long-identifier-0123456789abcdef",
                name: "read_file",
                summary: "Read prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql from the deployed migration history",
                risk: .read, status: .succeeded,
                result: "212 lines read.", duration: 0.5
            )
            builder.fileChanged(
                "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift",
                .modified, 2, 2
            )
            builder.runCompleted("Summarised the migration", files: 1, testsPassed: nil, duration: 210.7)
            fixture.composerText = longComposerDraft
            fixture.diffs = [
                "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift": longPathDiff,
            ]

        case .error:
            builder.user("Explore the artifact schema and write a summary into docs/.")
            builder.reasoning("Reading the schema before writing anything.")
            builder.toolRun(
                id: "call-read-schema", name: "read_file",
                summary: "Read prisma/schema.prisma",
                risk: .read, status: .succeeded,
                result: "1 104 lines read.", duration: 0.6
            )
            builder.toolRun(
                id: "call-write-docs", name: "write_file",
                summary: "Write docs/artifact-schema.md",
                risk: .write, status: .failed,
                result: "Permission denied: the session is read-only.", duration: 0.1
            )
            builder.errorOccurred(
                "The agent stopped: workspace write denied. The session's permission mode is read-only, so docs/artifact-schema.md was not created.",
                recoverable: false
            )
            fixture.transientError = "The run failed: workspace write denied."

        case .disconnected:
            builder.user("Reindex the workspace tree and report how many files are ignored.")
            builder.reasoning("Walking the tree with the gitignore matcher applied.")
            builder.toolProposed(
                id: "call-index-tree", name: "list_directory",
                summary: "Index the workspace tree",
                risk: .read
            )
            builder.toolStarted("call-index-tree")
            builder.errorOccurred(
                "Lost the connection to the agent runtime. Reconnecting…",
                recoverable: true
            )
            fixture.transientError = "Reconnecting to the agent runtime — attempt 2 of 5."
            fixture.runStartedAt = minutes(3)
        }

        fixture.events = builder.events
    }

    // MARK: - Transcript building

    /// Builds a transcript with strictly increasing sequences and stable event
    /// identifiers, so `ForEach` identity and scroll restoration are repeatable.
    private struct TranscriptBuilder {
        let sessionID: CodeSessionID
        private var start: Date
        private(set) var events: [SessionEvent] = []

        init(sessionID: CodeSessionID, start: Date) {
            self.sessionID = sessionID
            self.start = start
        }

        private mutating func append(_ payload: SessionEventPayload) {
            let sequence = events.count + 1
            events.append(
                SessionEvent(
                    id: "preview-\(sessionID.value)-\(sequence)",
                    sessionID: sessionID,
                    sequence: sequence,
                    // Six seconds apart: enough to read as a real timeline.
                    timestamp: start.addingTimeInterval(Double(sequence) * 6),
                    payload: payload
                )
            )
        }

        mutating func created(
            workspaceID: WorkspaceID,
            workspaceName: String,
            configuration: AgentConfiguration
        ) {
            append(.sessionCreated(SessionCreatedEvent(
                workspaceID: workspaceID,
                workspaceName: workspaceName,
                configuration: configuration
            )))
        }

        mutating func user(_ text: String) {
            append(.userPrompt(UserPromptEvent(text: text)))
        }

        mutating func assistant(_ text: String) {
            append(.assistantMessage(AssistantMessageEvent(text: text)))
        }

        mutating func reasoning(_ text: String) {
            append(.reasoningSummary(ReasoningSummaryEvent(summary: text)))
        }

        mutating func toolProposed(id: String, name: String, summary: String, risk: ActionRisk) {
            append(.toolProposed(ToolProposedEvent(
                toolCallID: id,
                toolName: name,
                input: .object(["summary": .string(summary)]),
                risk: risk,
                summary: summary
            )))
        }

        mutating func toolStarted(_ id: String) {
            append(.toolStarted(ToolStartedEvent(toolCallID: id)))
        }

        mutating func toolCompleted(
            _ id: String,
            status: ToolCompletionStatus,
            result: String,
            duration: Double
        ) {
            append(.toolCompleted(ToolCompletedEvent(
                toolCallID: id,
                status: status,
                resultSummary: result,
                durationSeconds: duration
            )))
        }

        /// A full propose → start → output → complete cycle.
        mutating func toolRun(
            id: String,
            name: String,
            summary: String,
            risk: ActionRisk,
            status: ToolCompletionStatus,
            result: String,
            duration: Double,
            output: [(ToolOutputChannel, String)] = []
        ) {
            toolProposed(id: id, name: name, summary: summary, risk: risk)
            toolStarted(id)
            for (channel, text) in output {
                append(.toolOutput(ToolOutputEvent(toolCallID: id, channel: channel, text: text)))
            }
            toolCompleted(id, status: status, result: result, duration: duration)
        }

        mutating func approvalRequested(_ request: ApprovalRequest) {
            append(.approvalRequested(request))
        }

        mutating func approvalResolved(_ id: String, _ decision: ApprovalDecision) {
            append(.approvalResolved(ApprovalResolvedEvent(approvalID: id, decision: decision)))
        }

        mutating func fileChanged(
            _ rawPath: String,
            _ kind: FileChangeKind,
            _ added: Int,
            _ removed: Int
        ) {
            append(.fileChanged(FileChangedEvent(
                path: CodePreviewData.path(rawPath),
                kind: kind,
                linesAdded: added,
                linesRemoved: removed,
                // Preview checkpoints are labels only; no store backs them.
                // Derived from the path, not `hashValue`, which is seeded per
                // process and would change the identifier on every launch.
                checkpointID: "preview-checkpoint-\(CodePreviewData.slug(rawPath))"
            )))
        }

        mutating func testRun(
            _ command: String,
            passed: Bool,
            tests: Int,
            failures: Int,
            duration: Double
        ) {
            append(.testRunCompleted(TestRunCompletedEvent(
                command: command,
                passed: passed,
                testsRun: tests,
                failures: failures,
                durationSeconds: duration
            )))
        }

        mutating func errorOccurred(_ message: String, recoverable: Bool) {
            append(.errorOccurred(ErrorEvent(message: message, isRecoverable: recoverable)))
        }

        mutating func runCompleted(
            _ summary: String,
            files: Int,
            testsPassed: Bool?,
            duration: Double
        ) {
            append(.runCompleted(RunCompletedEvent(
                summary: summary,
                filesChanged: files,
                testsPassed: testsPassed,
                durationSeconds: duration
            )))
        }
    }

    private static func approval(
        id: String,
        session: CodeSessionID,
        tool: String,
        summary: String,
        risk: ActionRisk,
        at date: Date
    ) -> ApprovalRequest {
        ApprovalRequest(
            id: id,
            sessionID: session,
            actionDigest: "preview-digest-\(id)",
            toolName: tool,
            summary: summary,
            risk: risk,
            requestedAt: date,
            expiresAt: date.addingTimeInterval(300)
        )
    }
}

// MARK: - Panel fixtures

extension CodePreviewData {
    static func rootEntries(git: Bool) -> [FileEntry] {
        var entries: [FileEntry] = [
            FileEntry(path: path("Sources"), isDirectory: true, byteCount: nil),
            FileEntry(path: path("Tests"), isDirectory: true, byteCount: nil),
            FileEntry(path: path("README.md"), isDirectory: false, byteCount: 3_180),
        ]
        if git {
            entries.insert(
                FileEntry(path: path("Package.swift"), isDirectory: false, byteCount: 2_940),
                at: 2
            )
            entries.append(FileEntry(path: path("CLAUDE.md"), isDirectory: false, byteCount: 4_210))
        }
        return entries
    }

    static let directoryChildren: [String: [FileEntry]] = [
        "Sources": [
            FileEntry(path: path("Sources/JunoCodeCore"), isDirectory: true, byteCount: nil),
            FileEntry(path: path("Sources/JunoCodeUI"), isDirectory: true, byteCount: nil),
        ],
        "Sources/JunoCodeCore": [
            FileEntry(path: path("Sources/JunoCodeCore/DiffEngine.swift"), isDirectory: false, byteCount: 8_412),
            FileEntry(path: path("Sources/JunoCodeCore/PermissionModel.swift"), isDirectory: false, byteCount: 3_206),
            FileEntry(path: path("Sources/JunoCodeCore/SessionEvents.swift"), isDirectory: false, byteCount: 6_118),
        ],
        "Sources/JunoCodeUI": [
            FileEntry(path: path("Sources/JunoCodeUI/Theme/JunoCodeTheme.swift"), isDirectory: false, byteCount: 2_744),
            FileEntry(path: path("Sources/JunoCodeUI/Views/WorkbenchView.swift"), isDirectory: false, byteCount: 3_902),
        ],
        "Tests": [
            FileEntry(path: path("Tests/JunoCodeCoreTests"), isDirectory: true, byteCount: nil),
        ],
        "Tests/JunoCodeCoreTests": [
            FileEntry(path: path("Tests/JunoCodeCoreTests/DiffEngineTests.swift"), isDirectory: false, byteCount: 5_530),
        ],
    ]

    static func gitStatus(branch: String?, scenario: CodePreviewScenario) -> GitStatusSummary {
        switch scenario {
        case .empty, .transcript:
            return GitStatusSummary(branch: branch, upstream: "origin/\(branch ?? "main")", ahead: 0, behind: 0, files: [])
        case .diffs:
            return GitStatusSummary(
                branch: branch, upstream: "origin/\(branch ?? "main")", ahead: 2, behind: 1,
                files: [
                    GitFileStatus(path: "Sources/JunoCodeRuntime/PermissionPolicyTable.swift", indexState: "A", worktreeState: " "),
                    GitFileStatus(path: "Sources/JunoCodeRuntime/PermissionCoordinator.swift", indexState: " ", worktreeState: "M"),
                    GitFileStatus(path: "Sources/JunoCodeRuntime/LegacyPermissionShim.swift", indexState: "D", worktreeState: " "),
                    GitFileStatus(path: "native/Packages/JunoNativeKit/Sources/JunoSync/Internal/Coordination/MutationOutboxDrainerConfiguration.swift", indexState: " ", worktreeState: "M"),
                    GitFileStatus(path: "scratch/notes.md", indexState: "?", worktreeState: "?"),
                ]
            )
        case .error:
            // A conflicted tree, so the conflict styling is inspectable.
            return GitStatusSummary(
                branch: branch, upstream: "origin/main", ahead: 0, behind: 4,
                files: [
                    GitFileStatus(path: "prisma/schema.prisma", indexState: "U", worktreeState: "U"),
                    GitFileStatus(path: "docs/native/STATUS.md", indexState: " ", worktreeState: "M"),
                ]
            )
        default:
            return GitStatusSummary(
                branch: branch, upstream: "origin/\(branch ?? "main")", ahead: 1, behind: 0,
                files: [
                    GitFileStatus(path: "Sources/JunoSync/MutationOutboxDrainer.swift", indexState: "M", worktreeState: " "),
                    GitFileStatus(path: "Tests/JunoSyncTests/OutboxReplayTests.swift", indexState: " ", worktreeState: "M"),
                ]
            )
        }
    }

    static let gitHistory: [GitCommitInfo] = [
        GitCommitInfo(
            hash: "d48f41f2c9b7a1e4f6d3b8c0a5e79214d6f8b3c1",
            shortHash: "d48f41f",
            subject: "feat(code): deterministic DEBUG preview harness",
            author: "Liam Magnier", date: minutes(180)
        ),
        GitCommitInfo(
            hash: "01c6a74e8b2d5f9c3a7e1b4d6f8092c5a3e7b1d9",
            shortHash: "01c6a74",
            subject: "feat(native): mutation-conflict resolution and the offline replay proof",
            author: "Liam Magnier", date: minutes(900)
        ),
        GitCommitInfo(
            hash: "677d781a4c6e9b2f5d8a0c3e7b1f4d69a2c5e8b0",
            shortHash: "677d781",
            subject: "feat(code): integrate the Juno Code workbench into JunoMac",
            author: "Liam Magnier", date: minutes(2_600)
        ),
        GitCommitInfo(
            hash: "778a47d3f1b6c8e0a2d5f79b4c1e6a8d3f0b5c72",
            shortHash: "778a47d",
            subject: "feat(native): add real memory and settings",
            author: "Liam Magnier", date: minutes(5_400)
        ),
    ]
}

// MARK: - Terminal fixtures

extension CodePreviewData {
    /// Interleaved stdout and stderr, then a long tail. 420 lines is past the
    /// point where naive layouts stop scrolling and start growing.
    static let terminalOutput: [(ToolOutputChannel, String)] = {
        var lines: [(ToolOutputChannel, String)] = [
            (.stdout, "Building for debugging…"),
            (.stdout, "[1/3] Compiling JunoCodeCore DiffEngine.swift"),
            (.stderr, "warning: 'sleep(_:)' is deprecated: use Task.sleep(for:) instead"),
            (.stdout, "[2/3] Compiling JunoCodeRuntime AgentOrchestrator.swift"),
            (.stdout, "[3/3] Linking juno-profile"),
            (.stdout, "Build complete! (11.42s)"),
            (.log, "profiler: attaching to target outbox-drainer"),
            (.stderr, "profiler: symbolication is degraded — dSYM not found for JunoSync"),
        ]
        for index in 1...400 {
            let micros = 120 + (index * 37) % 900
            lines.append((
                .stdout,
                String(
                    format: "  %04d  drain.tick        %6dµs  queue=%3d  inflight=%d",
                    index, micros, (index * 7) % 64, index % 4
                )
            ))
            if index % 50 == 0 {
                lines.append((.stderr, "  !! backpressure: queue depth exceeded soft limit at tick \(index)"))
            }
        }
        lines.append((.stdout, "^C profiler: interrupted by user"))
        return lines
    }()

    static let terminalLines: [TerminalLine] = terminalOutput.enumerated().map { index, entry in
        TerminalLine(id: index + 1, channel: entry.0, text: entry.1)
    }

    static let failingTestOutput: [(ToolOutputChannel, String)] = [
        (.stdout, "Building for debugging…"),
        (.stdout, "Test Suite 'OutboxReplayTests' started"),
        (.stdout, "Test Case 'testEnqueueSurvivesRelaunch' passed (0.412 seconds)."),
        (.stdout, "Test Case 'testSubmitsOnceOnReconnect' passed (0.508 seconds)."),
        (.stderr, "/Users/preview/Developer/juno/native/Packages/JunoNativeKit/Tests/JunoSyncTests/OutboxReplayTests.swift:214: error: -[OutboxReplayTests testReplayKeepsOriginalIdempotencyKey] : XCTAssertEqual failed:"),
        (.stderr, "    (\"8f2c1a9e-4d67-4b03-9f18-2c7a5e0d3b64\") is not equal to"),
        (.stderr, "    (\"c40b7d15-9a3e-4f82-b6d1-7e05a2c98f31\") —"),
        (.stderr, "    the drainer regenerated the idempotency key instead of replaying the persisted one"),
        (.stdout, "Test Case 'testReplayKeepsOriginalIdempotencyKey' failed (1.204 seconds)."),
        (.stdout, "Test Case 'testAmbiguousLossReplaysAsNoOp' passed (0.377 seconds)."),
        (.stdout, "Test Suite 'OutboxReplayTests' failed at 2026-07-22 14:02:19.331."),
        (.stdout, "\t Executed 4 tests, with 1 failure (0 unexpected) in 31.701 seconds"),
    ]

    static let failingTestTerminalLines: [TerminalLine] = failingTestOutput.enumerated().map { index, entry in
        TerminalLine(id: index + 1, channel: entry.0, text: entry.1)
    }
}

// MARK: - Long-text fixtures

extension CodePreviewData {
    static let longPrompt = """
        Summarise the entity-revision backfill migration and every constraint on rolling it out. \
        I need to know exactly which columns it adds, whether each statement is safe to run \
        against a database that already has rows, whether the unique indexes it creates can be \
        built without violating existing data, and what happens if it is applied out of order \
        relative to a migration that was authored earlier but deployed later. Include the exact \
        NULL-typing expressions it relies on, because a previous attempt failed when the bare \
        NULL literals could not be coerced to timestamps, and explain why the feature-branch \
        copy of that file must never be deployed in place of the version on the main branch. \
        Finally, tell me what a forward-only replacement would have to look like if we decide \
        the out-of-order migration is unportable.
        """

    static let longReasoning = """
        Read the migration, compared it against the deployed schema, checked each ALTER TABLE for \
        idempotency, and traced the NULL::timestamp casts that the earlier attempt was missing.
        """

    static let longAnswer = """
        The migration adds four columns and two unique indexes, and its safety depends entirely \
        on the NULL typing.

        **Columns.** It adds `deletedAt`, `revisionCreatedAt`, `supersededAt` and `sourceRevisionId`. \
        The first three are nullable timestamps; the fourth is a nullable text foreign key. All four \
        are added with `ADD COLUMN IF NOT EXISTS`, so re-running the statement is safe.

        **The NULL typing.** The backfill selects literal NULLs into those timestamp columns. A bare \
        `NULL` has no type, so Postgres cannot infer the column type inside the `INSERT ... SELECT`, \
        and the statement fails. Every one of those literals must be written `NULL::timestamp`. This \
        is the single difference between the version on the main branch and the copy carried on the \
        feature branches, and it is why the feature-branch copy must never be deployed: it contains \
        the bare-NULL form that already failed once.

        **The unique indexes.** `entity_revision_entity_id_revision_key` and \
        `entity_revision_source_revision_id_key` are both created `CONCURRENTLY`. Concurrent index \
        creation cannot run inside a transaction block, so this migration must not be batched with \
        others. If existing rows already violate either constraint the build fails and leaves an \
        invalid index behind, which then has to be dropped by hand before retrying.

        **Ordering.** A migration authored earlier but deployed later sorts before this one \
        lexicographically. Prisma applies in name order, so the recorded order would no longer match \
        the applied order and drift detection will flag it. Renaming the earlier file changes its \
        identity and risks re-application, so the safe move is a new forward-only migration that \
        carries the same statements under a timestamp after the deployed one, guarded by \
        `IF NOT EXISTS` throughout so it is a no-op wherever the original already ran.
        """

    static let longComposerDraft = """
        Follow up on the above: draft the forward-only replacement migration, keep every statement \
        guarded so it is a no-op on databases where the original already applied, and explain in a \
        comment at the top why the out-of-order file was abandoned rather than renamed.
        """
}

// MARK: - Diff fixtures

extension CodePreviewData {
    private static func hunk(
        oldStart: Int, oldCount: Int, newStart: Int, newCount: Int,
        _ lines: [(DiffLineKind, String, Int?, Int?)]
    ) -> DiffHunk {
        DiffHunk(
            oldStart: oldStart, oldCount: oldCount,
            newStart: newStart, newCount: newCount,
            lines: lines.map { DiffLine(kind: $0.0, text: $0.1, oldLineNumber: $0.2, newLineNumber: $0.3) }
        )
    }

    static let tokenDiff = TextDiff(
        hunks: [
            hunk(oldStart: 18, oldCount: 7, newStart: 18, newCount: 9, [
                (.context, "public enum Spacing {", 18, 18),
                (.context, "    public static let tight: CGFloat = 4", 19, 19),
                (.removed, "    public static let compact: CGFloat = 8", 20, nil),
                (.removed, "    public static let control: CGFloat = 12", 21, nil),
                (.added, "    public static let compact: CGFloat = 8", nil, 20),
                (.added, "    public static let control: CGFloat = 12", nil, 21),
                (.added, "    public static let content: CGFloat = 16", nil, 22),
                (.added, "    public static let section: CGFloat = 24", nil, 23),
                (.context, "}", 22, 24),
            ]),
        ],
        linesAdded: 12, linesRemoved: 4
    )

    static let inspectorDiff = TextDiff(
        hunks: [
            hunk(oldStart: 96, oldCount: 8, newStart: 96, newCount: 3, [
                (.context, "struct ChangesTab: View {", 96, 96),
                (.removed, "    private enum Metrics {", 97, nil),
                (.removed, "        static let rowSpacing: CGFloat = 8", 98, nil),
                (.removed, "        static let padding: CGFloat = 12", 99, nil),
                (.removed, "    }", 100, nil),
                (.removed, "", 101, nil),
                (.context, "    @Bindable var controller: SessionController", 102, 97),
                (.context, "}", 103, 98),
            ]),
        ],
        linesAdded: 6, linesRemoved: 11
    )

    static let contractDiff = TextDiff(
        hunks: [
            hunk(oldStart: 1_204, oldCount: 3, newStart: 1_204, newCount: 9, [
                (.context, "  /api/v1/attachments:", 1_204, 1_204),
                (.added, "    post:", nil, 1_205),
                (.added, "      operationId: createAttachmentUpload", nil, 1_206),
                (.added, "      requestBody:", nil, 1_207),
                (.added, "        required: true", nil, 1_208),
                (.added, "        content:", nil, 1_209),
                (.added, "          application/json:", nil, 1_210),
                (.context, "      responses:", 1_205, 1_211),
                (.context, "        '201':", 1_206, 1_212),
            ]),
        ],
        linesAdded: 188, linesRemoved: 0
    )

    static let createdDiff = TextDiff(
        hunks: [
            hunk(oldStart: 0, oldCount: 0, newStart: 1, newCount: 8, [
                (.added, "import Foundation", nil, 1),
                (.added, "", nil, 2),
                (.added, "/// The permission decision table, split out of the coordinator.", nil, 3),
                (.added, "enum PermissionPolicyTable {", nil, 4),
                (.added, "    static func ruling(", nil, 5),
                (.added, "        mode: PermissionMode, risk: ActionRisk", nil, 6),
                (.added, "    ) -> PermissionRuling {", nil, 7),
                (.added, "}", nil, 8),
            ]),
        ],
        linesAdded: 34, linesRemoved: 0
    )

    static let modifiedDiff = TextDiff(
        hunks: [
            hunk(oldStart: 42, oldCount: 6, newStart: 42, newCount: 4, [
                (.context, "    func evaluate(risk: ActionRisk) -> PermissionRuling {", 42, 42),
                (.removed, "        switch (mode, risk) {", 43, nil),
                (.removed, "        case (_, .critical): return .requireApproval", 44, nil),
                (.removed, "        default: return .allow", 45, nil),
                (.added, "        PermissionPolicyTable.ruling(mode: mode, risk: risk)", nil, 43),
                (.context, "    }", 46, 44),
            ]),
            hunk(oldStart: 118, oldCount: 4, newStart: 116, newCount: 5, [
                (.context, "    private func persist(_ key: String) {", 118, 116),
                (.removed, "        let key = UUID().uuidString", 119, nil),
                (.added, "        // Replay the persisted key; never regenerate it.", nil, 117),
                (.added, "        let key = storedIdempotencyKey ?? key", nil, 118),
                (.context, "    }", 120, 119),
            ]),
        ],
        linesAdded: 9, linesRemoved: 31
    )

    static let deletedDiff = TextDiff(
        hunks: [
            hunk(oldStart: 1, oldCount: 6, newStart: 0, newCount: 0, [
                (.removed, "import Foundation", 1, nil),
                (.removed, "", 2, nil),
                (.removed, "/// Bridges the pre-1.0 permission API. Unused since 677d781.", 3, nil),
                (.removed, "@available(*, deprecated)", 4, nil),
                (.removed, "enum LegacyPermissionShim {", 5, nil),
                (.removed, "}", 6, nil),
            ]),
        ],
        linesAdded: 0, linesRemoved: 58
    )

    static let longPathDiff = TextDiff(
        hunks: [
            hunk(oldStart: 27, oldCount: 5, newStart: 27, newCount: 5, [
                (.context, "public struct MutationOutboxDrainerConfiguration: Sendable {", 27, 27),
                (.removed, "    public var maximumConcurrentSubmissions: Int = 1", 28, nil),
                (.removed, "    public var reconnectBackoffCeilingSeconds: Double = 30", 29, nil),
                (.added, "    public var maximumConcurrentSubmissions: Int = 2", nil, 28),
                (.added, "    public var reconnectBackoffCeilingSeconds: Double = 60", nil, 29),
                (.context, "}", 30, 30),
            ]),
        ],
        linesAdded: 3, linesRemoved: 3
    )
}
#endif
