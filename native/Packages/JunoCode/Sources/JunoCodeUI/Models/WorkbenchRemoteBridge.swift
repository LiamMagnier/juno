import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime
import JunoCodeKit

/// Production bridge from Remote commands into the exact Workbench session the
/// Mac UI owns. Remote never creates a second local agent path: every operation
/// is delegated to `SessionController` or `WorkbenchModel`.
@MainActor
public final class WorkbenchRemoteBridge: CodeRemoteSessionConfigurationBridging {
    private let model: WorkbenchModel
    private let sharedWorkspaceIDs: @MainActor () -> Set<String>
    private let defaultModelID: @MainActor () -> String

    public init(
        model: WorkbenchModel,
        sharedWorkspaceIDs: @escaping @MainActor () -> Set<String>,
        defaultModelID: @escaping @MainActor () -> String
    ) {
        self.model = model
        self.sharedWorkspaceIDs = sharedWorkspaceIDs
        self.defaultModelID = defaultModelID
    }

    // MARK: - Authorisation inputs

    nonisolated public func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool {
        await MainActor.run { sharedWorkspaceIDs().contains(workspaceID) }
    }

    nonisolated public func permissionMode(forSession sessionID: String) async -> PermissionMode? {
        await controller(sessionID)?.session.configuration.permissionMode
    }

    /// Read-only transcript access for `RuntimeCodeHost`. The UI remains a
    /// source of presentation state, but the host owns cursor validation and
    /// replay behaviour.
    nonisolated public func protocolEvents(
        after cursor: CodeSessionEventCursor
    ) async -> [CodeSessionEventEnvelope] {
        guard let controller = await controller(cursor.sessionID.value) else { return [] }
        return await MainActor.run {
            controller.events
                .map(CodeSessionStoreProtocolAdapter.envelope)
                .filter { $0.sequence > cursor.afterSequence }
        }
    }

    /// Host-owned session inventory for thin clients such as the CLI. The
    /// workbench is only the legacy persistence adapter here; clients receive
    /// the canonical, bounded summary rather than reaching into SwiftUI state.
    nonisolated public func protocolSessions(
        defaultTargetID: ExecutionTargetID
    ) async -> [CodeSessionSummary] {
        let sessions = await MainActor.run { model.sessions }
        var summaries: [CodeSessionSummary] = []
        summaries.reserveCapacity(sessions.count)
        for session in sessions {
            let eventCount = await model.eventCount(for: session.id)
            summaries.append(
                CodeSessionSummary(
                    id: session.id,
                    targetID: session.configuration.executionTarget.isLegacy
                        ? defaultTargetID : session.configuration.executionTarget.id,
                    title: session.title,
                    status: session.status,
                    modelID: session.configuration.modelID,
                    reasoningEffort: session.configuration.reasoningEffort,
                    lastEventSequence: eventCount,
                    updatedAt: session.updatedAt
                )
            )
        }
        return summaries
    }

    // MARK: - Session lifecycle

    nonisolated public func createSession(
        workspaceID: String,
        title: String?,
        permissionMode: PermissionMode
    ) async throws -> String {
        try await createSession(workspaceID: workspaceID, title: title, permissionMode: permissionMode,
                                modelID: nil, reasoningEffort: nil)
    }

    nonisolated public func createSession(
        workspaceID: String, title: String?, permissionMode: PermissionMode,
        modelID: String?, reasoningEffort: ReasoningEffort?
    ) async throws -> String {
        let id = WorkspaceID(value: workspaceID)
        guard !workspaceID.isEmpty else {
            throw CodeRemoteCommandError.invalidField("workspaceId", reason: "not an identifier")
        }
        let selectedModel = try await MainActor.run {
            let fallback = defaultModelID()
            guard let modelID else { return fallback }
            guard model.availableModels.contains(where: { $0.modelID == modelID }) else {
                throw CodeRemoteCommandError.invalidField("modelId", reason: "model is unavailable on this host")
            }
            return modelID
        }
        let configuration = AgentConfiguration(
            modelID: selectedModel,
            reasoningEffort: reasoningEffort ?? .medium,
            behavior: .code,
            permissionMode: permissionMode,
            location: .local,
            computerUseEnabled: false
        )
        let session = await MainActor.run {
            Task { await model.createSession(workspaceID: id, configuration: configuration) }
        }
        guard let created = await session.value else {
            throw CodeRemoteCommandError.invalidField(
                "workspaceId", reason: "the workspace could not be opened"
            )
        }
        return created.id.value
    }

