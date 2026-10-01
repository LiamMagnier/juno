import Foundation
import JunoCodeCore

// How each lane of the autonomous-agent build registers its tools from its own
// file, instead of every lane editing the session's tool assembly
// (CODE_AGENT_SPEC §6.0).
//
// A lane writes one `CodeToolProvider` beside its tools; the session consults
// every provider in `JunoCodeUI/Models/CodeToolProviders.swift` when it builds
// a Code turn's registry. A provider only adds tools. Every call still goes
// through the registry's validation and `PermissionCoordinator`, so a provider
// can offer a capability but can never grant one.

/// What a provider is told about the session whose registry it contributes
/// to. Lanes add the services their tools need here as they land.
public struct CodeToolProviderContext: Sendable {
    public var sessionID: CodeSessionID
    public var workspaceID: WorkspaceID
    /// The workspace's root folder.
    public var workspaceRoot: URL
    public var behavior: AgentBehavior
    /// Whether the session's model can see images.
    public var supportsVision: Bool
    /// Whether the reader has started screen control for this session.
    public var computerUseActive: Bool
    public var store: CodeSessionStore
    public var permissions: PermissionCoordinator
    public var files: any FileOperating
    public var executor: any CommandExecuting
    public var git: any GitServicing
    public var tests: any TestRunning
    /// The session's run ledger, for recorders that mint evidence (checks,
    /// UI checks, reviews) through ``VerificationLedgerWriting``. Nil where
    /// the session keeps none.
    ///
    /// A tool call should return its evidence as a side effect
    /// (`.verificationRecorded`, `.uiVerificationRecorded`) instead: the loop
    /// takes those in call order after the batch, so a check made after an
    /// edit in the same batch counts against it. A write here lands mid-batch,
    /// before that batch's edits are counted, and so reads as stale. It is for
    /// evidence minted outside a tool call: the runtime's own check runner,
    /// a Preview check that settles later.
    public var runLedger: RunLedgerRecorder?
    /// The session's durable shells, when the workspace has them (Lane D's
    /// `preview_server attach` promotes a shell's server).
    public var shells: (any ShellSessionManaging)?
    /// Screen control and the Simulator, for Lane C's provider. Nil where the
    /// session has neither (Lane C).
    public var screen: ScreenToolServices?

    public init(
        sessionID: CodeSessionID,
        workspaceID: WorkspaceID,
        workspaceRoot: URL,
        behavior: AgentBehavior,
        supportsVision: Bool,
        computerUseActive: Bool,
        store: CodeSessionStore,
        permissions: PermissionCoordinator,
        files: any FileOperating,
        executor: any CommandExecuting,
        git: any GitServicing,
        tests: any TestRunning,
        runLedger: RunLedgerRecorder? = nil,
        shells: (any ShellSessionManaging)? = nil,
        screen: ScreenToolServices? = nil
    ) {
        self.sessionID = sessionID
        self.workspaceID = workspaceID
        self.workspaceRoot = workspaceRoot
        self.behavior = behavior
        self.supportsVision = supportsVision
        self.computerUseActive = computerUseActive
        self.store = store
        self.permissions = permissions
        self.files = files
        self.executor = executor
        self.git = git
        self.tests = tests
        self.runLedger = runLedger
        self.shells = shells
        self.screen = screen
    }
}

/// One lane's contribution to a Code session's tools.
public protocol CodeToolProvider: Sendable {
    /// The tools this provider offers the session described by `context`, or
    /// none. Called once per registry build, so the tool list stays byte-stable
    /// for as long as the session's turn contract does.
    func tools(for context: CodeToolProviderContext) async -> [any CodeTool]
}

public extension ToolRegistry {
    /// Every tool the providers offer for `context`, in provider order.
    ///
    /// Only Code turns consult providers: Ask, Plan and Survey stay read-only
    /// by construction, and a lane that needs a tool there adds it to the
    /// inspection set instead. Sub-agents get none, as they get no session
    /// tools.
    static func providedTools(
        by providers: [any CodeToolProvider],
        for context: CodeToolProviderContext
    ) async -> [any CodeTool] {
        guard context.behavior == .code else { return [] }
        var tools: [any CodeTool] = []
        for provider in providers {
            tools += await provider.tools(for: context)
        }
        return tools
    }
}
