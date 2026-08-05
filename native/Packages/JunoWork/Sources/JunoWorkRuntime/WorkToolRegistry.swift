import Foundation
import JunoWorkCore
import JunoWorkLocal

/// The tools one run may call inside one granted folder, with argument
/// validation and the approval gate applied before anything executes.
///
/// Bound to a single grant, and the grant's ``WorkAccessMode`` is held here
/// rather than passed in per call. That is not tidiness: a mode supplied by the
/// caller is a mode the caller can get wrong, and the version of this type that
/// took one as a parameter would decide whether to *ask* a person using a
/// different answer from the one ``WorkFileService`` uses to decide whether to
/// *act*.
public struct WorkToolRegistry: Sendable {
    /// Tools that can look at a folder without changing anything in it. A run
    /// the person only asked a question of gets exactly this set.
    public static let readOnlyToolNames: Set<String> = [
        "list_folder", "read_file", "search_files", "file_details",
    ]

    private let tools: [String: any WorkTool]
    public let mode: WorkAccessMode

    public init(tools: [any WorkTool], mode: WorkAccessMode) {
        var byName: [String: any WorkTool] = [:]
        for tool in tools { byName[tool.name] = tool }
        self.tools = byName
        self.mode = mode
    }

    /// The standard local tool set over one grant.
    ///
    /// Note what is and is not here. Every change to the folder goes through
    /// ``ApplyChangesTool`` — one previewed, ordered, digest-bound batch — so
    /// there is a single door to audit rather than nine. ``PermanentlyDeleteTool``
    /// is the exception and has to be, because a permanent delete is not a
    /// ``WorkFileOperation`` and can never be one: putting it in a batch would
    /// make it approvable in the same gesture as forty harmless moves.
    public static func standard(
        access: any GrantAccessing,
        files: WorkFileService,
        batches: WorkBatchExecutor,
        undo: WorkUndoLedger
    ) -> WorkToolRegistry {
        WorkToolRegistry(
            tools: [
                ListFolderTool(files: files),
                ReadFileTool(files: files),
                SearchFilesTool(files: files),
                FileDetailsTool(files: files),
                ApplyChangesTool(files: files, batches: batches, undo: undo),
                PermanentlyDeleteTool(access: access, files: files),
            ],
            mode: access.mode
        )
    }

    public var allTools: [any WorkTool] {
        tools.values.sorted { $0.name < $1.name }
    }

    public func tool(named name: String) -> (any WorkTool)? {
        tools[name]
    }

    /// The same registry with everything that could change the folder removed.
    public func readOnly() -> WorkToolRegistry {
        WorkToolRegistry(
            tools: allTools.filter { Self.readOnlyToolNames.contains($0.name) },
            mode: mode
        )
    }

    /// The reason these arguments are unusable for this tool, or nil.
    public func validateInput(toolName: String, input: WorkToolValue) -> String? {
        guard let tool = tools[toolName] else {
            return "This Mac's version of Juno has no \"\(toolName)\" tool."
        }
        return tool.schema.validate(input)
    }

    /// The risk this exact call carries.
    ///
    /// Raised to `.irreversible` whenever the tool names an irreversible action,
    /// whatever it returned from ``WorkTool/assessRisk(input:)``. A tool cannot
    /// talk its way into a gentler tier: the two answers are asked for
    /// separately so that one of them can override the other, and this is the
    /// direction that override runs in.
    public func effectiveRisk(toolName: String, input: WorkToolValue) -> WorkRiskLevel? {
        guard let tool = tools[toolName] else { return nil }
        guard tool.irreversibleAction(input: input) == nil else { return .irreversible }
        return tool.assessRisk(input: input)
    }

    // MARK: - Gating

    /// Validates, prechecks and authorizes one call, suspending while a person
    /// is asked. Throws when the call is refused; on success the returned
    /// authority is what ``executeAuthorized(toolName:input:context:)`` must be
    /// given.
    public func authorize(
        toolName: String,
        input: WorkToolValue,
        runID: String,
        approvals: WorkApprovalCoordinator,
        at now: Date = Date()
    ) async throws -> WorkAuthorization {
        guard let tool = tools[toolName] else {
            throw WorkToolError.unknownTool(name: toolName)
        }
        if let problem = tool.schema.validate(input) {
            throw WorkToolError.invalidInput(message: problem)
        }
        if let refusal = tool.precheck(input: input) {
            throw refusal
        }
        guard tool.approvalBinding == .itsArguments else {
            // Nothing to hash yet — see `WorkApprovalBinding.aPlanTheToolBuilds`.
            // The tool is handed the gate and no authority at all, so one that
            // forgot to ask has nothing to execute with.
            return .deferredToTheTool
        }

        let risk = tool.irreversibleAction(input: input) == nil
            ? tool.assessRisk(input: input)
            : .irreversible
        let outcome = await approvals.authorize(
            action: toolName,
            runID: runID,
            actionDigest: tool.actionDigest(input: input),
            risk: risk,
            mode: mode,
            summary: tool.summary(input: input)
        )
        switch outcome {
        case .allowed:
            return .allowedByPolicy
        case .denied(let reason):
            throw WorkToolError.denied(reason: reason)
        case .approved(let receipt):
            // Recomputed from the arguments about to be executed rather than
            // reused from the request. The two are the same value today; they
            // stop being the same value the moment anything between the question
            // and the execution can touch the arguments, and this is the check
            // that notices.
            guard receipt.authorizes(digest: tool.actionDigest(input: input), at: now) else {
                throw WorkToolError.denied(
                    reason: "What Juno was about to do no longer matches what you approved, so it stopped."
                )
            }
            return .approved(receipt)
        }
    }

    /// Runs a call that has already been authorized.
    public func executeAuthorized(
        toolName: String,
        input: WorkToolValue,
        context: WorkToolContext
    ) async throws -> WorkToolResult {
        guard let tool = tools[toolName] else {
            throw WorkToolError.unknownTool(name: toolName)
        }
        try Task.checkCancellation()
        return try await tool.execute(input: input, context: context)
    }

    /// The whole gated call: validate, precheck, assess, ask, re-verify the
    /// digest, execute.
    public func invoke(
        toolName: String,
        input: WorkToolValue,
        runID: String,
        toolCallID: String,
        approvals: WorkApprovalCoordinator,
        emit: @escaping @Sendable (String) async -> Void = { _ in },
        at now: Date = Date()
    ) async throws -> WorkToolResult {
        let authorization = try await authorize(
            toolName: toolName,
            input: input,
            runID: runID,
            approvals: approvals,
            at: now
        )
        return try await executeAuthorized(
            toolName: toolName,
            input: input,
            context: WorkToolContext(
                runID: runID,
                toolCallID: toolCallID,
                authorization: authorization,
                approvals: approvals,
                emit: emit
            )
        )
    }
}
