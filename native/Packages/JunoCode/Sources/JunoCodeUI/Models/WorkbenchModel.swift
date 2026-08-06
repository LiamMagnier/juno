import CryptoKit
import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

/// A model the workbench can run a turn on.
///
/// `catalog` is what the composer's selector reads: the provider mark, the
/// capabilities, the pricing tier and the spec sheet all come from there, and
/// they come from the account's manifest rather than from anything this package
/// knows. It stays optional because the runtime needs only `modelID`, and a
/// caller that has no catalog (a test, the bootstrap window before the manifest
/// arrives) should not have to fabricate one — the selector degrades to a name.
public struct ModelOption: Identifiable, Hashable, Sendable {
    public var id: String { modelID }
    public let modelID: String
    public let displayName: String
    public let catalog: JunoModelDescriptor?
    /// The thinking depths this model actually offers. See
    /// ``ModelOption/contractReasoningEfforts`` for why the default is the
    /// conservative low/medium/high band rather than every tier the enum has.
    public let supportedReasoningEfforts: [ReasoningEffort]

    public init(
        modelID: String,
        displayName: String,
        catalog: JunoModelDescriptor? = nil,
        supportedReasoningEfforts: [ReasoningEffort] = ModelOption.contractReasoningEfforts
    ) {
        self.modelID = modelID
        self.displayName = displayName
        self.catalog = catalog
        self.supportedReasoningEfforts = supportedReasoningEfforts
    }

    /// Builds an option straight from a catalog entry.
    ///
    /// The ladder is exactly the depths the entry publishes, intersected with what
    /// the Code request contract can carry — and **empty when the entry published
    /// none**.
    ///
    /// Empty is a real answer, not a gap to fill. It is what the manifest sends
    /// for a model that does not reason at all (`gpt-4o`, `qwen-long`,
    /// `codestral`), one that always reasons with no exposed control
    /// (`magistral`, Kimi K2.7), and one with a bare on/off switch. Substituting
    /// low/medium/high for those — which this used to do — did two visible kinds
    /// of damage: it drew a depth slider for a model that has no depths, and it
    /// put a thinking parameter on the wire for a model that rejects one. The
    /// repo's own provider oracle records the second as a hard 400
    /// ("reasoning_effort is not enabled for this model"), so the fabricated
    /// ladder failed every turn on those models rather than merely misreporting.
    public init(catalog: JunoModelDescriptor) {
        self.init(
            modelID: catalog.id,
            displayName: catalog.displayName,
            catalog: catalog,
            supportedReasoningEfforts: catalog.thinking.stops.compactMap {
                ReasoningEffort(rawValue: $0.id)
            }
        )
    }

    /// Identity is the model id — two options for the same model are the same
    /// choice however much catalog detail one of them happens to carry.
    public static func == (lhs: ModelOption, rhs: ModelOption) -> Bool {
        lhs.modelID == rhs.modelID
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(modelID)
    }
}

/// A model transport that has not been composed yet. It fails honestly so
/// the UI can surface the missing integration instead of pretending.
public struct UnconfiguredModelClient: AgentModelClient {
    public init() {}

    public func streamTurn(
        _ request: ModelTurnRequest
    ) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(
                throwing: AgentModelClientError.transport(
                    message: "No model transport is configured. Sign in to Juno to run the agent."
                )
            )
        }
    }
}

/// Root application state: workspaces, sessions, selection, and the
/// per-session controllers.
@MainActor
@Observable
public final class WorkbenchModel {
    public struct Dependencies: Sendable {
        public let storageRootURL: URL
        public let modelClient: any AgentModelClient
        public let availableModels: [ModelOption]
        public let remoteSessionProvider: (any RemoteSessionProviding)?
        public let webSearch: (any CodeWebSearching)?

        public init(
            storageRootURL: URL,
            modelClient: any AgentModelClient,
            availableModels: [ModelOption],
            remoteSessionProvider: (any RemoteSessionProviding)? = nil,
            webSearch: (any CodeWebSearching)? = nil
        ) {
            self.storageRootURL = storageRootURL
            self.modelClient = modelClient
            self.availableModels = availableModels
            self.remoteSessionProvider = remoteSessionProvider
            self.webSearch = webSearch
        }

