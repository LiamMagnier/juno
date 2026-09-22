import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime
import JunoCodeKit

/// The production conformance for `CodeRemoteSessionBridging`, and the source
/// of everything this Mac uploads for Remote.
///
/// `RemoteCommandAdapter` decides what a remote command is *allowed* to do;
/// this is what actually does it, by calling the same `SessionController`
/// methods the Mac's own UI calls. That is the whole reason Remote is an
/// adapter rather than a second agent: there is no separate code path here that
/// could disagree with the local one about what a "send" or an "undo" means.
///
/// It is also the answer to "what does the phone see". A phone is shown the
/// sessions in the workspaces this Mac shares with Remote, recent or still
/// working, and each one's transcript as `CodeRelayEventProjection` renders it
/// — the smallest set that lets someone away from the desk follow, answer and
/// continue what the Mac is doing. Nothing outside a shared workspace, no
/// sub-agent's own transcript, and no file contents leave through here.
///
/// `@MainActor` because `SessionController` and `WorkbenchModel` are, and the
/// adapter calls in from the host's actor — so every hop is explicit rather
/// than accidental.
@MainActor
public final class WorkbenchRemoteBridge:
    CodeRemoteSessionConfigurationBridging,
    CodeRemoteSessionSteeringBridging,
    CodeRemoteSessionAdoptingBridging,
    CodeRemoteCeilingProviding,
    CodeRemoteSessionUpdating,
    CodeRemoteSyncSource
{
    /// At most this many sessions are listed on the phone.
    public nonisolated static let remoteVisibleLimit = 20
    /// A session idle for longer than this drops off the phone's list; one that
    /// is working or waiting never does.
    public nonisolated static let remoteVisibleWindow: TimeInterval = 7 * 24 * 60 * 60

    private let model: WorkbenchModel
    /// Opaque workspace ids the user has shared with Remote, by id.
    ///
    /// A closure rather than a stored set so the answer is read at command
    /// time: un-sharing a workspace has to take effect on the next command,
    /// not on the next relaunch.
    private let sharedWorkspaceIDs: @MainActor () -> Set<String>
    /// The model a remotely-created session opens with when it names none.
    private let defaultModelID: @MainActor () -> String
    /// The reader's remote ceiling for the project at a path — Settings'
    /// "Sessions started from another device". Injected so the rules can be
    /// tested without writing settings files.
    private let ceiling: @Sendable (String?) -> PermissionMode
    private let now: @Sendable () -> Date

    /// Recent transcript events not yet uploaded, fed by the store as they are
    /// appended, so a working session is not re-read from disk for every batch.
    private var journal = CodeRelayJournalTail()
    /// Each uploader's own subscription to the store, by the token it was
    /// given. Keyed rather than single so switching Remote off and on quickly
    /// cannot let the old uploader's stop remove the new one's observer.
    private var relayObservers: [UUID: RelayObserver] = [:]

    private struct RelayObserver {
        let storeToken: UUID
        let updates: Task<Void, Never>
        let stream: AsyncStream<CodeSessionStore.StoreUpdate>.Continuation
    }

    /// One uploader's store observation, as `startRelayObservation` hands it
    /// back: the only way to end it.
    public struct RelayObservation: Hashable, Sendable {
        fileprivate let id: UUID
    }

    public init(
        model: WorkbenchModel,
        sharedWorkspaceIDs: @escaping @MainActor () -> Set<String>,
        defaultModelID: @escaping @MainActor () -> String,
        ceiling: @escaping @Sendable (String?) -> PermissionMode = {
            CodeSettingsModel.remoteCeiling(forProjectAt: $0)
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.model = model
        self.sharedWorkspaceIDs = sharedWorkspaceIDs
        self.defaultModelID = defaultModelID
        self.ceiling = ceiling
        self.now = now
    }

    // MARK: - Authorisation inputs

    nonisolated public func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool {
        await model.loadIfNeeded()
        return await MainActor.run { sharedWorkspaceIDs().contains(workspaceID) }
    }

    /// The mode the session's turns actually run under: Ask and Plan are
    /// read-only whatever mode is stored beside them.
    ///
    /// Loads the model first. The adapter asks this before anything else, and
    /// a session it could not see yet would skip the ceiling check and then be
    /// found, loaded, by the call that acts on it.
    nonisolated public func permissionMode(forSession sessionID: String) async -> PermissionMode? {
        await model.loadIfNeeded()
        return await MainActor.run {
            guard let session = session(sessionID) else { return nil }
            let configuration = session.configuration
            return configuration.behavior == .code ? configuration.permissionMode : .readOnly
        }
    }

    nonisolated public func remoteCeiling(forSession sessionID: String) async -> PermissionMode? {
        await model.loadIfNeeded()
        let lookup: (found: Bool, path: String?) = await MainActor.run {
            guard let session = session(sessionID) else { return (false, nil) }
            return (true, workspacePath(session.workspaceID))
        }
        guard lookup.found else { return nil }
        return ceiling(lookup.path)
    }

    nonisolated public func remoteCeiling(forWorkspace workspaceID: String) async -> PermissionMode {
        await model.loadIfNeeded()
        let path = await MainActor.run { workspacePath(WorkspaceID(value: workspaceID)) }
        return ceiling(path)
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
        await model.loadIfNeeded()
        let sessions = await MainActor.run { model.sessions }
        var summaries: [CodeSessionSummary] = []
        summaries.reserveCapacity(sessions.count)
        for session in sessions {
            let lastSequence = await model.lastEventSequence(for: session.id)
            summaries.append(
                CodeSessionSummary(
                    id: session.id,
                    targetID: session.configuration.executionTarget.isLegacy
                        ? defaultTargetID : session.configuration.executionTarget.id,
                    title: session.title,
                    status: session.status,
                    modelID: session.configuration.modelID,
                    reasoningEffort: session.configuration.reasoningEffort,
                    lastEventSequence: lastSequence,
                    updatedAt: session.updatedAt
                )
            )
        }
        return summaries
    }

    // MARK: - What the phone sees

    /// The sessions Remote may list: top-level sessions in a shared workspace,
    /// working or waiting first, then the most recently active, within the
    /// window and the limit.
    ///
    /// A pure function of its inputs so the scope can be pinned by a test —
    /// widening it is a change to what leaves this Mac.
    public nonisolated static func remoteVisible(
        _ sessions: [CodeSession],
        shared: Set<String>,
        now: Date,
        limit: Int = remoteVisibleLimit,
        window: TimeInterval = remoteVisibleWindow
    ) -> [CodeSession] {
        let cutoff = now.addingTimeInterval(-window)
        let isLive: (CodeSession) -> Bool = { $0.status.isActive || $0.hasPendingApproval }
        let eligible = sessions.filter { session in
            guard !session.isSubagent, let workspace = session.workspaceID,
                shared.contains(workspace.value)
            else { return false }
            return isLive(session) || session.updatedAt >= cutoff
        }
        let ordered = eligible.sorted { lhs, rhs in
            if isLive(lhs) != isLive(rhs) { return isLive(lhs) }
            return lhs.updatedAt == rhs.updatedAt
                ? lhs.id.value < rhs.id.value
                : lhs.updatedAt > rhs.updatedAt
        }
        return Array(ordered.prefix(limit))
    }

    /// One listed session, as metadata.
    public nonisolated static func upload(
        _ session: CodeSession, workspaceName: String?
    ) -> CodeRemoteSessionUpload {
        let configuration = session.configuration
        let mode = configuration.behavior == .code ? configuration.permissionMode : .readOnly
        return CodeRemoteSessionUpload(
            sessionID: session.id.value,
            workspaceKey: session.workspaceID?.value,
            workspaceName: workspaceName,
            title: session.title,
            modelID: configuration.modelID,
            reasoningEffort: configuration.reasoningEffort?.rawValue,
            permissionMode: mode.relayName,
            // A phone mints `remote-` ids for the sessions it starts, and this
            // Mac opens them under exactly that id.
            origin: session.id.value.hasPrefix("remote-") ? .remote : .local,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            status: session.hasPendingApproval
                ? "awaiting_approval"
                : CodeRelayEventProjection.relayStatus(session.status),
            activeBranch: session.gitBranch,
            lastError: session.lastErrorSummary
        )
    }

    /// Nil while the model has not been read, never an empty list: the
    /// uploader treats a session missing from an answer as gone from this Mac.
    nonisolated public func remoteVisibleSessions() async -> [CodeRemoteSyncedSession]? {
        await model.loadIfNeeded()
        let listed = await MainActor.run { () -> [(CodeSession, String?)]? in
            guard model.hasLoaded else { return nil }
            return Self.remoteVisible(model.sessions, shared: sharedWorkspaceIDs(), now: now())
                .map { ($0, workspaceDisplayName($0.workspaceID)) }
        }
        guard let listed else { return nil }
        var result: [CodeRemoteSyncedSession] = []
        result.reserveCapacity(listed.count)
        for (session, name) in listed {
            // The next sequence rather than the line count, which a rewind
            // makes smaller than the numbers already uploaded: counted against
            // the lines, a rewound session's cursor would sit past its end and
            // nothing after the rewind would ever reach the phone.
            let count = await model.sessionStore.nextSequence(for: session.id)
            result.append(
                CodeRemoteSyncedSession(
                    summary: Self.upload(session, workspaceName: name), eventCount: count
                )
            )
        }
        return result
    }

    nonisolated public func relayEvents(
        sessionID: String, after afterSequence: Int, limit: Int
    ) async -> [CodeRemoteSessionEvent] {
        let id = CodeSessionID(value: sessionID)
        // The uploader only asks about listed sessions, but this is the
        // boundary, so it checks rather than trusts.
        await model.loadIfNeeded()
        let visible = await MainActor.run {
            Self.remoteVisible(model.sessions, shared: sharedWorkspaceIDs(), now: now())
                .contains { $0.id == id }
        }
        guard visible else { return [] }
        // Local sequences below this exist or are heartbeats: a line that no
        // longer decodes, or a stretch a rewind cut, which the restart that
        // follows tells the phone to drop.
        let total = await model.sessionStore.nextSequence(for: id)
        guard afterSequence < total else { return [] }
        if let held = await MainActor.run(body: {
            journal.events(for: id, from: afterSequence, limit: limit, total: total)
        }) {
            return CodeRelayEventProjection.relayEvents(
                held, after: afterSequence, limit: limit, total: total
            )
        }
        let events = await model.sessionStore.events(for: id)
        await MainActor.run { journal.load(events, for: id, from: afterSequence) }
        return CodeRelayEventProjection.relayEvents(
            events, after: afterSequence, limit: limit, total: total
        )
    }

    /// Follows the session store for one uploader, feeding the journal tail
    /// and telling that uploader something changed, until the returned
    /// observation is stopped.
    ///
    /// Updates travel through one ordered stream rather than a task per event,
    /// so the tail sees appends in the order the store made them. Every call
    /// gets its own observer: a second uploader never finds the first one's
    /// and goes without, and stopping one never ends another's. Two feeding
    /// the tail at once is harmless, because it only takes the event that
    /// continues what it holds.
    public func startRelayObservation(
        onChange: @escaping @Sendable () async -> Void
    ) async -> RelayObservation {
        let observation = RelayObservation(id: UUID())
        let (stream, continuation) = AsyncStream<CodeSessionStore.StoreUpdate>.makeStream(
            bufferingPolicy: .bufferingNewest(4_096)
        )
        let storeToken = await model.sessionStore.addObserver { update in
            continuation.yield(update)
        }
        let updates = Task { @MainActor [weak self] in
            for await update in stream {
                guard let self else { return }
                switch update {
                case .eventAppended(let event): self.journal.append(event)
                case .sessionRemoved(let id): self.journal.forget(id)
                case .sessionChanged: break
                }
                await onChange()
            }
        }
        relayObservers[observation.id] = RelayObserver(
            storeToken: storeToken, updates: updates, stream: continuation
        )
        return observation
    }

    /// Ends one observation. Stopping one that already ended does nothing.
    public func stopRelayObservation(_ observation: RelayObservation) async {
        guard let observer = relayObservers.removeValue(forKey: observation.id) else { return }
        observer.updates.cancel()
        observer.stream.finish()
        await model.sessionStore.removeObserver(observer.storeToken)
        // The tail is only a cache for whoever is uploading; with nobody
        // left it would only grow stale.
        if relayObservers.isEmpty { journal = CodeRelayJournalTail() }
    }

    /// How many uploaders are following the store. For tests.
    var relayObservationCount: Int { relayObservers.count }

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
        try await createSession(
            CodeRemoteSessionRequest(
                requestedID: nil, workspaceID: workspaceID, title: title,
                permissionMode: permissionMode, modelID: modelID, reasoningEffort: reasoningEffort
            )
        ).id
    }

    nonisolated public func createSession(
        _ request: CodeRemoteSessionRequest
    ) async throws -> CodeRemoteCreatedSession {
        guard !request.workspaceID.isEmpty else {
            throw CodeRemoteCommandError.invalidField("workspaceId", reason: "not an identifier")
        }
        // A redelivered command finds the session it already opened. Its
        // first prompt went out with it, so it is not sent again.
        await model.loadIfNeeded()
        if let requested = request.requestedID,
            await MainActor.run(body: { session(requested) != nil })
        {
            return CodeRemoteCreatedSession(id: requested, isNew: false)
        }
        let selectedModel = try await MainActor.run {
            let fallback = defaultModelID()
            guard let modelID = request.modelID else { return fallback }
            guard model.availableModels.contains(where: { $0.modelID == modelID }) else {
                throw CodeRemoteCommandError.invalidField("modelId", reason: "model is unavailable on this host")
            }
            return modelID
        }
        let configuration = AgentConfiguration(
            modelID: selectedModel,
            reasoningEffort: request.reasoningEffort ?? .medium,
            behavior: .code,
            // The adapter has already capped this at ask-before-changes and at
            // the reader's remote ceiling; this is the value it settled on.
            permissionMode: request.permissionMode,
            location: .local,
            computerUseEnabled: false
        )
        let created = await model.createSession(
            workspaceID: WorkspaceID(value: request.workspaceID),
            configuration: configuration,
            sessionID: request.requestedID.map { CodeSessionID(value: $0) },
            select: false
        )
        guard let created else {
            throw CodeRemoteCommandError.invalidField(
                "workspaceId", reason: "the workspace could not be opened"
            )
        }
        if let title = request.title {
            await model.renameSession(id: created.id, title: title)
        }
        return CodeRemoteCreatedSession(id: created.id.value, isNew: true)
    }

    nonisolated public func sendMessage(sessionID: String, text: String) async throws {
        try await require(sessionID).deliverRemotePrompt(text)
    }

    nonisolated public func steerMessage(sessionID: String, text: String) async throws {
        try await require(sessionID).deliverRemotePrompt(text, as: .steer)
    }

    nonisolated public func queueMessage(sessionID: String, text: String) async throws {
        try await require(sessionID).deliverRemotePrompt(text, as: .queue)
    }

    nonisolated public func stopAgent(sessionID: String) async throws {
        try await require(sessionID).stop()
    }

    nonisolated public func retryTurn(sessionID: String) async throws {
        // Retry is "send the last thing again" through the same delivery a
        // new prompt takes — there is no second retry path to keep in step.
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
        try await controller.deliverRemotePrompt(last)
    }

    nonisolated public func forkSession(sessionID: String) async throws -> String {
        // Not yet implemented on the local surface either. Refusing explicitly
        // is the honest answer: silently doing nothing would show the phone a
        // fork that never appears.
        throw CodeRemoteCommandError.unsupportedKind("fork")
    }

    nonisolated public func updateSession(
        sessionID: String, update: CodeRemoteSessionUpdate
    ) async throws {
        let controller = try await require(sessionID)
        if let modelID = update.modelID {
            let available = await MainActor.run {
                model.availableModels.contains { $0.modelID == modelID }
            }
            guard available else {
                throw CodeRemoteCommandError.invalidField("modelID", reason: "model is unavailable on this host")
            }
        }
        if let mode = update.permissionMode {
            let isCode = await MainActor.run { controller.session.configuration.behavior == .code }
            guard isCode else {
                throw CodeRemoteCommandError.notAvailableRemotely(
                    "Ask and Plan sessions are read-only by design; their mode does not change."
                )
            }
            await controller.setPermissionMode(mode)
        }
        if let modelID = update.modelID { await controller.setModelID(modelID) }
        if let effort = update.reasoningEffort { await controller.setReasoningEffort(effort) }
        let id = CodeSessionID(value: sessionID)
        if let title = update.title { await model.renameSession(id: id, title: title) }
        if let pinned = update.pinned {
            let isFavorite = await MainActor.run { session(sessionID)?.isFavorite ?? pinned }
            if isFavorite != pinned { await model.toggleFavorite(id: id) }
        }
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
        let tracked = await MainActor.run { controller.changes.contains { $0.path == changeID } }
        guard tracked else {
            throw CodeRemoteCommandError.invalidField(
                "changeId", reason: "this session has no change to that file"
            )
        }
        if accept {
            await MainActor.run { controller.acceptChange(path: changeID) }
            return
        }
        // Never force. A remote reject must not overwrite content that
        // diverged since the change was made — forcing is a separate,
        // explicit action and it is not reachable from a phone.
        let result = await controller.rejectChange(path: changeID, force: false)
        if let message = result.failureMessage {
            throw CodeRemoteCommandError.invalidField("changeId", reason: message)
        }
    }

    nonisolated public func undoChange(sessionID: String, checkpointID: String) async throws {
        let controller = try await require(sessionID)
        let result = await controller.restoreCheckpoint(checkpointID, force: false)
        if let message = result.failureMessage {
            throw CodeRemoteCommandError.invalidField("checkpointId", reason: message)
        }
    }

    nonisolated public func deleteChange(sessionID: String, changeID: String) async throws {
        // Deleting a tracked change is rejecting it without keeping the file.
        try await applyChange(sessionID: sessionID, changeID: changeID, accept: false)
    }

    // MARK: - Tests and Git

    nonisolated public func runTests(sessionID: String, command: String?) async throws {
        // Delivered as a prompt so it lands on the same tool call, and
        // therefore the same approval gate, as a locally typed request. A
        // direct call would bypass the pin that makes `run_tests` always ask.
        let instruction = command.map { "Run the tests with: \($0)" } ?? "Run the project's tests."
        try await require(sessionID).deliverRemotePrompt(instruction)
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
            // The phone is told what happened, not that a commit was asked
            // for: a refused or failed commit used to acknowledge as done.
            guard await controller.commit(message: message) else {
                let reason = await MainActor.run { controller.transientError }
                throw CodeRemoteCommandError.invalidField(
                    "action", reason: reason ?? "the commit did not complete"
                )
            }
        default:
            // Push, branch and the rest are not reachable from a phone yet.
            // Naming the refusal beats a no-op the phone reports as success.
            throw CodeRemoteCommandError.invalidField(
                "action", reason: "\"\(action)\" is not available remotely"
            )
        }
    }

    // MARK: - Plumbing

    private func session(_ sessionID: String) -> CodeSession? {
        model.sessions.first { $0.id.value == sessionID }
    }

    private func workspacePath(_ workspaceID: WorkspaceID?) -> String? {
        guard let workspaceID else { return nil }
        let path = model.workspaces.first { $0.id == workspaceID }?.descriptor.localPathHint
        return path?.isEmpty == false ? path : nil
    }

    private func workspaceDisplayName(_ workspaceID: WorkspaceID?) -> String? {
        guard let workspaceID else { return nil }
        return model.workspaces.first { $0.id == workspaceID }?.descriptor.displayName
    }

    nonisolated private func controller(_ sessionID: String) async -> SessionController? {
        guard !sessionID.isEmpty else { return nil }
        await model.loadIfNeeded()
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
