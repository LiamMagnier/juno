import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

public struct ModelOption: Identifiable, Hashable, Sendable {
    public var id: String { modelID }
    public let modelID: String
    public let displayName: String

    public init(modelID: String, displayName: String) {
        self.modelID = modelID
        self.displayName = displayName
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

        public init(
            storageRootURL: URL,
            modelClient: any AgentModelClient,
            availableModels: [ModelOption]
        ) {
            self.storageRootURL = storageRootURL
            self.modelClient = modelClient
            self.availableModels = availableModels
        }

        /// Default storage under Application Support/JunoCode.
        public static func standard(
            modelClient: any AgentModelClient,
            availableModels: [ModelOption]
        ) -> Dependencies {
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0].appendingPathComponent("JunoCode", isDirectory: true)
            return Dependencies(
                storageRootURL: base,
                modelClient: modelClient,
                availableModels: availableModels
            )
        }
    }

    public private(set) var workspaces: [WorkspaceRecord] = []
    public private(set) var sessions: [CodeSession] = []
    public var selectedSessionID: CodeSessionID?
    public var sessionSearchText = ""
    public private(set) var lastError: String?

    public let dependencies: Dependencies
    public let sessionStore: CodeSessionStore
    private let workspaceDirectory: WorkspaceDirectory
    private var contexts: [WorkspaceID: WorkspaceContext] = [:]
    private var controllers: [CodeSessionID: SessionController] = [:]
    private var storeObserver: UUID?

    public init(dependencies: Dependencies) {
        self.dependencies = dependencies
        self.sessionStore = CodeSessionStore(
            directoryURL: dependencies.storageRootURL.appendingPathComponent("sessions-store")
        )
        self.workspaceDirectory = WorkspaceDirectory(
            directoryURL: dependencies.storageRootURL
        )
    }

    // MARK: - Bootstrap

    public func bootstrap() async {
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
            selectedSessionID = sessions.first?.id
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
                selectedSessionID = sessions.first?.id
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
                storageRoot: dependencies.storageRootURL
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
        do {
            let (record, access) = try await workspaceDirectory.open(id: workspaceID)
            let context = WorkspaceContext(
                record: record,
                access: access,
                storageRoot: dependencies.storageRootURL
            )
            contexts[workspaceID] = context
            workspaces = await workspaceDirectory.allWorkspaces()
            return context
        } catch {
            lastError = "Could not reopen the workspace: \(error)"
            return nil
        }
    }

    public func removeWorkspace(id: WorkspaceID) async {
        try? await workspaceDirectory.remove(id: id)
        contexts.removeValue(forKey: id)
        workspaces = await workspaceDirectory.allWorkspaces()
    }

    // MARK: - Sessions

    @discardableResult
    public func createSession(
        workspaceID: WorkspaceID,
        configuration: AgentConfiguration
    ) async -> CodeSession? {
        guard let context = await context(for: workspaceID) else { return nil }
        do {
            var branch: String?
            if context.record.descriptor.isGitRepository {
                branch = try? await context.git.status().branch
            }
            let session = try await sessionStore.createSession(
                workspaceID: workspaceID,
                workspaceName: context.record.descriptor.displayName,
                title: "New session",
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
        if let existing = controllers[sessionID] {
            return existing
        }
        guard let session = sessions.first(where: { $0.id == sessionID }),
              let context = await context(for: session.workspaceID)
        else { return nil }
        let controller = SessionController(
            session: session,
            context: context,
            store: sessionStore,
            modelClient: dependencies.modelClient
        )
        controllers[sessionID] = controller
        await controller.attach()
        return controller
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

    public func deleteSession(id: CodeSessionID) async {
        if let controller = controllers[id] {
            await controller.stop()
            await controller.detach()
        }
        try? await sessionStore.deleteSession(id: id)
    }

    // MARK: - Derived lists

    public var filteredSessions: [CodeSession] {
        let query = sessionSearchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return sessions }
        return sessions.filter { session in
            session.title.lowercased().contains(query)
                || workspaceName(for: session.workspaceID).lowercased().contains(query)
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

    public func workspaceName(for id: WorkspaceID) -> String {
        workspaces.first { $0.id == id }?.descriptor.displayName ?? "Workspace"
    }
}
