import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// A Code session as the relay describes it.
///
/// Note what is *not* here: no filesystem path of any kind. The host indexes a
/// workspace by an opaque `workspaceKey` and a display `workspaceName`, so a
/// phone can name the workspace it is working in without ever learning where
/// that workspace lives on the Mac. That is a deliberate boundary, not an
/// omission — a leaked absolute path tells an attacker the account name, the
/// directory layout, and often the project's real identity.
public struct CodeRemoteSessionSummary: Equatable, Sendable, Identifiable {
    public let sessionID: String
    public let deviceID: String
    public let workspaceKey: String?
    public let workspaceName: String?
    public let title: String
    public let modelID: String
    public let permissionMode: String
    public let currentStatus: String
    public let isRunning: Bool
    public let isAwaitingApproval: Bool
    public let pendingChangeCount: Int
    public let activeBranch: String?
    public let lastError: String?
    public let lastEventSequence: Int
    public let updatedAt: Date
    public let lastMessageAt: Date
    /// Whether the owning host has checked in recently. A session on a host
    /// that has gone quiet is shown as stale rather than as live-but-idle,
    /// because sending to it would produce a command nobody claims.
    public let fresh: Bool?

    public var id: String { sessionID }

    public init(
        sessionID: String, deviceID: String, workspaceKey: String?, workspaceName: String?,
        title: String, modelID: String, permissionMode: String, currentStatus: String,
        isRunning: Bool, isAwaitingApproval: Bool, pendingChangeCount: Int,
        activeBranch: String?, lastError: String?, lastEventSequence: Int,
        updatedAt: Date, lastMessageAt: Date, fresh: Bool?
    ) {
        self.sessionID = sessionID
        self.deviceID = deviceID
        self.workspaceKey = workspaceKey
        self.workspaceName = workspaceName
        self.title = title
        self.modelID = modelID
        self.permissionMode = permissionMode
        self.currentStatus = currentStatus
        self.isRunning = isRunning
        self.isAwaitingApproval = isAwaitingApproval
        self.pendingChangeCount = pendingChangeCount
        self.activeBranch = activeBranch
        self.lastError = lastError
        self.lastEventSequence = lastEventSequence
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.fresh = fresh
    }
}

/// One command travelling phone → relay → host.
public struct CodeRemoteCommand: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionID: String
    public let kind: String
    public let payload: [String: JunoJSONValue]
    public let status: String

    public init(
        id: String, sessionID: String, kind: String,
        payload: [String: JunoJSONValue], status: String
    ) {
        self.id = id
        self.sessionID = sessionID
        self.kind = kind
        self.payload = payload
        self.status = status
    }
}

public struct CodeRemoteSessionEvent: Equatable, Sendable {
    public let seq: Int
    public let kind: String
    public let payload: [String: JunoJSONValue]
    public let createdAt: Date

    public init(seq: Int, kind: String, payload: [String: JunoJSONValue], createdAt: Date) {
        self.seq = seq
        self.kind = kind
        self.payload = payload
        self.createdAt = createdAt
    }
}

public enum CodeRemoteError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier
    case unsupportedCommand(String)
    case malformedResponse
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: "Juno could not safely address that device or session."
        case .unsupportedCommand(let kind): "This build cannot send a \"\(kind)\" command."
        case .malformedResponse: "Juno returned invalid remote session data."
        case .server(_, let message, _): message
        }
    }

    public var isRetryable: Bool {
        if case .server(_, _, let retryable) = self { return retryable }
        return false
    }
}

/// The relay client, shared by the Mac host and the mobile client.
///
/// One client for both directions on purpose. The host claims commands and
/// posts events; the phone lists sessions, sends commands and reads events back
/// from a cursor. Those are two halves of one protocol, and splitting them into
/// two clients is how the halves drift into disagreeing about a payload shape.
public struct NativeCodeRemoteClient: Sendable {
    /// Every command kind the relay accepts. A kind absent from this set is
    /// refused here rather than sent, so an unsupported command fails
    /// immediately and locally instead of as an opaque 400.
    public static let supportedCommandKinds: Set<String> = [
        "message", "stop", "approval", "patch", "delete", "fork", "retry",
        "accept_change", "reject_change", "undo_change", "run_tests",
        "stop_tests", "git", "stop_agent",
    ]

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    // MARK: - Mobile side

    /// The hosts this account has registered, newest-seen first.
    ///
    /// Without this the phone has sessions but no way to discover which machine
    /// holds them — every other call here needs a `deviceID` the user has no way
    /// to type. `/api/code/devices` already served the web client; it
    /// authenticates through `getCurrentUser`, which treats a presented bearer
    /// as authoritative, so the phone reaches it with no backend change.
    ///
    /// `online` is computed server-side against its own freshness window rather
    /// than from `lastSeenAt` here, so one clock decides it. A host that omits
    /// the field is treated as offline: claiming a machine is reachable when the
    /// relay would not say so is the worse failure.
    public func devices(for accountID: AccountID) async throws -> [CodeRemoteHostSummary] {
        let response = try await get("/api/code/devices", for: accountID)
        guard let root = try decodeObject(response),
            case .array(let items)? = root["devices"]
        else { throw CodeRemoteError.malformedResponse }
        return try items.map(decodeHost)
    }