    /// A Remote message is a direction to this same session. If the agent is
    /// already executing, the controller performs the same interrupt-and-continue
    /// operation the Mac's active-run composer exposes rather than rejecting the
    /// phone with "stop first" or starting a concurrent executor.
    nonisolated public func sendMessage(sessionID: String, text: String) async throws {
        let controller = try await require(sessionID)
        let accepted = await controller.interruptAndSend(text)
        guard accepted else {
            throw CodeRemoteCommandError.invalidField(
                "text", reason: "the session could not accept this direction"
            )
        }
    }

    nonisolated public func stopAgent(sessionID: String) async throws {
        try await require(sessionID).stop()
    }

    nonisolated public func retryTurn(sessionID: String) async throws {
        let controller = try await require(sessionID)
        let last = await MainActor.run {
            controller.events.reversed().compactMap { event -> String? in
                if case let .userPrompt(prompt) = event.payload { return prompt.text }
                return nil
            }.first
        }
        guard let last, !last.isEmpty else {
            throw CodeRemoteCommandError.invalidField(
                "sessionId", reason: "there is no previous message to retry"
            )
        }
        let accepted = await controller.interruptAndSend(last)
        guard accepted else {
            throw CodeRemoteCommandError.invalidField(
                "sessionId", reason: "the previous turn could not be retried"
            )
        }
    }

    nonisolated public func forkSession(sessionID: String) async throws -> String {
        throw CodeRemoteCommandError.unsupportedKind("fork")
    }

    // MARK: - Approvals

    nonisolated public func resolveApproval(
        sessionID: String,
        approvalID: String,
        approved: Bool
    ) async throws {
        let controller = try await require(sessionID)
        if approved {
            await controller.approve(approvalID)
        } else {
            await controller.deny(approvalID)
        }
    }

    // MARK: - Changes

    nonisolated public func applyChange(
        sessionID: String,
        changeID: String,
        accept: Bool
    ) async throws {
        let controller = try await require(sessionID)
        if accept {
            await MainActor.run { controller.acceptChange(path: changeID) }
        } else {
            let result = await controller.rejectChange(path: changeID, force: false)
            if case let .failed(message) = result {
                throw CodeRemoteCommandError.invalidField("changeId", reason: message)
            }
        }
    }

    nonisolated public func undoChange(sessionID: String, checkpointID: String) async throws {
        let controller = try await require(sessionID)
        let result = await controller.restoreCheckpoint(checkpointID, force: false)
        if case let .failed(message) = result {
            throw CodeRemoteCommandError.invalidField("checkpointId", reason: message)
        }
    }

    nonisolated public func deleteChange(sessionID: String, changeID: String) async throws {
        try await applyChange(sessionID: sessionID, changeID: changeID, accept: false)
    }

    // MARK: - Tests and Git

    nonisolated public func runTests(sessionID: String, command: String?) async throws {
        let controller = try await require(sessionID)
        let instruction = command.map { "Run the tests with: \($0)" }
            ?? "Run the project's tests."
        let accepted = await controller.interruptAndSend(instruction)
        guard accepted else {
            throw CodeRemoteCommandError.invalidField(
                "sessionId", reason: "the test request could not be started"
            )
        }
    }

    nonisolated public func stopTests(sessionID: String) async throws {
        try await require(sessionID).stop()
    }

    nonisolated public func performGitAction(
        sessionID: String,
        action: String,
        message: String?
    ) async throws {
        let controller = try await require(sessionID)
        switch action {
        case "commit":
            guard let message, !message.isEmpty else {
                throw CodeRemoteCommandError.missingField("message")
            }
            _ = await controller.commit(message: message)
        default:
            throw CodeRemoteCommandError.invalidField(
                "action", reason: "\"\(action)\" is not available remotely"
            )
        }
    }

    // MARK: - Plumbing

    nonisolated private func controller(_ sessionID: String) async -> SessionController? {
        guard !sessionID.isEmpty else { return nil }
        return await model.controller(for: CodeSessionID(value: sessionID))
    }

    nonisolated private func require(_ sessionID: String) async throws -> SessionController {
        guard let controller = await controller(sessionID) else {
            throw CodeRemoteCommandError.invalidField(
                "sessionId", reason: "no such session on this Mac"
            )
        }
        return controller
    }
}
