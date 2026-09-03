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
public struct CodeRemoteSessionSummary: Equatable, Hashable, Sendable, Identifiable {
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
    /// The reasoning effort the session runs at, when the host reports one.
    public let reasoningEffort: String?
    /// The project the workspace belongs to, when the host named one.
    public let projectName: String?

    public var id: String { sessionID }

    public init(
        sessionID: String, deviceID: String, workspaceKey: String?, workspaceName: String?,
        title: String, modelID: String, permissionMode: String, currentStatus: String,
        isRunning: Bool, isAwaitingApproval: Bool, pendingChangeCount: Int,
        activeBranch: String?, lastError: String?, lastEventSequence: Int,
        updatedAt: Date, lastMessageAt: Date, fresh: Bool?,
        reasoningEffort: String? = nil, projectName: String? = nil
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
        self.reasoningEffort = reasoningEffort
        self.projectName = projectName
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
    case invalidEventStream
    case eventStreamUnavailable
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: "Juno could not safely address that device or session."
        case .unsupportedCommand(let kind): "This build cannot send a \"\(kind)\" command."
        case .malformedResponse: "Juno returned invalid remote session data."
        case .invalidEventStream: "Juno returned an invalid Code event stream."
        case .eventStreamUnavailable: "This Juno build cannot open a live Code event stream."
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
        "create_session", "message", "stop", "approval", "patch", "delete", "fork", "retry",
        "accept_change", "reject_change", "undo_change", "run_tests",
        "stop_tests", "git", "stop_agent",
    ]

    private let sender: any NativeAuthenticatedRequestSending
    /// Optional only while older host integrations are being migrated. New
    /// production clients provide this and use the relay's resumable SSE feed;
    /// `events` remains a bounded compatibility read for previews and legacy
    /// callers that cannot yet open a byte stream.
    private let streamer: (any NativeAuthenticatedByteStreaming)?

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: (any NativeAuthenticatedByteStreaming)? = nil
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    // MARK: - Mobile side

    /// Revokes one paired computer: the relay deletes the host's row and every
    /// device-scoped relay row under it, so the Mac stops being listed and its
    /// claim loop meets a refusal it treats as terminal rather than a host it
    /// keeps polling for.
    ///
    /// The versioned path is deliberate. The sibling inventory still lives
    /// under `/api` with a per-operation contract override; revocation is new
    /// surface, so it starts on `/api/v1` where the contract needs no override
    /// to describe it.
    public func revokeDevice(
        deviceID: String,
        for accountID: AccountID
    ) async throws {
        try validate(deviceID)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/v1/code/devices/\(deviceID)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try require2xx(response)
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
        // The server's resumable event endpoint reads `afterSeq`. `after` was
        // silently ignored, causing every reconnect to fetch from zero and
        // making a long-running mobile session increasingly expensive.
        let path = "/api/code/devices/\(deviceID)/sessions/\(sessionID)/events?afterSeq=\(afterSequence)"
        let response = try await get(path, for: accountID)
        guard let root = try decodeObject(response),
            case .array(let items)? = root["events"]
        else { throw CodeRemoteError.malformedResponse }
        return try items.map(decodeEvent)
    }