    public func sessions(
        deviceID: String,
        for accountID: AccountID
    ) async throws -> [CodeRemoteSessionSummary] {
        try validate(deviceID)
        let response = try await get("/api/code/devices/\(deviceID)/sessions", for: accountID)
        guard let root = try decodeObject(response),
            case .array(let items)? = root["sessions"]
        else { throw CodeRemoteError.malformedResponse }
        return try items.map(decodeSummary)
    }

    /// Sends a command and returns the relay's record of it.
    ///
    /// `idempotencyKey` belongs to the *action*, not the request: a phone on a
    /// bad connection retries, and the relay's unique index on
    /// `(userId, idempotencyKey)` turns the retry into a lookup instead of a
    /// second Stop or a second prompt. Reusing a key across two different
    /// actions would silently drop the second, so a caller must mint one per
    /// action and reuse it only when retrying that same action.
    public func enqueueCommand(
        deviceID: String,
        sessionID: String,
        kind: String,
        payload: [String: JunoJSONValue],
        idempotencyKey: String,
        for accountID: AccountID
    ) async throws -> CodeRemoteCommand {
        try validate(deviceID)
        try validate(sessionID)
        guard Self.supportedCommandKinds.contains(kind) else {
            throw CodeRemoteError.unsupportedCommand(kind)
        }
        let body: [String: JunoJSONValue] = [
            "sessionID": .string(sessionID),
            "kind": .string(kind),
            "payload": .object(payload),
            "idempotencyKey": .string(idempotencyKey),
        ]
        let response = try await post(
            "/api/code/devices/\(deviceID)/commands", body: .object(body), for: accountID
        )
        guard let root = try decodeObject(response),
            case .object(let command)? = root["command"]
        else { throw CodeRemoteError.malformedResponse }
        return try decodeCommand(.object(command))
    }

    /// Reads events strictly after `afterSequence`.
    ///
    /// The cursor is what makes reconnecting cheap and correct: a phone that
    /// drops its connection resumes from the last sequence it applied rather
    /// than refetching a transcript, and a replayed page is recognised as
    /// already-applied by sequence rather than by content.
    public func events(
        deviceID: String,
        sessionID: String,
        afterSequence: Int,
        for accountID: AccountID
    ) async throws -> [CodeRemoteSessionEvent] {
        try validate(deviceID)
        try validate(sessionID)
        let path = "/api/code/devices/\(deviceID)/sessions/\(sessionID)/events?after=\(afterSequence)"
        let response = try await get(path, for: accountID)
        guard let root = try decodeObject(response),
            case .array(let items)? = root["events"]
        else { throw CodeRemoteError.malformedResponse }
        return try items.map(decodeEvent)
    }

    // MARK: - Host side

    /// Long-polls for the next command. Returns `nil` when the poll window
    /// closes with nothing queued, which is the normal idle case and not an
    /// error.
    public func claimNextCommand(
        deviceID: String,
        for accountID: AccountID
    ) async throws -> CodeRemoteCommand? {
        try validate(deviceID)
        let response = try await get("/api/code/devices/\(deviceID)/commands", for: accountID)
        guard let root = try decodeObject(response) else {
            throw CodeRemoteError.malformedResponse
        }
        guard case .object(let command)? = root["command"] else { return nil }
        return try decodeCommand(.object(command))
    }

    public func acknowledgeCommand(
        deviceID: String,
        commandID: String,
        status: String,
        result: [String: JunoJSONValue]?,
        error: String?,
        for accountID: AccountID
    ) async throws {
        try validate(deviceID)
        var body: [String: JunoJSONValue] = [
            "commandId": .string(commandID),
            "status": .string(status),
        ]
        if let result { body["result"] = .object(result) }
        if let error { body["error"] = .string(error) }
        _ = try await post(
            "/api/code/devices/\(deviceID)/commands", body: .object(body), for: accountID
        )
    }

    public func postEvents(
        deviceID: String,
        sessionID: String,
        events: [CodeRemoteSessionEvent],
        for accountID: AccountID
    ) async throws {
        try validate(deviceID)
        try validate(sessionID)
        let encoded = JunoJSONValue.array(events.map { event in
            .object([
                "seq": .number(Double(event.seq)),
                "kind": .string(event.kind),
                "payload": .object(event.payload),
            ])
        })
        _ = try await post(
            "/api/code/devices/\(deviceID)/sessions/\(sessionID)/events",
            body: .object(["events": encoded]),
            for: accountID
        )
    }

    // MARK: - Transport

    private func get(_ path: String, for accountID: AccountID) async throws -> HTTPResponse {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try require2xx(response)
        return response
    }

    private func post(
        _ path: String, body: JunoJSONValue, for accountID: AccountID
    ) async throws -> HTTPResponse {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        try require2xx(response)
        return response
    }