        /// Default storage under a one-way account scope in
        /// Application Support/JunoCode/accounts.
        ///
        /// The account identifier never becomes a path component or local
        /// metadata. Besides avoiding unsafe characters, hashing prevents a
        /// second macOS user who can inspect the container from learning Juno
        /// account identifiers from folder names. Most importantly, switching
        /// accounts cannot reopen another account's transcripts, workspace
        /// bookmarks, checkpoints or goals.
        public static func standard(
            accountID: String,
            modelClient: any AgentModelClient,
            availableModels: [ModelOption],
            remoteSessionProvider: (any RemoteSessionProviding)? = nil,
            webSearch: (any CodeWebSearching)? = nil
        ) -> Dependencies {
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
                .appendingPathComponent("JunoCode", isDirectory: true)
                .appendingPathComponent("accounts", isDirectory: true)
                .appendingPathComponent(accountStorageKey(for: accountID), isDirectory: true)
            return Dependencies(
                storageRootURL: base,
                modelClient: modelClient,
                availableModels: availableModels,
                remoteSessionProvider: remoteSessionProvider,
                webSearch: webSearch
            )
        }

        static func accountStorageKey(for accountID: String) -> String {
            SHA256.hash(data: Data(accountID.utf8))
                .map { String(format: "%02x", $0) }
                .joined()
        }
    }

    public private(set) var workspaces: [WorkspaceRecord] = []
    public private(set) var sessions: [CodeSession] = []
    public var selectedSessionID: CodeSessionID?
    public var sessionSearchText = ""
    public private(set) var lastError: String?
    /// The workspace whose folder grant lapsed, if one has.
    ///
    /// macOS withdraws a sandboxed app's folder permission when the app's code
    /// identity changes or the folder moves, and nothing the app does repairs it
    /// — only the user re-picking the folder. Before this, that arrived as the
    /// string "bookmarkInvalid" under the project list and Juno Code became
    /// unusable with no route back: no session could start, so no composer ever
    /// appeared. Holding the id is what lets the UI offer "Choose Folder Again".
    public private(set) var workspaceNeedingAccess: WorkspaceID?