    /// Opens the relay's authenticated, resumable Server-Sent Event feed.
    ///
    /// Every yielded page contains events strictly after the supplied cursor.
    /// The caller owns durable folding because it is the only layer that knows
    /// whether a newly selected session invalidated its old cursor. A stream
    /// ending normally is expected: the relay deliberately rotates connections
    /// before platform request limits, and callers reconnect from their cursor.
    public func eventStream(
        deviceID: String,
        sessionID: String,
        afterSequence: Int,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<[CodeRemoteSessionEvent], any Error> {
        try validate(deviceID)
        try validate(sessionID)
        guard afterSequence >= 0, let streamer else {
            throw CodeRemoteError.eventStreamUnavailable
        }
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: "/api/code/devices/\(deviceID)/sessions/\(sessionID)/events?afterSeq=\(afterSequence)",
                headers: try HTTPHeaders(["accept": "text/event-stream"])
            ),
            for: accountID
        )
        try await require2xx(response)
        guard response.headers["content-type"]?.lowercased()
            .hasPrefix("text/event-stream") == true
        else { throw CodeRemoteError.invalidEventStream }

        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = CodeRemoteSSEParser()
                    for try await byte in response.bytes {
                        for frame in try parser.consume(byte) {
                            if let events = try decodeEventFrame(frame) {
                                continuation.yield(events)
                            }
                        }
                    }
                    for frame in try parser.finish() {
                        if let events = try decodeEventFrame(frame) {
                            continuation.yield(events)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
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

    private func require2xx(_ response: HTTPByteStreamResponse) async throws {
        guard !(200...299).contains(response.statusCode) else { return }
        var body = Data()
        for try await byte in response.bytes {
            guard body.count < 64 * 1_024 else { break }
            body.append(byte)
        }
        let message = (try? JSONDecoder().decode(JunoJSONValue.self, from: body))
            .flatMap { value -> String? in
                guard case .object(let object) = value,
                    case .string(let message)? = object["error"]
                else { return nil }
                return message
            }
        throw CodeRemoteError.server(
            statusCode: response.statusCode,
            message: message ?? "Juno could not reach that Code session (\(response.statusCode)).",
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
            fresh: object["fresh"]?.boolValue,
            reasoningEffort: object["reasoningEffort"]?.stringValue,
            projectName: object["projectName"]?.stringValue
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

    private func decodeEventFrame(_ frame: CodeRemoteSSEParser.Frame) throws
        -> [CodeRemoteSessionEvent]?
    {
        // The route originally used an unnamed `data:` frame. Accept that
        // transition shape as well as the explicit `events` name so clients
        // do not become coupled to an incidental SSE presentation detail.
        guard frame.name == "events" || frame.name == "message" else { return nil }
        guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: Data(frame.data.utf8)),
            case .object(let root) = value,
            case .string(let type)? = root["type"], type == "events",
            case .array(let rawEvents)? = root["events"]
        else { throw CodeRemoteError.invalidEventStream }
        let events = try rawEvents.map(decodeEvent)
        if let lastSeq = root["lastSeq"]?.numberValue,
            Int(lastSeq) != events.last?.seq
        {
            throw CodeRemoteError.invalidEventStream
        }
        return events
    }
}

/// Small, bounded SSE framing parser kept private to the Code relay contract.
/// It intentionally ignores comments/unknown fields but rejects malformed UTF-8
/// and unbounded lines before they can enter a rendered transcript.
private struct CodeRemoteSSEParser {
    struct Frame {
        let name: String
        let data: String
    }

    private var line = Data()
    private var eventName: String?
    private var dataLines: [String] = []

    mutating func consume(_ byte: UInt8) throws -> [Frame] {
        guard byte == 0x0A else {
            guard line.count < 8_192 else { throw CodeRemoteError.invalidEventStream }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() throws -> [Frame] {
        var result: [Frame] = []
        if !line.isEmpty { result.append(contentsOf: try finishLine()) }
        if eventName != nil || !dataLines.isEmpty { result.append(try dispatch()) }
        return result
    }

    private mutating func finishLine() throws -> [Frame] {
        if line.last == 0x0D { line.removeLast() }
        guard let value = String(data: line, encoding: .utf8) else {
            throw CodeRemoteError.invalidEventStream
        }
        line.removeAll(keepingCapacity: true)
        if value.isEmpty {
            guard eventName != nil || !dataLines.isEmpty else { return [] }
            return [try dispatch()]
        }
        if value.hasPrefix(":") { return [] }
        let pieces = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(pieces[0])
        var fieldValue = pieces.count == 2 ? String(pieces[1]) : ""
        if fieldValue.first == " " { fieldValue.removeFirst() }
        switch field {
        case "event": eventName = fieldValue
        case "data": dataLines.append(fieldValue)
        default: break
        }
        return []
    }

    private mutating func dispatch() throws -> Frame {
        guard !dataLines.isEmpty else { throw CodeRemoteError.invalidEventStream }
        let result = Frame(name: eventName ?? "message", data: dataLines.joined(separator: "\n"))
        eventName = nil
        dataLines.removeAll(keepingCapacity: true)
        return result
    }
}
