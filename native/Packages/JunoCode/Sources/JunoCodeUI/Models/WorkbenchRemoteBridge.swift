import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeKit

/// The production conformance for `CodeRemoteSessionBridging`.
///
/// `RemoteCommandAdapter` decides what a remote command is *allowed* to do;
/// this is what actually does it, by calling the same `SessionController`
/// methods the Mac's own UI calls. That is the whole reason Remote is an
/// adapter rather than a second agent: there is no separate code path here that
/// could disagree with the local one about what a "send" or an "undo" means.
///
/// `@MainActor` because `SessionController` and `WorkbenchModel` are, and the
/// adapter calls in from the host's actor — so every hop is explicit rather
/// than accidental.
@MainActor
public final class WorkbenchRemoteBridge: CodeRemoteSessionBridging {
    private let model: WorkbenchModel
    /// Opaque workspace ids the user has shared with Remote, by id.
    ///
    /// A closure rather than a stored set so the answer is read at command
    /// time: un-sharing a workspace has to take effect on the next command,
    /// not on the next relaunch.
    private let sharedWorkspaceIDs: @MainActor () -> Set<String>
    /// The model a remotely-created session opens with.
    ///
    /// Supplied by the app rather than named in the command: model choice is a
    /// spend decision, and it belongs to the account holder at the machine
    /// rather than to whoever sent the command.
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

    // MARK: - Session lifecycle

    nonisolated public func createSession(
        workspaceID: String,
        title: String?,
        permissionMode: PermissionMode
    ) async throws -> String {
        let id = WorkspaceID(value: workspaceID)
        guard !workspaceID.isEmpty else {
            throw CodeRemoteCommandError.invalidField("workspaceId", reason: "not an identifier")
        }
        let configuration = AgentConfiguration(
            modelID: await MainActor.run { defaultModelID() },
            behavior: .code,
            // The adapter has already refused anything above ask-before-changes
            // for a remotely-created session; this is the value it settled on.
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

    nonisolated public func sendMessage(sessionID: String, text: String) async throws {
        let controller = try await require(sessionID)
        await MainActor.run { controller.composerText = text }
        await controller.send()
    }

    nonisolated public func stopAgent(sessionID: String) async throws {
        try await require(sessionID).stop()
    }

    nonisolated public func retryTurn(sessionID: String) async throws {
        // Retry is "send the last thing again", which is what the composer
        // already does — there is no second retry path to keep in step.
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
        await MainActor.run { controller.composerText = last }
        await controller.send()
    }

    nonisolated public func forkSession(sessionID: String) async throws -> String {
        // Not yet implemented on the local surface either. Refusing explicitly
        // is the honest answer: silently doing nothing would show the phone a
        // fork that never appears.
        throw CodeRemoteCommandError.unsupportedKind("fork")
    }

    // MARK: - Approvals

    nonisolated public func resolveApproval(
        sessionID: String, approvalID: String, approved: Bool
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
        sessionID: String, changeID: String, accept: Bool
    ) async throws {
        let controller = try await require(sessionID)
        if accept {
            await MainActor.run { controller.acceptChange(path: changeID) }
        } else {
            // Never force. A remote reject must not overwrite content that
            // diverged since the change was made — forcing is a separate,
            // explicit action and it is not reachable from a phone.
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
        // Deleting a tracked change is rejecting it without keeping the file.
        try await applyChange(sessionID: sessionID, changeID: changeID, accept: false)
    }

    // MARK: - Tests and Git

    nonisolated public func runTests(sessionID: String, command: String?) async throws {
        // Routed through the composer so it lands on the same tool call, and
        // therefore the same approval gate, as a locally typed request. A
        // direct call would bypass the pin that makes `run_tests` always ask.
        let controller = try await require(sessionID)
        let instruction = command.map { "Run the tests with: \($0)" } ?? "Run the project's tests."
        await MainActor.run { controller.composerText = instruction }
        await controller.send()
    }

    nonisolated public func stopTests(sessionID: String) async throws {
        try await require(sessionID).stop()
    }

    nonisolated public func performGitAction(
        sessionID: String, action: String, message: String?
    ) async throws {
        let controller = try await require(sessionID)
        switch action {
        case "commit":
            guard let message, !message.isEmpty else {
                throw CodeRemoteCommandError.missingField("message")
            }
            _ = await controller.commit(message: message)
        default:
            // Push, branch and the rest are not reachable from a phone yet.
            // Naming the refusal beats a no-op the phone reports as success.
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
