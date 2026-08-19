import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// MARK: - Domain

/// Where a Juno Code task runs.
///
/// The two targets are genuinely different products sharing one transport:
/// **cloud** dispatches a GitHub Actions runner against a repository and opens a
/// pull request; **device** hands the task to a Mac or Windows machine running
/// Juno Code, which works in a real local folder. The picker names them that way
/// rather than as a setting, because choosing wrongly means the work happens
/// somewhere the reader did not intend.
public enum NativeCodeTarget: String, CaseIterable, Identifiable, Sendable {
    case cloud
    case device

    public var id: String { rawValue }
}

public enum NativeCodeTaskStatus: String, Sendable {
    case queued
    case running
    case awaitingApproval = "awaiting_approval"
    case done
    case failed
    case cancelled

    public var isTerminal: Bool {
        self == .done || self == .failed || self == .cancelled
    }

    public var isActive: Bool { !isTerminal }
}

/// A computer signed in to Juno Code — the reader's Mac or Windows machine.
public struct NativeCodeDevice: Identifiable, Equatable, Sendable {
    public struct Workspace: Identifiable, Equatable, Sendable {
        public let name: String
        public let path: String
        public let key: String?

        public var id: String { key ?? path }

        /// Public so a host can describe its own granted folders when it
        /// registers, not only so the phone can decode someone else's.
        public init(name: String, path: String, key: String?) {
            self.name = name
            self.path = path
            self.key = key
        }
    }

    public let id: String
    public let name: String
    /// `macos` or `windows`.
    public let platform: String
    public let appVersion: String
    public let workspaces: [Workspace]
    public let activeCount: Int
    public let lastSeenAt: Date
    /// The server's own verdict, from a two-minute heartbeat window. Not
    /// recomputed here — a device the server considers offline will not pick a
    /// task up, whatever the phone's clock thinks.
    public let online: Bool
    /// Whether this host claims and runs queued work.
    ///
    /// Separate from `online`, and the distinction is the whole point: a Mac
    /// can be signed in, heartbeating, and listing its workspaces while
    /// claiming nothing at all. Reading `online` as "can run my work" is what
    /// made the phone offer Remote as a target for work that then sat queued
    /// forever.
    public let servesQueuedTasks: Bool

    /// Whether dispatching work at this device can actually succeed.
    public var canAcceptWork: Bool { online && servesQueuedTasks }

    public var platformSymbol: String {
        platform == "windows" ? "pc" : "laptopcomputer"
    }
}

/// One event in a task's log.
public struct NativeCodeEvent: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case status
        case user
        case text
        case tool
        case fileChange = "file_change"
        case approvalRequest = "approval_request"
        case approvalResponse = "approval_response"
        case cancelRequest = "cancel_request"
        case error
        case done
        case agent
        /// The host declaring it can act on the three rollback verbs below.
        /// Carried so the log decodes without dropping it, not to be shown —
        /// see `decodeEvent`.
        case rollbackReady = "rollback_ready"
        case acceptChange = "accept_change"
        case rejectChange = "reject_change"
        case undoChange = "undo_change"
        case rollbackResult = "rollback_result"
        case preview
        case testRun = "test_run"
    }

    public struct TestSummary: Equatable, Sendable {
        public enum Status: String, Sendable {
            case unknown
            case running
            case passed
            case failed
            case skipped
            case cancelled
        }

        public let status: Status
        public let framework: String?
        public let suite: String?
        public let testsRun: Int?
        public let passed: Int?
        public let failed: Int?
        public let skipped: Int?
        public let durationSeconds: Double?
        public let failureDetail: String?
        public let location: String?

        public init(
            status: Status = .unknown,
            framework: String? = nil,
            suite: String? = nil,
            testsRun: Int? = nil,
            passed: Int? = nil,
            failed: Int? = nil,
            skipped: Int? = nil,
            durationSeconds: Double? = nil,
            failureDetail: String? = nil,
            location: String? = nil
        ) {
            self.status = status
            self.framework = framework
            self.suite = suite
            self.testsRun = testsRun
            self.passed = passed
            self.failed = failed
            self.skipped = skipped
            self.durationSeconds = durationSeconds
            self.failureDetail = failureDetail
            self.location = location
        }
    }

    public struct AgentInfo: Equatable, Sendable {
        public let agentID: String
        public let parentID: String?
        public let role: String
        public let title: String?
        public let model: String?
        public let status: String
        public let summary: String?

        public init(
            agentID: String,
            parentID: String? = nil,
            role: String,
            title: String? = nil,
            model: String? = nil,
            status: String,
            summary: String? = nil
        ) {
            self.agentID = agentID
            self.parentID = parentID
            self.role = role
            self.title = title
            self.model = model
            self.status = status
            self.summary = summary
        }
    }

    public struct FileChangeInfo: Equatable, Sendable {
        public let path: String
        public let changeKind: String
        public let linesAdded: Int
        public let linesRemoved: Int
        public let diff: String?

        public init(
            path: String,
            changeKind: String = "edit",
            linesAdded: Int = 0,
            linesRemoved: Int = 0,
            diff: String? = nil
        ) {
            self.path = path
            self.changeKind = changeKind
            self.linesAdded = linesAdded
            self.linesRemoved = linesRemoved
            self.diff = diff
        }
    }

    public struct PreviewInfo: Equatable, Sendable {
        public let url: String?
        public let screenshotURL: String?
        public let status: String
        public let diagnostic: String?

        public init(
            url: String? = nil,
            screenshotURL: String? = nil,
            status: String = "ready",
            diagnostic: String? = nil
        ) {
            self.url = url
            self.screenshotURL = screenshotURL
            self.status = status
            self.diagnostic = diagnostic
        }
    }

    public let seq: Int
    public let kind: Kind
    public let title: String
    public let detail: String?
    public let exitCode: Int?
    public let testSummary: TestSummary?
    public let agentInfo: AgentInfo?
    public let fileChangeInfo: FileChangeInfo?
    public let previewInfo: PreviewInfo?
    public let createdAt: Date

    public var id: Int { seq }

    public init(
        seq: Int,
        kind: Kind,
        title: String,
        detail: String? = nil,
        exitCode: Int? = nil,
        testSummary: TestSummary? = nil,
        agentInfo: AgentInfo? = nil,
        fileChangeInfo: FileChangeInfo? = nil,
        previewInfo: PreviewInfo? = nil,
        createdAt: Date
    ) {
        self.seq = seq
        self.kind = kind
        self.title = title
        self.detail = detail
        self.exitCode = exitCode
        self.testSummary = testSummary
        self.agentInfo = agentInfo
        self.fileChangeInfo = fileChangeInfo
        self.previewInfo = previewInfo
        self.createdAt = createdAt
    }
}