    private func require2xx(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let message = (try? decodeObject(response))
            .flatMap { root -> String? in
                if case .string(let value)? = root["error"] { return value }
                return nil
            }
        throw CodeRemoteError.server(
            statusCode: response.statusCode,
            message: message ?? "Juno could not reach that Code session (\(response.statusCode)).",
            // 5xx is worth another attempt; a 4xx means this request is wrong
            // and will stay wrong.
            retryable: (500...599).contains(response.statusCode)
        )
    }

    /// Identifiers go straight into a URL path, so anything that could change
    /// the path's meaning is refused before it gets there. A `..` segment or an
    /// encoded slash would address a different route entirely.
    private func validate(_ identifier: String) throws {
        guard !identifier.isEmpty, identifier.count <= 200,
            !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#"),
            identifier.allSatisfy({ !$0.isWhitespace && !$0.isNewline })
        else { throw CodeRemoteError.invalidIdentifier }
    }

    private func decodeObject(_ response: HTTPResponse) throws -> [String: JunoJSONValue]? {
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: response.body),
            case .object(let object) = value
        else { return nil }
        return object
    }

    private func decodeSummary(_ value: JunoJSONValue) throws -> CodeRemoteSessionSummary {
        guard case .object(let object) = value,
            case .string(let sessionID)? = object["sessionID"],
            case .string(let deviceID)? = object["deviceID"],
            case .string(let title)? = object["title"],
            case .string(let modelID)? = object["modelID"],
            case .string(let permissionMode)? = object["permissionMode"],
            case .string(let currentStatus)? = object["currentStatus"],
            let updatedAt = object["updatedAt"]?.date,
            let lastMessageAt = object["lastMessageAt"]?.date
        else { throw CodeRemoteError.malformedResponse }

        return CodeRemoteSessionSummary(
            sessionID: sessionID,
            deviceID: deviceID,
            workspaceKey: object["workspaceKey"]?.stringValue,
            workspaceName: object["workspaceName"]?.stringValue,
            title: title,
            modelID: modelID,
            permissionMode: permissionMode,
            currentStatus: currentStatus,
            isRunning: object["isRunning"]?.boolValue ?? false,
            isAwaitingApproval: object["isAwaitingApproval"]?.boolValue ?? false,
            pendingChangeCount: Int(object["pendingChangeCount"]?.numberValue ?? 0),
            activeBranch: object["activeBranch"]?.stringValue,
            lastError: object["lastError"]?.stringValue,
            lastEventSequence: Int(object["lastEventSequence"]?.numberValue ?? 0),
            updatedAt: updatedAt,
            lastMessageAt: lastMessageAt,
            fresh: object["fresh"]?.boolValue
        )
    }

    /// Workspace *names* only. The route strips paths before serialising —
    /// disclosing an absolute workspace path was a fixed security defect — and
    /// `CodeRemoteHostSummary` has nowhere to put one.
    private func decodeHost(_ value: JunoJSONValue) throws -> CodeRemoteHostSummary {
        guard case .object(let object) = value,
            case .string(let id)? = object["id"],
            case .string(let name)? = object["name"],
            case .string(let platform)? = object["platform"],
            let lastSeenAt = object["lastSeenAt"]?.date
        else { throw CodeRemoteError.malformedResponse }

        var workspaceNames: [String] = []
        if case .array(let raw)? = object["workspaces"] {
            workspaceNames = raw.compactMap { entry in
                if case .object(let workspace) = entry { return workspace["name"]?.stringValue }
                return entry.stringValue
            }
        }

        return CodeRemoteHostSummary(
            id: id,
            name: name,
            platform: platform,
            workspaceNames: workspaceNames,
            online: object["online"]?.boolValue ?? false,
            lastSeenAt: lastSeenAt
        )
    }

    private func decodeCommand(_ value: JunoJSONValue) throws -> CodeRemoteCommand {
        guard case .object(let object) = value,
            case .string(let id)? = object["id"],
            case .string(let sessionID)? = object["sessionID"],
            case .string(let kind)? = object["kind"],
            case .string(let status)? = object["status"]
        else { throw CodeRemoteError.malformedResponse }
        var payload: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["payload"] { payload = raw }
        return CodeRemoteCommand(
            id: id, sessionID: sessionID, kind: kind, payload: payload, status: status
        )
    }

    private func decodeEvent(_ value: JunoJSONValue) throws -> CodeRemoteSessionEvent {
        guard case .object(let object) = value,
            let seq = object["seq"]?.numberValue,
            case .string(let kind)? = object["kind"],
            let createdAt = object["createdAt"]?.date
        else { throw CodeRemoteError.malformedResponse }
        var payload: [String: JunoJSONValue] = [:]
        if case .object(let raw)? = object["payload"] { payload = raw }
        return CodeRemoteSessionEvent(
            seq: Int(seq), kind: kind, payload: payload, createdAt: createdAt
        )
    }
}
