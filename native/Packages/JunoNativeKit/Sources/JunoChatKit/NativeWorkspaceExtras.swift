import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// Scheduled Tasks and Connections — the two web destinations the phone was
/// still missing.
///
/// Both reach the *same* routes the website uses (`/api/tasks`,
/// `/api/connectors`) rather than a parallel native contract. Those routes
/// authenticate through `getCurrentUser`, which treats a presented bearer as
/// authoritative, so no backend change was needed to serve the phone — the same
/// thing that made Code Remote reachable.

// MARK: - Tasks

/// One scheduled task, decoded from `serializeTask` in `lib/scheduled-tasks.ts`.
public struct NativeScheduledTask: Identifiable, Equatable, Sendable {
    public enum Cadence: String, Sendable, CaseIterable {
        case daily = "DAILY"
        case weekdays = "WEEKDAYS"
        case weekly = "WEEKLY"
        case monthly = "MONTHLY"
    }

    /// The most recent run, which is what tells you whether the schedule is
    /// actually working or quietly failing every night.
    public struct Run: Equatable, Sendable {
        public let status: String
        public let error: String?
        public let startedAt: Date
        public let finishedAt: Date?

        public var failed: Bool { status.lowercased() == "failed" || error != nil }
    }

    public let id: String
    public let name: String
    public let prompt: String
    /// The human-readable model name the server resolved; never a raw ID.
    public let modelName: String
    public let cadence: Cadence
    public let hour: Int
    public let minute: Int
    public let weekday: Int?
    public let monthday: Int?
    public let timezone: String
    public let webSearch: Bool
    public let enabled: Bool
    public let nextRunAt: Date
    public let lastRunAt: Date?
    public let conversationID: String?
    public let latestRun: Run?
}

/// Reads and updates scheduled tasks through the website's own routes.
public struct NativeTasksClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func tasks(for accountID: AccountID) async throws -> [NativeScheduledTask] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceExtrasError.requestFailed(response.statusCode)
        }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value,
            case .array(let items)? = root["tasks"]
        else { throw NativeWorkspaceExtrasError.malformedResponse }
        return items.compactMap(Self.decodeTask)
    }

    /// Pause or resume. `PATCH /api/tasks/{id}` is the same call the web's own
    /// toggle makes.
    public func setEnabled(
        _ enabled: Bool, taskID: String, for accountID: AccountID
    ) async throws {
        let body = JunoJSONValue.object(["enabled": .bool(enabled)])
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks/\(taskID)",
                method: .patch,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceExtrasError.requestFailed(response.statusCode)
        }
    }

    static func decodeTask(_ value: JunoJSONValue) -> NativeScheduledTask? {
        guard case .object(let o) = value,
            case .string(let id)? = o["id"],
            case .string(let name)? = o["name"],
            case .string(let cadenceRaw)? = o["cadence"],
            let cadence = NativeScheduledTask.Cadence(rawValue: cadenceRaw),
            let nextRunAt = o["nextRunAt"]?.date
        else { return nil }

        var run: NativeScheduledTask.Run?
        if case .object(let r)? = o["latestRun"],
            case .string(let status)? = r["status"],
            let startedAt = r["startedAt"]?.date {
            run = .init(
                status: status,
                error: r["error"]?.stringValue,
                startedAt: startedAt,
                finishedAt: r["finishedAt"]?.date
            )
        }

        return NativeScheduledTask(
            id: id,
            name: name,
            prompt: o["prompt"]?.stringValue ?? "",
            // Falls back to the raw id only if the server sent no resolved name;
            // showing a raw model id in the UI is what this avoids.
            modelName: o["modelName"]?.stringValue ?? o["model"]?.stringValue ?? "",
            cadence: cadence,
            hour: Int(o["hour"]?.numberValue ?? 0),
            minute: Int(o["minute"]?.numberValue ?? 0),
            weekday: o["weekday"]?.numberValue.map(Int.init),
            monthday: o["monthday"]?.numberValue.map(Int.init),
            timezone: o["timezone"]?.stringValue ?? TimeZone.current.identifier,
            webSearch: o["webSearch"]?.boolValue ?? false,
            enabled: o["enabled"]?.boolValue ?? true,
            nextRunAt: nextRunAt,
            lastRunAt: o["lastRunAt"]?.date,
            conversationID: o["conversationId"]?.stringValue,
            latestRun: run
        )
    }
}