/// An action the agent will not take without a yes.
public struct NativeCodeApproval: Equatable, Sendable {
    public let requestID: String
    public let summary: String
    public let risk: String
    public let detail: String?
}

public struct NativeCodeTask: Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var prompt: String
    public var status: NativeCodeTaskStatus
    public var target: NativeCodeTarget
    public var deviceID: String?
    public var workspaceName: String?
    public var workspacePath: String?
    public var repoOwner: String?
    public var repoName: String?
    public var baseRef: String?
    /// The server conversation this task writes into, when the task was
    /// created by the authenticated Code session composer. Older standalone
    /// tasks may legitimately have no conversation and remain monitor-only.
    public var conversationID: String?
    /// The pull request a finished cloud task opened, when it opened one.
    public var pullRequestURL: URL?
    public var lastSeq: Int
    public var createdAt: Date
    public var updatedAt: Date

    /// "owner/name" for a cloud task, the folder name for a device task.
    public var whereItRuns: String {
        switch target {
        case .cloud:
            guard let repoOwner, let repoName else { return "" }
            return "\(repoOwner)/\(repoName)"
        case .device:
            // The task API still carries the host's path for the device to
            // execute against, but an owner-facing history label never needs
            // to reveal it. A mobile-safe projection can omit the field later
            // without changing the monitor's copy or layout.
            return workspaceName ?? "Remote computer"
        }
    }
}

/// A repository the account's linked GitHub can dispatch a cloud run against.
public struct NativeCodeRepository: Identifiable, Equatable, Sendable {
    public let owner: String
    public let name: String
    public let fullName: String
    public let isPrivate: Bool
    public let defaultBranch: String
    public let updatedAt: Date?

    public var id: String { fullName }
}

/// Why the repository list is empty. Two of these are dead ends a retry cannot
/// fix — they need the GitHub connector linked or re-linked — so the screen
/// sends the reader to Connections rather than offering a button that will fail
/// again.
public enum NativeCodeRepositoryFailure: String, Equatable, Sendable {
    case notConnected = "github_not_connected"
    case unauthorized = "github_unauthorized"
    case unreachable = "github_unreachable"
}

public enum NativeCodeError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case repositories(NativeCodeRepositoryFailure)
    case cloudUnavailable(String)
    case followUpUnavailable
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: String(localized: "code.error.malformed")
        case .repositories(let failure):
            switch failure {
            case .notConnected: String(localized: "code.error.github-not-connected")
            case .unauthorized: String(localized: "code.error.github-unauthorized")
            case .unreachable: String(localized: "code.error.github-unreachable")
            }
        case .cloudUnavailable(let message): message
        case .followUpUnavailable:
            "This remote run is not linked to a resumable Code conversation."
        case .server(_, let message): message
        }
    }
}

// MARK: - Client

