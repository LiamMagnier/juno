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
    }

    public let seq: Int
    public let kind: Kind
    public let title: String
    public let detail: String?
    public let createdAt: Date

    public var id: Int { seq }
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
            return workspaceName ?? workspacePath ?? ""
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
        guard let wire = try? JSONDecoder().decode(DeviceListWire.self, from: response.body)
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
                online: device.online ?? false
            )
        }
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
        for accountID: AccountID
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
                idempotencyKey: UUID().uuidString
            ),
            for: accountID
        )
    }

    /// Queues a task on a signed-in computer.
    public func createDeviceTask(
        prompt: String,
        device: NativeCodeDevice,
        workspace: NativeCodeDevice.Workspace,
        for accountID: AccountID
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
                idempotencyKey: UUID().uuidString
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
        }
        return NativeCodeEvent(
            seq: wire.seq, kind: kind, title: title, detail: detail, createdAt: createdAt
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
    }

    let devices: [Device]
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

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var objectValue: [String: NativeCodeJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }
}