// MARK: - Connections

/// One integration, decoded from `/api/connectors`.
///
/// `configured` and `connected` are different states and the UI must not merge
/// them: an unconfigured connector cannot be linked by anyone on this
/// deployment, while a configured-but-unlinked one is simply waiting for you.
public struct NativeConnector: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let capability: String
    public let configured: Bool
    public let connected: Bool
    public let accountLabel: String?
    public let connectedAt: Date?
}

/// One entry from the Composio directory — the browsable catalog, not just the
/// apps already linked.
public struct NativeComposioApp: Identifiable, Equatable, Sendable {
    public let id: String
    public let slug: String
    public let name: String
    public let connected: Bool
    public let connecting: Bool
    /// False when Composio hosts no OAuth app for this toolkit, so connecting
    /// cannot work yet however much the row invites it.
    public let managedAuth: Bool
    public let noAuth: Bool
}

public struct NativeConnectionsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func connectors(for accountID: AccountID) async throws -> [NativeConnector] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/connectors",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceExtrasError.requestFailed(response.statusCode)
        }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value,
            case .array(let items)? = root["connectors"]
        else { throw NativeWorkspaceExtrasError.malformedResponse }
        return items.compactMap(Self.decodeConnector)
    }

    /// The full Composio directory, not only what is already linked.
    ///
    /// `/api/connectors` returns direct connectors plus the Composio apps this
    /// account has *connected* — by design. The browsable catalog is a separate
    /// route, which is why the phone previously showed nothing it had not
    /// already linked. `connected=0` asks for everything.
    ///
    /// A 503 means Composio is not configured on this deployment, and a 429 is
    /// its catalog rate limit. Both are *empty*, not failures: the direct
    /// connectors alongside them are still perfectly valid, and failing the whole
    /// screen because an optional directory is unavailable would be wrong.
    public func composioCatalog(
        query: String = "", for accountID: AccountID
    ) async throws -> [NativeComposioApp] {
        let escaped = query.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? ""
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/connectors/composio/catalog?connected=0&q=\(escaped)",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if response.statusCode == 503 || response.statusCode == 429 { return [] }
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceExtrasError.requestFailed(response.statusCode)
        }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let root) = value,
            case .array(let items)? = root["items"]
        else { throw NativeWorkspaceExtrasError.malformedResponse }
        return items.compactMap(Self.decodeComposioApp)
    }

    static func decodeComposioApp(_ value: JunoJSONValue) -> NativeComposioApp? {
        guard case .object(let o) = value,
            case .string(let id)? = o["id"],
            case .string(let name)? = o["name"]
        else { return nil }
        return NativeComposioApp(
            id: id,
            slug: o["slug"]?.stringValue ?? id,
            name: name,
            connected: o["connected"]?.boolValue ?? false,
            connecting: o["connecting"]?.boolValue ?? false,
            managedAuth: o["managedAuth"]?.boolValue ?? false,
            noAuth: o["noAuth"]?.boolValue ?? false
        )
    }

    /// Disconnect. Linking is deliberately **not** here: it is an OAuth flow
    /// that has to happen in a browser, and the phone sends you there rather
    /// than pretending it can complete a consent screen in-app.
    public func disconnect(id: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/connectors/\(id)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceExtrasError.requestFailed(response.statusCode)
        }
    }

    static func decodeConnector(_ value: JunoJSONValue) -> NativeConnector? {
        guard case .object(let o) = value,
            case .string(let id)? = o["id"],
            case .string(let label)? = o["label"]
        else { return nil }
        return NativeConnector(
            id: id,
            kind: o["kind"]?.stringValue ?? "oauth",
            label: label,
            capability: o["capability"]?.stringValue ?? o["description"]?.stringValue ?? "",
            configured: o["configured"]?.boolValue ?? false,
            connected: o["connected"]?.boolValue ?? false,
            accountLabel: o["accountLabel"]?.stringValue,
            connectedAt: o["connectedAt"]?.date
        )
    }
}

public enum NativeWorkspaceExtrasError: Error, Equatable, Sendable {
    case requestFailed(Int)
    case malformedResponse
}

// MARK: - Model