/// The Juno Code task surface (`/api/code/*`), which the website's Code tab
/// already drives. Every route authenticates through `getCurrentUser()`, so a
/// native bearer works on all of them — including the SSE event stream.
public struct NativeCodeTaskClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending
    private let streamer: any NativeAuthenticatedByteStreaming

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: any NativeAuthenticatedByteStreaming
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    public func devices(for accountID: AccountID) async throws -> [NativeCodeDevice] {
        let response = try await get("/api/code/devices", for: accountID)
        try requireSuccess(response)
        return try Self.decodeDevices(response.body)
    }

    /// Split out from the request so the wire contract can be tested without a
    /// transport — in particular that an absent `servesQueuedTasks` reads as
    /// false rather than being defaulted optimistically.
    static func decodeDevices(_ body: Data) throws -> [NativeCodeDevice] {
        guard let wire = try? JSONDecoder().decode(DeviceListWire.self, from: body)
        else { throw NativeCodeError.malformedResponse }
        return wire.devices.compactMap { device in
            guard let lastSeenAt = NativeCodeISO8601.date(from: device.lastSeenAt) else {
                return nil
            }
            return NativeCodeDevice(
                id: device.id,
                name: device.name,
                platform: device.platform ?? "macos",
                appVersion: device.appVersion ?? "",
                workspaces: (device.workspaces ?? []).map {
                    NativeCodeDevice.Workspace(name: $0.name, path: $0.path, key: $0.key)
                },
                activeCount: device.activeCount ?? 0,
                lastSeenAt: lastSeenAt,
                online: device.online ?? false,
                // Absent is false. A server that predates the capability knew
                // no host that served work, so reading absence as "yes" would
                // recreate exactly the bug this field exists to close.
                servesQueuedTasks: device.servesQueuedTasks ?? false
            )
        }
    }

    /// Announces this machine as a computer that can run local code sessions,
    /// and refreshes its heartbeat.
    ///
    /// The same call does both: the route is an upsert, and `lastSeenAt` is
    /// written on every POST. `/api/code/devices` calls a device online only
    /// while its last heartbeat is inside a two-minute window, so a host that
    /// registers once at launch and then goes quiet disappears from the phone's
    /// picker three minutes later — registering is not a thing you do, it is a
    /// thing you keep doing.
    ///
    /// `deviceID` is this host's previously assigned id, replayed so a rename
    /// updates the existing row instead of leaving the old name behind as a
    /// second, permanently offline computer. Without it the server falls back to
    /// matching on `(user, name)`, which is why two Macs called "MacBook Pro"
    /// would otherwise collide.
    ///
    /// - Returns: the server's id for this device, to be persisted and replayed.
    public func registerDevice(
        deviceID: String?,
        name: String,
        platform: String,
        appVersion: String,
        workspaces: [NativeCodeDevice.Workspace],
        sessionCount: Int,
        activeCount: Int,
        /// Defaults to false so a caller that has not been taught about the
        /// capability registers as presence-only — the truthful answer for
        /// every host that does not run the claim loop.
        servesQueuedTasks: Bool = false,
        for accountID: AccountID
    ) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/devices",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    RegisterDeviceWire(
                        deviceId: deviceID,
                        // The route rejects an empty name and caps it at 200. A
                        // Mac with no localized name is not a reason to fail
                        // registration, so an empty one becomes the platform.
                        name: Self.clamp(name.isEmpty ? "Mac" : name, to: 200),
                        platform: platform,
                        appVersion: Self.clamp(appVersion, to: 100),
                        protocolVersion: Self.protocolVersion,
                        sessionCount: max(0, sessionCount),
                        activeCount: max(0, activeCount),
                        servesQueuedTasks: servesQueuedTasks,
                        // Clamped to the route's own limits rather than sent raw:
                        // one over-long path 400s the whole registration, and the
                        // failure would read as "this Mac is offline".
                        workspaces: workspaces.prefix(100).compactMap { workspace in
                            let name = Self.clamp(workspace.name, to: 200)
                            let path = Self.clamp(workspace.path, to: 1000)
                            guard !name.isEmpty, !path.isEmpty else { return nil }
                            return RegisterDeviceWire.Workspace(
                                name: name,
                                path: path,
                                key: workspace.key.map { Self.clamp($0, to: 200) }
                            )
                        }
                    )
                )
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(
            RegisterDeviceResponseWire.self, from: response.body
        ) else { throw NativeCodeError.malformedResponse }
        return wire.device.id
    }

    /// The event-protocol version this client speaks, as
    /// `src/app/api/code/devices/route.ts` records it.
    private static let protocolVersion = 1

    /// Trimmed, then cut to the route's maximum. Cut by *character*, because the
    /// server counts characters too — cutting bytes would split an emoji in a
    /// folder name and produce a string that fails to decode.
    private static func clamp(_ value: String, to limit: Int) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        return String(trimmed.prefix(limit))
    }

    public func tasks(limit: Int, for accountID: AccountID) async throws -> [NativeCodeTask] {
        let response = try await get(
            "/api/code/tasks",
            queryItems: [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))],
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(TaskListWire.self, from: response.body)
        else { throw NativeCodeError.malformedResponse }
        return wire.tasks.compactMap(Self.decode)
    }

    public func repositories(for accountID: AccountID) async throws -> [NativeCodeRepository] {
        let response = try await get("/api/code/github/repos", for: accountID)
        if !(200...299).contains(response.statusCode) {
            let code = (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.error
            throw NativeCodeError.repositories(
                NativeCodeRepositoryFailure(rawValue: code ?? "") ?? .unreachable
            )
        }
        guard let wire = try? JSONDecoder().decode(RepoListWire.self, from: response.body)
        else { throw NativeCodeError.malformedResponse }
        return wire.repos.map {
            NativeCodeRepository(
                owner: $0.owner,
                name: $0.name,
                fullName: $0.fullName,
                isPrivate: $0.private,
                defaultBranch: $0.defaultBranch,
                updatedAt: $0.updatedAt.flatMap(NativeCodeISO8601.date(from:))
            )
        }
    }

    /// Dispatches a cloud run against a repository.
    public func createCloudTask(
        prompt: String,
        repository: NativeCodeRepository,
        baseRef: String?,
        for accountID: AccountID,
        conversationID: String? = nil
    ) async throws -> NativeCodeTask {
        try await createTask(
            body: CreateTaskWire(
                target: "cloud",
                prompt: prompt,
                repo: .init(owner: repository.owner, name: repository.name),
                baseRef: baseRef?.isEmpty == false ? baseRef : repository.defaultBranch,
                deviceId: nil,
                workspacePath: nil,
                workspaceName: nil,
                workspaceKey: nil,
                origin: "remote",
                idempotencyKey: UUID().uuidString,
                conversationID: conversationID,
                createsNewSession: conversationID == nil ? nil : false
            ),
            for: accountID
        )
    }

    /// Queues a task on a signed-in computer.
    public func createDeviceTask(
        prompt: String,
        device: NativeCodeDevice,
        workspace: NativeCodeDevice.Workspace,
        for accountID: AccountID,
        conversationID: String? = nil
    ) async throws -> NativeCodeTask {
        try await createTask(
            body: CreateTaskWire(
                target: "device",
                prompt: prompt,
                repo: nil,
                baseRef: nil,
                deviceId: device.id,
                workspacePath: workspace.path,
                workspaceName: workspace.name,
                workspaceKey: workspace.key,
                origin: "remote",
                idempotencyKey: UUID().uuidString,
                conversationID: conversationID,
                createsNewSession: conversationID == nil ? nil : false
            ),
            for: accountID
        )
    }

    /// Creates the server-side Code conversation used by a Cloud/Remote task.
    ///
    /// Remote tasks are not local CodeSession rows, but a conversation gives
    /// the task a durable transcript and makes a later follow-up possible from
    /// another signed-in Juno client. The request intentionally omits nil
    /// workspace fields because the route's optional Zod fields accept absence,
    /// not JSON null.
    public func createCodeConversation(
        workspaceName: String?,
        workspacePath: String?,
        workspaceKey: String?,
        for accountID: AccountID
    ) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    CreateCodeConversationWire(
                        workspaceName: workspaceName,
                        workspacePath: workspacePath,
                        workspaceKey: workspaceKey
                    )
                )
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(
            CreateCodeConversationResponseWire.self, from: response.body
        ), !wire.conversation.id.isEmpty else {
            throw NativeCodeError.malformedResponse
        }
        return wire.conversation.id
    }

    /// Starts another server-owned task in the same Code conversation.
    ///
    /// A task is an execution, while the conversation is the durable session:
    /// continuing means a new execution with createsNewSession false, not a
    /// mutation of a completed task. That preserves the audit trail and lets a
    /// retry/follow-up remain independently cancellable.
    public func followUp(
        prompt: String,
        after task: NativeCodeTask,
        for accountID: AccountID
    ) async throws -> NativeCodeTask {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let conversationID = task.conversationID else {
            throw NativeCodeError.followUpUnavailable
        }
        let repository: CreateTaskWire.Repo?
        switch task.target {
        case .cloud:
            guard let owner = task.repoOwner, let name = task.repoName else {
                throw NativeCodeError.followUpUnavailable
            }
            repository = .init(owner: owner, name: name)
        case .device:
            repository = nil
        }
        return try await createTask(
            body: CreateTaskWire(
                target: task.target.rawValue,
                prompt: trimmed,
                repo: repository,
                baseRef: task.baseRef,
                deviceId: task.deviceID,
                workspacePath: task.workspacePath,
                workspaceName: task.workspaceName,
                workspaceKey: nil,
                origin: "remote",
                idempotencyKey: UUID().uuidString,
                conversationID: conversationID,
                createsNewSession: false
            ),
            for: accountID
        )
    }

    public func cancel(id: String, for accountID: AccountID) async throws -> NativeCodeTask {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/tasks/\(id)/cancel",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(TaskWrapperWire.self, from: response.body),
            let task = Self.decode(wire.task)
        else { throw NativeCodeError.malformedResponse }
        return task
    }

    public func respond(
        id: String, requestID: String, approve: Bool, for accountID: AccountID
    ) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/tasks/\(id)/respond",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    RespondWire(requestId: requestID, approve: approve)
                )
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    /// One frame of a task's live log.
    public enum StreamFrame: Sendable {
        case snapshot(task: NativeCodeTask, events: [NativeCodeEvent], approval: NativeCodeApproval?)
        case events(task: NativeCodeTask, events: [NativeCodeEvent], approval: NativeCodeApproval?)
        case done(task: NativeCodeTask)
    }

    /// Follows a task's event log.
    ///
    /// The stream self-limits to a four-minute window server-side and the client
    /// is expected to reconnect from `afterSeq` — so this finishing is normal,
    /// not an error, and the caller reconnects rather than reporting a failure.
    public func events(
        taskID: String, afterSeq: Int, for accountID: AccountID
    ) async throws -> AsyncThrowingStream<StreamFrame, any Error> {
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: "/api/code/tasks/\(taskID)/events",
                queryItems: afterSeq > 0
                    ? [URLQueryItem(name: "afterSeq", value: String(afterSeq))] : [],
                headers: try HTTPHeaders(["accept": "text/event-stream"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw NativeCodeError.server(
                statusCode: response.statusCode,
                message: String(
                    format: String(localized: "code.error.status"), response.statusCode
                )
            )
        }
        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = NativeCodeSSEParser()
                    for try await byte in response.bytes {
                        for payload in parser.consume(byte) {
                            if let frame = Self.decodeFrame(payload) { continuation.yield(frame) }
                        }
                    }
                    for payload in parser.finish() {
                        if let frame = Self.decodeFrame(payload) { continuation.yield(frame) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    // MARK: Internals

    private func createTask(
        body: CreateTaskWire, for accountID: AccountID
    ) async throws -> NativeCodeTask {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/code/tasks",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        // 503 here is the server saying cloud dispatch is not configured at all,
        // which is a different sentence from "the dispatch failed".
        if response.statusCode == 503 {
            let message = (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.message
                ?? String(localized: "code.error.cloud-unconfigured")
            throw NativeCodeError.cloudUnavailable(message)
        }
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(TaskWrapperWire.self, from: response.body),
            let task = Self.decode(wire.task)
        else { throw NativeCodeError.malformedResponse }
        return task
    }

    private func get(
        _ path: String, queryItems: [URLQueryItem] = [], for accountID: AccountID
    ) async throws -> HTTPResponse {
        try await sender.send(
            try NativeBearerRequest(
                path: path,
                queryItems: queryItems,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let wire = try? JSONDecoder().decode(ErrorWire.self, from: response.body)
        throw NativeCodeError.server(
            statusCode: response.statusCode,
            message: wire?.message ?? wire?.error
                ?? String(format: String(localized: "code.error.status"), response.statusCode)
        )
    }

    private static func decodeFrame(_ payload: Data) -> StreamFrame? {
        guard let wire = try? JSONDecoder().decode(FrameWire.self, from: payload),
            let task = decode(wire.task)
        else { return nil }
        let events = (wire.events ?? []).compactMap(decodeEvent)
        let approval = (wire.events ?? []).compactMap(decodeApproval).last
        switch wire.type {
        case "snapshot": return .snapshot(task: task, events: events, approval: approval)
        case "events": return .events(task: task, events: events, approval: approval)
        case "done": return .done(task: task)
        default: return nil
        }
    }

    private static func decode(_ wire: TaskWire?) -> NativeCodeTask? {
        guard let wire,
            let status = NativeCodeTaskStatus(rawValue: wire.status),
            let createdAt = NativeCodeISO8601.date(from: wire.createdAt),
            let updatedAt = NativeCodeISO8601.date(from: wire.updatedAt)
        else { return nil }
        return NativeCodeTask(
            id: wire.id,
            title: wire.title ?? String(localized: "code.session.untitled"),
            prompt: wire.prompt ?? "",
            status: status,
            target: wire.target == "cloud" ? .cloud : .device,
            deviceID: wire.deviceId,
            workspaceName: wire.workspaceName,
            workspacePath: wire.workspacePath,
            repoOwner: wire.repoOwner,
            repoName: wire.repoName,
            baseRef: wire.baseRef,
            conversationID: wire.conversationId,
            pullRequestURL: wire.prUrl.flatMap(URL.init(string:)),
            lastSeq: wire.lastSeq ?? 0,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    /// Turns a wire event into the one line it deserves in the log. The mapping
    /// mirrors `src/lib/code-remote.ts` so a run reads the same on the phone as
    /// it does in the browser.
    private static func decodeEvent(_ wire: EventWire) -> NativeCodeEvent? {
        guard let kind = NativeCodeEvent.Kind(rawValue: wire.kind),
            let createdAt = NativeCodeISO8601.date(from: wire.createdAt)
        else { return nil }
        let payload = wire.payload ?? [:]
        let title: String
        var detail = payload["detail"]?.stringValue

        switch kind {
        case .text:
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return nil }
            title = text
            detail = nil
        case .user:
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return nil }
            title = text
            detail = nil
        case .tool:
            guard let summary = payload["summary"]?.stringValue ?? payload["name"]?.stringValue
            else { return nil }
            title = summary
        case .fileChange:
            guard let path = payload["path"]?.stringValue else { return nil }
            let change = payload["changeKind"]?.stringValue ?? "edit"
            title = "\(change) \(path)"
            detail = "+\(payload["added"]?.intValue ?? 0) −\(payload["removed"]?.intValue ?? 0)"
        case .approvalRequest:
            guard let summary = payload["summary"]?.stringValue else { return nil }
            title = String(localized: "code.event.approval-requested")
            detail = summary
        case .approvalResponse:
            let approved = payload["approve"]?.boolValue ?? false
            title = approved
                ? String(localized: "code.event.approved")
                : String(localized: "code.event.denied")
        case .cancelRequest:
            title = String(localized: "code.event.cancel-requested")
        /*
         * ROLLBACK, READ THE SAME WAY IT IS READ IN THE BROWSER.
         *
         * An older build of this app decodes none of these: `Kind(rawValue:)`
         * returns nil for a kind it has never heard of and `decodeEvent` drops
         * the row, which is exactly the tolerance the new kinds rely on. Adding
         * them here is what turns that silence into a readable line.
         *
         * `defaultValue:` rather than the bare `String(localized:)` the cases
         * above use, because the string catalogue these keys belong in
         * (native/iOS/JunoMobile/Resources/Localizable.xcstrings) is not this
         * package's to edit. Without a default, a missing entry renders the KEY
         * — "code.event.rollback-applied" — into the reader's log. The keys stay
         * conventional so the catalogue entries drop in later with no code
         * change; only the fallback lives here.
         */
        case .rollbackReady:
            // Capability, not transcript. It says what the host CAN do, which
            // is a fact about the connection rather than something that
            // happened to the reader's files; a log line for it would be a
            // sentence that never means anything to anyone reading back.
            return nil
        case .acceptChange:
            title = String(localized: "code.event.keep-requested", defaultValue: "Keep requested")
            detail = payload["path"]?.stringValue
        case .rejectChange:
            title = String(localized: "code.event.revert-requested", defaultValue: "Revert requested")
            detail = payload["path"]?.stringValue
        case .undoChange:
            title = String(localized: "code.event.undo-requested", defaultValue: "Undo requested")
        case .rollbackResult:
            // Three outcomes, never folded into two. "Nothing to roll back" is
            // the host saying it holds no snapshot — anything a shell command
            // wrote is outside the checkpoint net — and reporting that as a
            // failure would send the reader looking for a fault there is not.
            switch payload["status"]?.stringValue {
            case "applied":
                title = String(localized: "code.event.rollback-applied", defaultValue: "Rolled back")
            case "unsupported":
                title = String(
                    localized: "code.event.rollback-unsupported",
                    defaultValue: "Nothing to roll back"
                )
            default:
                title = String(localized: "code.event.rollback-failed", defaultValue: "Rollback failed")
            }
            detail =
                payload["message"]?.stringValue
                ?? payload["paths"]?.arrayValue?.compactMap { $0.stringValue }.joined(separator: ", ")
        case .error:
            guard let message = payload["message"]?.stringValue else { return nil }
            title = message
        case .status:
            guard let status = payload["status"]?.stringValue else { return nil }
            title = status
        case .done:
            title = String(localized: "code.event.finished")
        case .agent:
            guard let agent = payload["agent"]?.objectValue else { return nil }
            let role = agent["role"]?.stringValue ?? "agent"
            let agentTitle = agent["title"]?.stringValue
            let status = agent["status"]?.stringValue ?? ""
            title = "\(role)\(agentTitle.map { " · \($0)" } ?? "") — \(status)"
            detail = agent["summary"]?.stringValue
        case .preview:
            title = String(localized: "code.event.preview", defaultValue: "Preview updated")
            detail = payload["url"]?.stringValue ?? payload["diagnostic"]?.stringValue
        case .testRun:
            let statusStr = payload["status"]?.stringValue
            let passedBool = payload["passed"]?.boolValue
            let failedCount = payload["failed"]?.intValue ?? 0
            let tests = payload["testsRun"]?.intValue ?? payload["tests"]?.intValue
            if passedBool == true || statusStr == "passed" {
                title = String(localized: "code.event.tests-passed", defaultValue: "Tests passed\(tests.map { " (\($0))" } ?? "")")
            } else if passedBool == false || statusStr == "failed" || failedCount > 0 {
                title = String(localized: "code.event.tests-failed", defaultValue: "Tests failed")
            } else if statusStr == "running" {
                title = String(localized: "code.event.tests-running", defaultValue: "Running tests…")
            } else if statusStr == "skipped" {
                title = String(localized: "code.event.tests-skipped", defaultValue: "Tests skipped")
            } else {
                title = String(localized: "code.event.tests-unknown", defaultValue: "Test run recorded")
            }
            detail = payload["failureDetail"]?.stringValue ?? payload["suite"]?.stringValue
        }

        let exitCode = payload["exitCode"]?.intValue ?? payload["exit_code"]?.intValue

        var testSummary: NativeCodeEvent.TestSummary? = nil
        if kind == .testRun || payload["testSummary"] != nil || payload["test_run"] != nil {
            let testObj = payload["testSummary"]?.objectValue ?? payload["test_run"]?.objectValue ?? payload
            let statusRaw = testObj["status"]?.stringValue ?? payload["status"]?.stringValue
            let passedVal = testObj["passed"]?.intValue ?? (testObj["passed"]?.boolValue == true ? 1 : nil)
            let failedVal = testObj["failed"]?.intValue ?? (testObj["passed"]?.boolValue == false ? 1 : nil)
            let status: NativeCodeEvent.TestSummary.Status
            if let statusRaw, let mapped = NativeCodeEvent.TestSummary.Status(rawValue: statusRaw.lowercased()) {
                status = mapped
            } else if (failedVal ?? 0) > 0 || testObj["passed"]?.boolValue == false {
                status = .failed
            } else if testObj["passed"]?.boolValue == true || (passedVal ?? 0) > 0 {
                status = .passed
            } else if statusRaw == "running" {
                status = .running
            } else {
                status = .unknown
            }
            testSummary = NativeCodeEvent.TestSummary(
                status: status,
                framework: testObj["framework"]?.stringValue,
                suite: testObj["suite"]?.stringValue,
                testsRun: testObj["testsRun"]?.intValue ?? testObj["tests"]?.intValue,
                passed: passedVal,
                failed: failedVal,
                skipped: testObj["skipped"]?.intValue,
                durationSeconds: testObj["durationSeconds"]?.doubleValue ?? testObj["duration"]?.doubleValue,
                failureDetail: testObj["failureDetail"]?.stringValue ?? testObj["failure"]?.stringValue,
                location: testObj["location"]?.stringValue
            )
        }

        var agentInfo: NativeCodeEvent.AgentInfo? = nil
        if let agent = payload["agent"]?.objectValue {
            agentInfo = NativeCodeEvent.AgentInfo(
                agentID: agent["id"]?.stringValue ?? agent["agentId"]?.stringValue ?? "agent-\(wire.seq)",
                parentID: agent["parentId"]?.stringValue,
                role: agent["role"]?.stringValue ?? "agent",
                title: agent["title"]?.stringValue,
                model: agent["model"]?.stringValue,
                status: agent["status"]?.stringValue ?? "running",
                summary: agent["summary"]?.stringValue
            )
        }

        var fileChangeInfo: NativeCodeEvent.FileChangeInfo? = nil
        if kind == .fileChange || payload["path"] != nil {
            if let path = payload["path"]?.stringValue {
                fileChangeInfo = NativeCodeEvent.FileChangeInfo(
                    path: path,
                    changeKind: payload["changeKind"]?.stringValue ?? "edit",
                    linesAdded: payload["added"]?.intValue ?? 0,
                    linesRemoved: payload["removed"]?.intValue ?? 0,
                    diff: payload["diff"]?.stringValue
                )
            }
        }

        var previewInfo: NativeCodeEvent.PreviewInfo? = nil
        if kind == .preview || payload["preview"] != nil || payload["screenshotUrl"] != nil {
            let prevObj = payload["preview"]?.objectValue ?? payload
            previewInfo = NativeCodeEvent.PreviewInfo(
                url: prevObj["url"]?.stringValue,
                screenshotURL: prevObj["screenshotUrl"]?.stringValue ?? prevObj["screenshotURL"]?.stringValue,
                status: prevObj["status"]?.stringValue ?? "ready",
                diagnostic: prevObj["diagnostic"]?.stringValue
            )
        }

        return NativeCodeEvent(
            seq: wire.seq,
            kind: kind,
            title: title,
            detail: detail,
            exitCode: exitCode,
            testSummary: testSummary,
            agentInfo: agentInfo,
            fileChangeInfo: fileChangeInfo,
            previewInfo: previewInfo,
            createdAt: createdAt
        )
    }

    private static func decodeApproval(_ wire: EventWire) -> NativeCodeApproval? {
        guard wire.kind == NativeCodeEvent.Kind.approvalRequest.rawValue,
            let payload = wire.payload,
            let requestID = payload["requestId"]?.stringValue,
            let summary = payload["summary"]?.stringValue
        else { return nil }
        return NativeCodeApproval(
            requestID: requestID,
            summary: summary,
            risk: payload["risk"]?.stringValue ?? "neutral",
            detail: payload["detail"]?.stringValue
        )
    }
}

/// The one ISO-8601 parser this surface shares. The server emits fractional
/// seconds on some fields and not others, so both have to be accepted.
public enum NativeCodeISO8601 {
    public static func date(from value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }
}

/// A minimal `data:` line accumulator for this surface's SSE frames. Comment
/// lines (the `: ping` keep-alive) are dropped, and an oversized frame is
/// discarded rather than allowed to grow without bound.
struct NativeCodeSSEParser {
    private static let maximumFrameBytes = 2 * 1_024 * 1_024
    private var line = Data()
    private var frame = Data()

    mutating func consume(_ byte: UInt8) -> [Data] {
        guard byte == 0x0A else {
            if line.count < Self.maximumFrameBytes { line.append(byte) }
            return []
        }
        return finishLine()
    }

    mutating func finish() -> [Data] {
        var frames: [Data] = []
        if !line.isEmpty { frames.append(contentsOf: finishLine()) }
        if !frame.isEmpty {
            frames.append(frame)
            frame.removeAll(keepingCapacity: false)
        }
        return frames
    }

    private mutating func finishLine() -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            guard !frame.isEmpty else { return [] }
            let complete = frame
            frame.removeAll(keepingCapacity: true)
            return [complete]
        }
        guard line.first != 0x3A else { return [] }
        guard let separator = line.firstIndex(of: 0x3A),
            line[..<separator].elementsEqual(Data("data".utf8))
        else { return [] }
        var value = Data(line[line.index(after: separator)...])
        if value.first == 0x20 { value.removeFirst() }
        guard frame.count + value.count <= Self.maximumFrameBytes else {
            frame.removeAll(keepingCapacity: true)
            return []
        }
        if !frame.isEmpty { frame.append(0x0A) }
        frame.append(value)
        return []
    }
}

// MARK: - Wire

private struct DeviceListWire: Decodable {
    struct Device: Decodable {
        struct Workspace: Decodable {
            let name: String
            let path: String
            let key: String?
        }

        let id: String
        let name: String
        let platform: String?
        let appVersion: String?
        let workspaces: [Workspace]?
        let activeCount: Int?
        let lastSeenAt: String
        let online: Bool?
        /// Absent from a server that predates the capability, which is the
        /// same thing as false: those servers had no host that served work.
        let servesQueuedTasks: Bool?
    }

    let devices: [Device]
}

/// The registration body, shaped by `postSchema` in
/// `src/app/api/code/devices/route.ts`.
///
/// `deviceId` is encoded only when present: the route's schema marks it
/// optional, and sending an explicit `null` fails validation rather than being
/// read as absent.
private struct RegisterDeviceWire: Encodable {
    struct Workspace: Encodable {
        let name: String
        let path: String
        let key: String?
    }

    let deviceId: String?
    let name: String
    let platform: String
    let appVersion: String
    let protocolVersion: Int
    let sessionCount: Int
    let activeCount: Int
    /// Whether this host will actually claim and execute queued work.
    ///
    /// Registration used to say only "I exist". The phone read presence as
    /// capability and offered Remote as a target, so work dispatched at a Mac
    /// was written to the queue and stayed `queued` forever — nothing claimed
    /// it. Sending the capability is what lets the backend refuse the dispatch
    /// and the phone grey out the option, instead of both assuming.
    let servesQueuedTasks: Bool
    let workspaces: [Workspace]
}

private struct RegisterDeviceResponseWire: Decodable {
    struct Device: Decodable {
        let id: String
    }

    let device: Device
}

private struct TaskListWire: Decodable {
    let tasks: [TaskWire]
}

private struct TaskWrapperWire: Decodable {
    let task: TaskWire
}

private struct TaskWire: Decodable {
    let id: String
    let title: String?
    let prompt: String?
    let status: String
    let target: String?
    let deviceId: String?
    let workspaceName: String?
    let workspacePath: String?
    let repoOwner: String?
    let repoName: String?
    let baseRef: String?
    let conversationId: String?
    let prUrl: String?
    let lastSeq: Int?
    let createdAt: String
    let updatedAt: String
}

private struct FrameWire: Decodable {
    let type: String
    let task: TaskWire?
    let events: [EventWire]?
}

private struct EventWire: Decodable {
    let seq: Int
    let kind: String
    let payload: [String: NativeCodeJSON]?
    let createdAt: String
}

private struct RepoListWire: Decodable {
    struct Repo: Decodable {
        let owner: String
        let name: String
        let fullName: String
        let `private`: Bool
        let defaultBranch: String
        let updatedAt: String?
    }

    let repos: [Repo]
}

private struct CreateTaskWire: Encodable {
    struct Repo: Encodable {
        let owner: String
        let name: String
    }

    let target: String
    let prompt: String
    let repo: Repo?
    let baseRef: String?
    let deviceId: String?
    let workspacePath: String?
    let workspaceName: String?
    let workspaceKey: String?
    let origin: String
    let idempotencyKey: String
    let conversationID: String?
    let createsNewSession: Bool?

    enum CodingKeys: String, CodingKey {
        case target, prompt, repo, baseRef, deviceId, workspacePath, workspaceName,
             workspaceKey, origin, idempotencyKey
        case conversationID = "conversationId"
        case createsNewSession
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(target, forKey: .target)
        try container.encode(prompt, forKey: .prompt)
        try container.encodeIfPresent(repo, forKey: .repo)
        try container.encodeIfPresent(baseRef, forKey: .baseRef)
        try container.encodeIfPresent(deviceId, forKey: .deviceId)
        try container.encodeIfPresent(workspacePath, forKey: .workspacePath)
        try container.encodeIfPresent(workspaceName, forKey: .workspaceName)
        try container.encodeIfPresent(workspaceKey, forKey: .workspaceKey)
        try container.encode(origin, forKey: .origin)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encodeIfPresent(conversationID, forKey: .conversationID)
        try container.encodeIfPresent(createsNewSession, forKey: .createsNewSession)
    }
}

private struct CreateCodeConversationWire: Encodable {
    let workspaceName: String?
    let workspacePath: String?
    let workspaceKey: String?

    enum CodingKeys: String, CodingKey {
        case kind, workspaceName = "codeWorkspaceName"
        case workspacePath = "codeWorkspacePath"
        case workspaceKey = "codeWorkspaceKey"
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("code", forKey: .kind)
        try container.encodeIfPresent(workspaceName, forKey: .workspaceName)
        try container.encodeIfPresent(workspacePath, forKey: .workspacePath)
        try container.encodeIfPresent(workspaceKey, forKey: .workspaceKey)
    }
}

private struct CreateCodeConversationResponseWire: Decodable {
    struct Conversation: Decodable { let id: String }
    let conversation: Conversation
}

private struct RespondWire: Encodable {
    let requestId: String
    let approve: Bool
}

private struct ErrorWire: Decodable {
    let error: String?
    let message: String?
}

/// A loosely-typed event payload. The payload schema differs per event kind and
/// grows server-side, so it is decoded as JSON and read by key rather than
/// modelled per kind — a new field cannot break the decode that way.
enum NativeCodeJSON: Decodable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: NativeCodeJSON])
    case array([NativeCodeJSON])
    case null

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: NativeCodeJSON].self) {
            self = .object(value)
        } else if let value = try? container.decode([NativeCodeJSON].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var intValue: Int? {
        if case .number(let value) = self, value.isFinite { return Int(value) }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let value) = self, value.isFinite { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var objectValue: [String: NativeCodeJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// The `.array` case was decodable from the start and had no accessor, so
    /// every payload list on this wire was unreachable. `rollback_result.paths`
    /// is the first one that matters — without this it would have had to be
    /// reported as a bare count, which tells the reader a rollback touched four
    /// files and not which four.
    var arrayValue: [NativeCodeJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }
}