    /// Re-point an existing workspace at a folder the user has just re-granted.
    ///
    /// Keeps the same `WorkspaceID`, so every session, checkpoint and transcript
    /// already recorded against this project survives — re-adding it as a new
    /// workspace would strand all of them.
    public func restoreAccess(to workspaceID: WorkspaceID, grantedURL: URL) async -> Bool {
        do {
            let (record, access) = try await workspaceDirectory.regrant(
                id: workspaceID,
                grantedURL: grantedURL
            )
            contexts[workspaceID] = WorkspaceContext(
                record: record,
                access: access,
                storageRoot: dependencies.storageRootURL,
                webSearch: dependencies.webSearch
            )
            workspaces = await workspaceDirectory.allWorkspaces()
            workspaceNeedingAccess = nil
            lastError = nil
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Clears the re-grant prompt without re-granting — the reader may simply
    /// want the project gone.
    public func dismissAccessPrompt() {
        workspaceNeedingAccess = nil
    }
    /// The models offered in the new-session composer. Seeded from
    /// `dependencies.availableModels` and refreshable once the real manifest
    /// loads after sign-in.
    public private(set) var availableModels: [ModelOption]

    /// Canonical model id to human name, for the transcript's attribution line.
    ///
    /// A turn records the id it was routed with; showing that id is how a
    /// transcript ends up attributing an answer to "anthropic:claude-sonnet-5".
    /// The id is a routing key, not a name.
    public var modelDisplayNames: [String: String] {
        Dictionary(
            availableModels.map { ($0.modelID, $0.displayName) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    public let dependencies: Dependencies
    /// Authenticated Cloud/Remote execution, when the host composed it. The
    /// Desktop Code Studio and the unified JunoMac Code composer share this
    /// typed provider without fabricating local sessions for remote work.
    public private(set) var remoteExecutionModel: RemoteExecutionModel?
    public let sessionStore: CodeSessionStore
    private let workspaceDirectory: WorkspaceDirectory
    private var contexts: [WorkspaceID: WorkspaceContext] = [:]
    private var controllers: [CodeSessionID: SessionController] = [:]
    private var storeObserver: UUID?
    #if DEBUG
    /// True only for the local `--juno-code-ui-preview` harness, which seeds
    /// in-memory fixtures and must not read the on-disk session store.
    private var isPreview = false
    #endif

    public init(dependencies: Dependencies) {
        self.dependencies = dependencies
        self.availableModels = dependencies.availableModels
        self.remoteExecutionModel = dependencies.remoteSessionProvider.map {
            RemoteExecutionModel(provider: $0)
        }
        self.sessionStore = CodeSessionStore(
            directoryURL: dependencies.storageRootURL.appendingPathComponent("sessions-store")
        )
        self.workspaceDirectory = WorkspaceDirectory(
            directoryURL: dependencies.storageRootURL
        )
    }

    // MARK: - Cloud and Remote

    /// Resolves the repositories used by the Cloud target picker.
    ///
    /// Remote work is intentionally not represented as a local `CodeSession`:
    /// the server owns its task lifecycle and the authenticated Code task
    /// surface is the source of truth. These small forwarding methods keep that
    /// boundary out of the view while still letting the native JunoMac composer
    /// use the provider that the host already authenticated.
    public func loadRemoteRepositories() async -> Result<
        [RemoteRepositoryReference], RemoteSessionProviderError
    > {
        guard let remoteExecutionModel else {
            return .failure(.unavailable(.integrationNotComposed))
        }
        return await remoteExecutionModel.loadRepositories()
    }

    /// Resolves signed-in remote computers and their registered workspaces.
    public func loadRemoteDevices() async -> Result<
        [RemoteDeviceTarget], RemoteSessionProviderError
    > {
        guard let remoteExecutionModel else {
            return .failure(.unavailable(.integrationNotComposed))
        }
        return await remoteExecutionModel.loadDevices()
    }

    /// Starts a real Cloud or Remote task and returns its server-owned handle.
    ///
    /// A remote run is not inserted into the local session store. Treating it as
    /// local would make the transcript, permission state and workspace path lie
    /// about where the code is executing. The native task list remains the
    /// durable monitor for these runs.
    public func startRemoteSession(
        prompt: String,
        at location: CodeExecutionLocation
    ) async -> Result<RemoteSessionHandle, RemoteSessionProviderError> {
        guard let remoteExecutionModel else {
            return .failure(.unavailable(.integrationNotComposed))
        }
        guard location.isRemote else {
            return .failure(.unavailable(.localExecutionManagedByWorkbench))
        }
        if let handle = await remoteExecutionModel.start(prompt: prompt, at: location) {
            return .success(handle)
        }
        switch remoteExecutionModel.state {
        case .unavailable(_, let reason):
            return .failure(.unavailable(reason))
        case .failed(_, let error):
            return .failure(error)
        default:
            return .failure(.transport("The remote task did not return a task handle."))
        }
    }

    // MARK: - Bootstrap

    public func bootstrap() async {
        #if DEBUG
        // The preview harness seeds fixtures in memory; never read the store.
        if isPreview { return }
        #endif
        if storeObserver == nil {
            storeObserver = await sessionStore.addObserver { [weak self] update in
                Task { @MainActor [weak self] in
                    self?.applyStoreUpdate(update)
                }
            }
        }
        workspaces = await workspaceDirectory.allWorkspaces()
        sessions = await sessionStore.allSessions()
        if selectedSessionID == nil {
            selectedSessionID = visibleSessions.first?.id
        }
    }

    private func applyStoreUpdate(_ update: CodeSessionStore.StoreUpdate) {
        switch update {
        case let .sessionChanged(session):
            if let index = sessions.firstIndex(where: { $0.id == session.id }) {
                sessions[index] = session
            } else {
                sessions.insert(session, at: 0)
            }
            sessions.sort { $0.updatedAt > $1.updatedAt }
        case let .sessionRemoved(id):
            sessions.removeAll { $0.id == id }
            controllers.removeValue(forKey: id)
            if selectedSessionID == id {
                // Never a sub-agent: falling back onto a delegated session would
                // put the window on a transcript with no sidebar row to leave it
                // by.
                selectedSessionID = visibleSessions.first?.id
            }
        case .eventAppended:
            break
        }
    }

    // MARK: - Workspaces

    /// Registers a workspace from an open-panel grant.
    @discardableResult
    public func addWorkspace(grantedURL: URL) async -> WorkspaceRecord? {
        do {
            let (record, access) = try await workspaceDirectory.register(grantedURL: grantedURL)
            contexts[record.id] = WorkspaceContext(
                record: record,
                access: access,
                storageRoot: dependencies.storageRootURL,
                webSearch: dependencies.webSearch
            )
            workspaces = await workspaceDirectory.allWorkspaces()
            lastError = nil
            return record
        } catch {
            lastError = "Could not open the folder: \(error)"
            return nil
        }
    }

    public func context(for workspaceID: WorkspaceID) async -> WorkspaceContext? {
        if let existing = contexts[workspaceID] {
            return existing
        }
        #if DEBUG
        // Preview fixtures are never registered in the workspace directory and
        // carry no security-scoped bookmark, so there is nothing to reopen.
        // Returning nil keeps the runtime unreachable without surfacing a
        // reopen failure the user cannot act on.
        if isPreview { return nil }
        #endif
        do {
            let (record, access) = try await workspaceDirectory.open(id: workspaceID)
            let context = WorkspaceContext(
                record: record,
                access: access,
                storageRoot: dependencies.storageRootURL,
                webSearch: dependencies.webSearch
            )
            contexts[workspaceID] = context
            workspaces = await workspaceDirectory.allWorkspaces()
            return context
        } catch {
            // `"\(error)"` printed the enum case — readers saw the literal word
            // "bookmarkInvalid" under their project list. `localizedDescription`
            // reaches the `LocalizedError` conformance on `WorkspaceAccessError`,
            // which explains what a lapsed folder grant is.
            lastError = error.localizedDescription
            // A lapsed grant is not a failure the reader can only stare at: it is
            // fixed by picking the folder again. Recording *which* workspace
            // needs it is what lets the UI offer that instead of a dead end.
            if let access = error as? WorkspaceAccessError,
                access.isRecoverableByRegrantingAccess
            {
                workspaceNeedingAccess = workspaceID
            }
            return nil
        }
    }

    public func removeWorkspace(id: WorkspaceID) async {
        try? await workspaceDirectory.remove(id: id)
        contexts.removeValue(forKey: id)
        workspaces = await workspaceDirectory.allWorkspaces()
    }

    // MARK: - Sessions

    /// - Parameter workspaceID: nil starts a conversation with no project.
    ///
    /// The nil path deliberately skips `context(for:)` entirely rather than
    /// failing softly on it: there is no folder to reopen, no bookmark that
    /// could have lapsed, and no git repository to read a branch from. Asking
    /// for a context and tolerating nil would conflate "this session has no
    /// project" with "this session's project could not be opened", which is the
    /// error the sidebar footer offers a recovery for.
    @discardableResult
    public func createSession(
        workspaceID: WorkspaceID?,
        configuration: AgentConfiguration
    ) async -> CodeSession? {
        var context: WorkspaceContext?
        if let workspaceID {
            guard let opened = await self.context(for: workspaceID) else { return nil }
            context = opened
        }
        do {
            var branch: String?
            if let context, context.record.descriptor.isGitRepository {
                branch = try? await context.git.status().branch
            }
            let session = try await sessionStore.createSession(
                workspaceID: workspaceID,
                workspaceName: context?.record.descriptor.displayName,
                title: workspaceID == nil ? "New conversation" : "New session",
                configuration: configuration,
                gitBranch: branch
            )
            selectedSessionID = session.id
            return session
        } catch {
            lastError = "Could not create the session: \(error)"
            return nil
        }
    }

    /// The live controller for a session, created on first use.
    public func controller(for sessionID: CodeSessionID) async -> SessionController? {
        #if DEBUG
        // Preview sessions get a fixture controller with no runtime attached;
        // the live path below is never taken.
        if isPreview { return previewController(for: sessionID) }
        #endif
        if let existing = controllers[sessionID] {
            // Re-attach, because the window detaches a controller as soon as the
            // reader navigates away from it (`DesktopCodeWorkspace.resolveController`
            // calls `detach()` on the outgoing one, which is what stops that
            // session's screen capture). Handing the cached instance back without
            // this left it with no store observer, so returning to a session showed
            // a transcript frozen at the moment you left: no new events, no
            // streaming text, no status change, no approvals, and a Send button
            // whose enablement is derived from a status that could no longer
            // update. Every second visit to a session was dead.
            //
            // `attach()` guards on `storeObserver == nil`, so this is free when the
            // controller is already attached and a full re-read when it is not.
            await existing.attach()
            return existing
        }
        guard let session = sessions.first(where: { $0.id == sessionID }) else { return nil }
        // A projectless session has no context to resolve, and must not be
        // refused for failing to resolve one.
        var context: WorkspaceContext?
        if let workspaceID = session.workspaceID {
            guard let opened = await self.context(for: workspaceID) else { return nil }
            if let executionRootPath = session.executionRootPath {
                // An isolated child must never silently fall back to the parent
                // checkout if its worktree disappeared or its persisted path
                // was tampered with. The session is still addressable through
                // its transcript, but opening it as a live workspace requires
                // the exact contained checkout to exist.
                let root = URL(fileURLWithPath: executionRootPath, isDirectory: true)
                guard let isolated = try? opened.isolatedContext(at: root) else {
                    return nil
                }
                context = isolated
            } else {
                context = opened
            }
        }
        let controller = SessionController(
            session: session,
            context: context,
            store: sessionStore,
            modelClient: dependencies.modelClient,
            modelSupportsVision: { [weak self] modelID in
                self?.availableModels
                    .first(where: { $0.modelID == modelID })?
                    .catalog?
                    .capabilities
                    .contains(.vision) == true
            },
            modelTakesThinkingParameter: { [weak self] modelID in
                // Absent from the manifest is treated as "does not take one",
                // which is the safe direction: omitting a thinking field costs a
                // shallower answer, while sending one to a model that refuses it
                // fails the whole turn.
                self?.availableModels
                    .first(where: { $0.modelID == modelID })?
                    .takesThinkingParameter == true
            }
        )
        controllers[sessionID] = controller
        await controller.attach()
        await controller.reconcileModelCapabilities()
        return controller
    }

    /// Replaces the signed-in account's model manifest and immediately revokes
    /// capabilities that no longer exist. This is deliberately an async setter:
    /// a manifest downgrade must stop an active Computer Use grant before the
    /// caller can consider the update applied.
    public func setAvailableModels(_ models: [ModelOption]) async {
        availableModels = models
        let currentControllers = Array(controllers.values)
        for controller in currentControllers {
            await controller.reconcileModelCapabilities()
        }
    }

    /// Ends every account-bound activity before the signed-in workbench is
    /// discarded. Dropping the observable model alone is insufficient: its
    /// controller tasks, shell commands, approval continuations and shared
    /// Computer Use coordinator can all outlive the last view that referenced
    /// them.
    public func shutdown() async {
        let currentControllers = Array(controllers.values)
        controllers.removeAll()
        for controller in currentControllers {
            await controller.stop()
            await controller.detach()
        }
        if let storeObserver {
            await sessionStore.removeObserver(storeObserver)
            self.storeObserver = nil
        }
        contexts.removeAll()
        selectedSessionID = nil
    }

    public func renameSession(id: CodeSessionID, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = try? await sessionStore.updateSession(id: id) { session in
            session.title = trimmed
        }
    }

    public func toggleFavorite(id: CodeSessionID) async {
        _ = try? await sessionStore.updateSession(id: id) { session in
            session.isFavorite.toggle()
        }
    }

    /// Deletes a session and every sub-agent it delegated.
    ///
    /// The children have to go with it. They are hidden from every list, so
    /// deleting their parent is the only occasion the reader can reach them —
    /// leaving them behind would accumulate transcripts on disk that no surface
    /// can name, let alone remove.
    public func deleteSession(id: CodeSessionID) async {
        guard let session = sessions.first(where: { $0.id == id }) else {
            return
        }
        let children = await sessionStore.childSessions(of: id)
        do {
            for child in children + [session] {
                try await discard(child)
            }
            lastError = nil
        } catch {
            lastError = "Could not completely delete the session: \(error)"
        }
    }

    /// Stops one session, removes its checkpoints and erases its record.
    private func discard(_ session: CodeSession) async throws {
        let controller = controllers[session.id]
        if let controller {
            await controller.stop()
        }
        // A projectless session never took a checkpoint — checkpoints are
        // snapshots of a working tree — so there is nothing to remove.
        if let workspaceID = session.workspaceID {
            if let context = contexts[workspaceID] {
                try await context.checkpoints.removeCheckpoints(for: session.id)
            } else {
                try CheckpointStore.removePersistedCheckpoints(
                    for: session.id,
                    directoryURL: dependencies.storageRootURL
                        .appendingPathComponent("checkpoints")
                        .appendingPathComponent(workspaceID.value)
                )
            }
        }
        try await sessionStore.deleteSession(id: session.id)
        await controller?.detach()
        controllers.removeValue(forKey: session.id)
    }

    // MARK: - Derived lists

    /// The sessions a reader browses: conversations they started, never the
    /// sub-agents those conversations delegated.
    ///
    /// A sub-agent is a real session with a real transcript, and it stays in
    /// `sessions` for exactly that reason — the panel opens it, deletion reaches
    /// it, and hiding it at the source would strand it on disk. What it must not
    /// be is a *row*: a delegated investigation appearing in the sidebar, pinned
    /// to Active while it runs and dropped into its project group when it
    /// finishes, is the "it just opened another chat" the whole delegation
    /// surface exists to avoid.
    ///
    /// Filtered on `parentSessionID`, never on the title. A title is
    /// presentation — the reader can rename a session, and a list whose contents
    /// depend on a string prefix is one rename away from wrong.
    public var visibleSessions: [CodeSession] {
        sessions.filter { !$0.isSubagent }
    }

    public var filteredSessions: [CodeSession] {
        let sessions = visibleSessions
        let query = sessionSearchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return sessions }
        return sessions.filter { session in
            session.title.lowercased().contains(query)
                || workspaceName(for: session.workspaceID).lowercased().contains(query)
                // "no project" is a thing a reader will type looking for these.
                || (session.workspaceID == nil && "no project".contains(query))
        }
    }

    public var favoriteSessions: [CodeSession] {
        filteredSessions.filter(\.isFavorite)
    }

    /// Non-favorite sessions grouped by recency for the sidebar.
    public var groupedSessions: [(title: String, sessions: [CodeSession])] {
        let calendar = Calendar.current
        let now = Date()
        var today: [CodeSession] = []
        var yesterday: [CodeSession] = []
        var thisWeek: [CodeSession] = []
        var earlier: [CodeSession] = []
        for session in filteredSessions where !session.isFavorite {
            if calendar.isDateInToday(session.updatedAt) {
                today.append(session)
            } else if calendar.isDateInYesterday(session.updatedAt) {
                yesterday.append(session)
            } else if let days = calendar.dateComponents(
                [.day],
                from: session.updatedAt,
                to: now
            ).day, days < 7 {
                thisWeek.append(session)
            } else {
                earlier.append(session)
            }
        }
        var groups: [(String, [CodeSession])] = []
        if !today.isEmpty { groups.append((String(localized: "Today"), today)) }
        if !yesterday.isEmpty { groups.append((String(localized: "Yesterday"), yesterday)) }
        if !thisWeek.isEmpty { groups.append((String(localized: "This week"), thisWeek)) }
        if !earlier.isEmpty { groups.append((String(localized: "Earlier"), earlier)) }
        return groups
    }

    /// The display name of a session's project — or what to call it when it
    /// has none. "No project" is stated, never blank: a caption that silently
    /// omits the project reads as a rendering bug, not as a fact.
    public func workspaceName(for id: WorkspaceID?) -> String {
        guard let id else { return "No project" }
        return workspaces.first { $0.id == id }?.descriptor.displayName ?? "Workspace"
    }

    #if DEBUG
    // MARK: - DEBUG preview harness

    /// Builds a workbench seeded with local, synthetic fixtures for visual QA
    /// (`--juno-code-ui-preview`).
    ///
    /// Inertness is structural, not conditional. Storage points at a throwaway
    /// temp directory, no workspace is ever registered, and every session's
    /// controller is built through `SessionController.init(previewFixture:)`,
    /// which has no `WorkspaceContext` at all — so there is no
    /// `CommandExecutionService`, `GitService`, `CheckpointStore` or model
    /// transport anywhere in the graph to reach. No production security check
    /// is relaxed to achieve this.
    ///
    /// `scenario` only chooses the initially selected session; every scenario
    /// is present in the sidebar and reachable by clicking.
    public static func preview(
        scenario: CodePreviewScenario = .transcript
    ) -> WorkbenchModel {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-code-preview-\(UUID().uuidString)", isDirectory: true)
        let model = WorkbenchModel(
            dependencies: Dependencies(
                storageRootURL: scratch,
                modelClient: UnconfiguredModelClient(),
                availableModels: [
                    ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5"),
                    ModelOption(modelID: "claude-opus-4-8", displayName: "Claude Opus 4.8"),
                ]
            )
        )
        model.isPreview = true
        model.workspaces = CodePreviewData.workspaces
        model.sessions = CodePreviewData.sessions
        model.selectedSessionID = scenario.sessionID
        return model
    }

    /// Builds this session's preview controller from its fixture, cached so
    /// selection changes do not discard local edits made during QA.
    private func previewController(for sessionID: CodeSessionID) -> SessionController? {
        if let existing = controllers[sessionID] { return existing }
        guard let scenario = CodePreviewScenario.allCases.first(
            where: { $0.sessionID == sessionID }
        ) else { return nil }
        let controller = SessionController(
            previewFixture: CodePreviewData.fixture(for: scenario)
        )
        controllers[sessionID] = controller
        return controller
    }
    #endif
}