/// Drives both screens.
///
/// They share one model because they share one shape — a small remote list, a
/// pause/disconnect action, and the same offline-versus-refused distinction —
/// and because keeping them together stops the two drifting into two different
/// answers for "what does a failed load look like".
@MainActor
@Observable
public final class NativeWorkspaceExtrasModel {
    public enum Phase: Equatable, Sendable {
        case idle, loading, ready
        /// Could not reach Juno. Retrying is the right response.
        case offline
        /// Juno answered and refused. Retrying cannot help.
        case failed
    }

    public private(set) var tasksPhase: Phase = .idle
    public private(set) var connectorsPhase: Phase = .idle
    public private(set) var tasks: [NativeScheduledTask] = []
    public private(set) var connectors: [NativeConnector] = []
    /// The browsable Composio directory, minus anything already represented by a
    /// connector row, so one app never appears twice.
    public private(set) var composioApps: [NativeComposioApp] = []
    public private(set) var lastErrorDescription: String?
    public private(set) var isMutating = false

    private let tasksClient: NativeTasksClient
    private let connectionsClient: NativeConnectionsClient
    private var accountID: AccountID?

    public init(tasks: NativeTasksClient, connections: NativeConnectionsClient) {
        self.tasksClient = tasks
        self.connectionsClient = connections
    }

    public func start(for accountID: AccountID) { self.accountID = accountID }

    public func stop() {
        accountID = nil
        tasks = []
        connectors = []
        composioApps = []
        tasksPhase = .idle
        connectorsPhase = .idle
        lastErrorDescription = nil
    }

    public func loadTasks() async {
        guard let accountID else { return }
        tasksPhase = .loading
        do {
            tasks = try await tasksClient.tasks(for: accountID)
            lastErrorDescription = nil
            tasksPhase = .ready
        } catch {
            tasksPhase = Self.phase(for: error)
            lastErrorDescription = Self.describe(error)
        }
    }

    public func loadConnectors() async {
        guard let accountID else { return }
        connectorsPhase = .loading
        do {
            connectors = try await connectionsClient.connectors(for: accountID)
            // The directory is *additive*: if it is unavailable the direct
            // connectors are still worth showing, so its failure is swallowed
            // here rather than failing the screen.
            let alreadyListed = Set(connectors.map(\.id))
            composioApps = ((try? await connectionsClient.composioCatalog(for: accountID)) ?? [])
                .filter { !alreadyListed.contains($0.id) && !alreadyListed.contains($0.slug) }
            lastErrorDescription = nil
            connectorsPhase = .ready
        } catch {
            connectorsPhase = Self.phase(for: error)
            lastErrorDescription = Self.describe(error)
        }
    }

    /// Optimistic, then reconciled by a reload. A schedule toggle that appears
    /// to work and silently did not is worse than a slow one.
    public func setTaskEnabled(_ enabled: Bool, id: String) async {
        guard let accountID, !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await tasksClient.setEnabled(enabled, taskID: id, for: accountID)
            await loadTasks()
        } catch {
            lastErrorDescription = Self.describe(error)
            await loadTasks()
        }
    }

    public func disconnect(id: String) async {
        guard let accountID, !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await connectionsClient.disconnect(id: id, for: accountID)
            await loadConnectors()
        } catch {
            lastErrorDescription = Self.describe(error)
            await loadConnectors()
        }
    }

    /// A transport error means unreachable; an HTTP status means refused. They
    /// get different phases because they have different remedies.
    static func phase(for error: any Error) -> Phase {
        if case NativeWorkspaceExtrasError.requestFailed = error { return .failed }
        if error is URLError { return .offline }
        return .failed
    }

    /// Never surfaces a raw Swift error. `localizedDescription` on a plain
    /// `Error` renders as "JunoChatKit.NativeWorkspaceExtrasError error 1",
    /// which tells a person nothing and looks broken — the same defect that was
    /// already fixed once for the sync banner.
    static func describe(_ error: any Error) -> String {
        if let known = error as? NativeWorkspaceExtrasError {
            switch known {
            case .requestFailed(let status) where status == 401 || status == 403:
                return String(localized: "extras.error.unauthorized")
            case .requestFailed(let status):
                return String(localized: "extras.error.refused \(status)")
            case .malformedResponse:
                return String(localized: "extras.error.malformed")
            }
        }
        if error is URLError { return String(localized: "extras.error.offline") }
        return String(localized: "extras.error.generic")
    }
}
