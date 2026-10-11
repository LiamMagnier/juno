import Foundation
import JunoAPI
import JunoAuth
import JunoCodeCore
import JunoCore
import JunoSync

// The iPhone's side of the v2 device link (docs/code-v2/DEVICE-LINK.md,
// docs/code-v2/REMOTE-CONTROL.md): one route, two kinds of request.
//
//   POST /api/code/v2/link/<deviceId> {kind:"rpc", command}  → {responses:[ServerResponse]} | {offline, message}
//   POST /api/code/v2/link/<deviceId> {kind:"poll", cursors, globalCursor} → {events:[…]} | {offline, message}
//   POST /api/code/v2/link/<deviceId>/stream {cursors, globalCursor} → text/event-stream of the same replies
//
// The stream is the fast path: one response stays open and every batch the
// Mac pushes is written into it at once (no request, sign-in or pair lookup
// per batch). A backend without it answers 404 or 405 and the poll is used.
//
// 403 {code:"not_paired"} means this iPhone holds no live pair with that Mac;
// 404 means the Mac is not (or no longer) on the account.

/// Why a link request did not produce an answer.
public enum CodeLinkError: Error, Equatable, Sendable, LocalizedError {
    /// No live pair between this iPhone and the Mac: pair it from the Mac.
    case notPaired(message: String)
    /// The Mac is not on this account any more.
    case unpairedMac
    /// The Mac has not checked in recently.
    case offline(message: String)
    /// The Mac (or the env server on it) refused the command.
    case refused(code: CodeV2.WireErrorCode, message: String)
    /// The backend answered with an unexpected status.
    case http(status: Int, message: String?)
    /// The answer could not be read.
    case malformed(String)
    /// Nothing came back in time.
    case timedOut

    public var errorDescription: String? {
        switch self {
        case let .notPaired(message): message
        case .unpairedMac: "This Mac is no longer on your account."
        case let .offline(message): message
        case let .refused(_, message): message
        case let .http(status, message): message ?? "Alevr could not reach your Mac (\(status))."
        case let .malformed(type): "Your Mac sent an unreadable answer to \(type)."
        case .timedOut: "Your Mac did not answer in time."
        }
    }

    public var isNotPaired: Bool {
        if case .notPaired = self { return true }
        return false
    }

    public var isOffline: Bool {
        if case .offline = self { return true }
        return false
    }
}

/// The device link for one account, over the app's authenticated sender.
public struct CodeLinkClient: Sendable {
    /// The poll waits up to 20 s on the server; give it room.
    public static let pollTimeout: Duration = .seconds(30)
    /// RPCs wait up to 30 s for the Mac on the server.
    public static let rpcTimeout: Duration = .seconds(36)

    private let sender: any NativeAuthenticatedRequestSending
    /// The push stream's transport: the sender itself when it can stream bytes.
    private let streamer: (any NativeAuthenticatedByteStreaming)?
    public let accountID: AccountID
    private let makeID: @Sendable () -> String

    public init(
        sender: any NativeAuthenticatedRequestSending,
        accountID: AccountID,
        streamer: (any NativeAuthenticatedByteStreaming)? = nil,
        makeID: @escaping @Sendable () -> String = { "iphone-" + UUID().uuidString.lowercased() }
    ) {
        self.sender = sender
        self.streamer = streamer ?? (sender as? any NativeAuthenticatedByteStreaming)
        self.accountID = accountID
        self.makeID = makeID
    }

    /// Whether the push stream can be tried at all.
    public var canStream: Bool { streamer != nil }

    // MARK: Wire

    static func path(_ deviceID: String) -> String {
        let segment = deviceID.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))
        ) ?? deviceID
        return "/api/code/v2/link/\(segment)"
    }

    /// The `{kind:"rpc"}` body for one command.
    public static func rpcBody(_ command: CodeV2.ClientCommand) throws -> Data {
        struct Body: Encodable {
            let kind = "rpc"
            let command: CodeV2.ClientCommand
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Body(command: command))
    }

    /// The `{kind:"poll"}` body: one cursor per followed session (-1 before its snapshot).
    public static func pollBody(cursors: [String: Int], globalCursor: Int) throws -> Data {
        struct Body: Encodable {
            let kind = "poll"
            let cursors: [String: Int]
            let globalCursor: Int
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Body(cursors: cursors, globalCursor: globalCursor))
    }

    private struct Reply: Decodable {
        let responses: [CodeV2.ServerResponse]?
        let events: [CodeV2.ServerEventEnvelope]?
        let offline: Bool?
        let message: String?

        enum CodingKeys: String, CodingKey { case responses, events, offline, message }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            responses = try c.decodeIfPresent([CodeV2.ServerResponse].self, forKey: .responses)
            // One event this build cannot read must not sink the whole batch
            // (every later poll would fail on it again): it is skipped, the
            // reducer sees a gap and re-opens from its cursor.
            events = try c.decodeIfPresent([Lenient].self, forKey: .events)?.compactMap(\.value)
            offline = try c.decodeIfPresent(Bool.self, forKey: .offline)
            message = try c.decodeIfPresent(String.self, forKey: .message)
        }
    }

    /// One event, or nil when it does not decode.
    struct Lenient: Decodable {
        let value: CodeV2.ServerEventEnvelope?
        init(from decoder: any Decoder) throws {
            value = try? CodeV2.ServerEventEnvelope(from: decoder)
        }
    }

    private struct ErrorReply: Decodable {
        let error: String?
        let message: String?
        let code: String?
    }

    /// Maps a non-2xx reply to the error the UI acts on.
    public static func error(status: Int, body: Data) -> CodeLinkError {
        let wire = try? JSONDecoder().decode(ErrorReply.self, from: body)
        let message = wire?.message ?? wire?.error
        if status == 403, wire?.code == "not_paired" {
            return .notPaired(message: message ?? "This iPhone is not paired with that Mac.")
        }
        if status == 404 { return .unpairedMac }
        return .http(status: status, message: message)
    }

    private func post(_ deviceID: String, body: Data, timeout: Duration) async throws -> Reply {
        let request = try NativeBearerRequest(
            path: Self.path(deviceID),
            method: .post,
            headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
            body: body
        )
        let sender = self.sender
        let accountID = self.accountID
        let response = try await Self.withTimeout(timeout) {
            try await sender.send(request, for: accountID)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw Self.error(status: response.statusCode, body: response.body)
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: response.body) else {
            throw CodeLinkError.malformed("the link")
        }
        if reply.offline == true {
            throw CodeLinkError.offline(message: reply.message ?? "Your Mac did not answer. Open Alevr on it, or check that it is awake.")
        }
        return reply
    }

    static func withTimeout<T: Sendable>(_ limit: Duration, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(for: limit)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let value = first else { throw CodeLinkError.timedOut }
            return value
        }
    }

    // MARK: RPC

    /// Relays one command and returns its result (nil for an empty answer).
    @discardableResult
    public func send(_ type: CodeV2.ClientCommandType, params: some Encodable, to deviceID: String) async throws -> JSONValue? {
        let command = CodeV2.ClientCommand(id: makeID(), type: type, params: try CodeV2.ClientCommand.encodeParams(params))
        let reply = try await post(deviceID, body: Self.rpcBody(command), timeout: Self.rpcTimeout)
        guard let response = reply.responses?.first(where: { $0.id == command.id }) ?? reply.responses?.first else {
            throw CodeLinkError.malformed(type.rawValue)
        }
        guard response.ok else {
            throw CodeLinkError.refused(
                code: response.error?.code ?? .internal,
                message: response.error?.message ?? "Your Mac could not do that."
            )
        }
        return response.result
    }

    public func request<Result: Decodable>(
        _ type: CodeV2.ClientCommandType, params: some Encodable, as: Result.Type, to deviceID: String
    ) async throws -> Result {
        let value = try await send(type, params: params, to: deviceID) ?? .object([:])
        do {
            return try JSONDecoder().decode(Result.self, from: JSONEncoder().encode(value))
        } catch {
            throw CodeLinkError.malformed(type.rawValue)
        }
    }

    // MARK: Poll

    /// Every event after the cursors. Waits on the server when there are none.
    public func poll(_ deviceID: String, cursors: [String: Int], globalCursor: Int) async throws -> [CodeV2.ServerEventEnvelope] {
        let reply = try await post(deviceID, body: Self.pollBody(cursors: cursors, globalCursor: globalCursor), timeout: Self.pollTimeout)
        return reply.events ?? []
    }

    // MARK: Stream

    /// The backend has no push stream (an older deployment): poll instead.
    public struct StreamUnavailable: Error, Equatable, Sendable {}

    /// The stream's body: the cursors it starts from.
    public static func streamBody(cursors: [String: Int], globalCursor: Int) throws -> Data {
        struct Body: Encodable {
            let cursors: [String: Int]
            let globalCursor: Int
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Body(cursors: cursors, globalCursor: globalCursor))
    }

    /// Opens the push stream: each element is one batch, the moment the Mac
    /// pushed it. Ends when the backend closes its window (open it again at
    /// once); throws `.offline`, `.notPaired` and the like as the poll does,
    /// and ``StreamUnavailable`` when the backend has no stream.
    public func stream(
        _ deviceID: String, cursors: [String: Int], globalCursor: Int
    ) async throws -> AsyncThrowingStream<[CodeV2.ServerEventEnvelope], any Error> {
        guard let streamer else { throw StreamUnavailable() }
        let request = try NativeBearerRequest(
            path: Self.path(deviceID) + "/stream",
            method: .post,
            headers: try HTTPHeaders(["accept": "text/event-stream", "content-type": "application/json"]),
            body: try Self.streamBody(cursors: cursors, globalCursor: globalCursor)
        )
        let accountID = self.accountID
        let response = try await Self.withTimeout(Self.rpcTimeout) { try await streamer.stream(request, for: accountID) }
        let type = response.headers["content-type"]?.lowercased() ?? ""
        if response.statusCode == 405 || (response.statusCode == 404 && !type.contains("json")) { throw StreamUnavailable() }
        guard (200..<300).contains(response.statusCode) else {
            var body = Data()
            for try await byte in response.bytes {
                body.append(byte)
                if body.count > 16_384 { break }
            }
            throw Self.error(status: response.statusCode, body: body)
        }
        guard type.hasPrefix("text/event-stream") else { throw StreamUnavailable() }
        return AsyncThrowingStream { continuation in
            let relay = Task {
                var parser = CodeLinkSSEParser()
                do {
                    for try await byte in response.bytes {
                        guard let payload = parser.consume(byte) else { continue }
                        guard let reply = try? JSONDecoder().decode(StreamFrame.self, from: payload) else {
                            throw CodeLinkError.malformed("the link stream")
                        }
                        if reply.offline == true {
                            throw CodeLinkError.offline(message: reply.message ?? "Your Mac did not answer. Open Alevr on it, or check that it is awake.")
                        }
                        if let error = reply.error { throw CodeLinkError.notPaired(message: error) }
                        let events = reply.events?.compactMap(\.value) ?? []
                        if !events.isEmpty { continuation.yield(events) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    private struct StreamFrame: Decodable {
        let events: [Lenient]?
        let offline: Bool?
        let message: String?
        let error: String?
    }
}

/// Server-Sent Events, as the link stream writes them: `data:` lines joined
/// until a blank line ends the frame; `:` comments (heartbeats) ignored.
public struct CodeLinkSSEParser: Sendable {
    private var line: [UInt8] = []
    private var data: [UInt8] = []
    private var hasData = false
    /// The longest frame accepted (a batch of up to 1,000 events).
    public static let maxFrame = 8 * 1024 * 1024

    public init() {}

    /// Feeds one byte; returns a frame's payload when this byte ended it.
    public mutating func consume(_ byte: UInt8) -> Data? {
        if byte != 0x0A {
            if byte != 0x0D, line.count < Self.maxFrame { line.append(byte) }
            return nil
        }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            guard hasData else { return nil }
            let payload = Data(data)
            data.removeAll(keepingCapacity: true)
            hasData = false
            return payload
        }
        if line.first == 0x3A { return nil } // ":" comment
        let prefix: [UInt8] = Array("data:".utf8)
        guard line.starts(with: prefix) else { return nil }
        var value = line.dropFirst(prefix.count)
        if value.first == 0x20 { value = value.dropFirst() }
        if hasData { data.append(0x0A) }
        if data.count + value.count <= Self.maxFrame { data.append(contentsOf: value) }
        hasData = true
        return nil
    }
}

// MARK: - Typed commands

public struct CodeLinkEmpty: Codable, Sendable { public init() {} }

public extension CodeLinkClient {
    struct SessionsResult: Decodable, Sendable { public let sessions: [CodeV2.SessionSummary] }
    struct SessionOpenResult: Decodable, Sendable { public let sessionId: String }
    struct TurnStartResult: Decodable, Sendable { public let turnId: String }
    struct SteerResult: Decodable, Sendable { public let accepted: Bool }
    struct QueueResult: Decodable, Sendable { public let queuedId: String }
    struct DiffResult: Decodable, Sendable, Equatable {
        public let diff: String
        public let files: [CodeV2.FileChangeEntry]
    }
    struct ApplyPatchResult: Decodable, Sendable, Equatable {
        public let applied: Bool
        public let files: [String]
    }
    struct InstancesResult: Decodable, Sendable { public let instances: [CodeV2.ProviderInstance] }
    struct InstanceResult: Decodable, Sendable { public let instance: CodeV2.ProviderInstance }
    struct RemovedProject: Decodable, Sendable { public let sessionIds: [String] }

    func providerProbe(_ deviceID: String, instanceId: String, maxAgeMs: Int = 30_000) async throws -> CodeV2.ProviderInstance {
        struct P: Encodable { let instanceId: String; let maxAgeMs: Int }
        return try await request(.providerProbe, params: P(instanceId: instanceId, maxAgeMs: maxAgeMs), as: InstanceResult.self, to: deviceID).instance
    }

    func removeProject(_ deviceID: String, cwd: String) async throws -> [String] {
        struct P: Encodable { let cwd: String }
        return try await request(.projectRemove, params: P(cwd: cwd), as: RemovedProject.self, to: deviceID).sessionIds
    }
    struct SkillsResult: Decodable, Sendable { public let skills: [CodeV2.LocalSkillSummary] }
    struct TerminalResult: Decodable, Sendable { public let terminalId: String }
    struct CommitResult: Decodable, Sendable, Equatable { public let sha: String; public let summary: String }
    struct PushResult: Decodable, Sendable, Equatable { public let branch: String; public let remote: String }
    struct PullRequestResult: Decodable, Sendable, Equatable { public let url: String }

    /// `turn.start`'s params, kept as a value so the composer's choice can be tested.
    struct TurnStartParams: Codable, Sendable, Equatable {
        public var sessionId: String
        public var input: CodeV2.UserInput
        public var selection: CodeV2.ModelSelection
        public var routing: CodeV2.RoleRouting?
        public var runtimeMode: CodeV2.RuntimeMode
        public var interactionMode: CodeV2.InteractionMode

        public init(
            sessionId: String, input: CodeV2.UserInput, selection: CodeV2.ModelSelection,
            routing: CodeV2.RoleRouting?, runtimeMode: CodeV2.RuntimeMode, interactionMode: CodeV2.InteractionMode
        ) {
            self.sessionId = sessionId
            self.input = input
            self.selection = selection
            self.routing = routing
            self.runtimeMode = runtimeMode
            self.interactionMode = interactionMode
        }
    }

    func sessionList(_ deviceID: String, cwd: String? = nil, limit: Int? = nil) async throws -> [CodeV2.SessionSummary] {
        struct P: Encodable { let cwd: String?; let limit: Int? }
        return try await request(.sessionList, params: P(cwd: cwd, limit: limit), as: SessionsResult.self, to: deviceID).sessions
    }

    @discardableResult
    func sessionOpen(
        _ deviceID: String, sessionId: String?, cwd: String, selection: CodeV2.ModelSelection? = nil,
        afterSequence: Int? = nil, worktree: Bool? = nil, runtimeMode: CodeV2.RuntimeMode? = nil
    ) async throws -> String {
        struct P: Encodable {
            let sessionId: String?
            let cwd: String
            let selection: CodeV2.ModelSelection?
            let afterSequence: Int?
            let worktree: Bool?
            let runtimeMode: CodeV2.RuntimeMode?
        }
        return try await request(
            .sessionOpen,
            params: P(
                sessionId: sessionId, cwd: cwd, selection: selection, afterSequence: afterSequence,
                worktree: worktree, runtimeMode: runtimeMode
            ),
            as: SessionOpenResult.self, to: deviceID
        ).sessionId
    }

    /// The access picker changed: the Mac applies it to the thread now (a
    /// running turn and its waiting approvals included), not at the next message.
    func sessionSetMode(
        _ deviceID: String, sessionId: String, runtimeMode: CodeV2.RuntimeMode, interactionMode: CodeV2.InteractionMode
    ) async throws {
        struct P: Encodable {
            let sessionId: String
            let runtimeMode: CodeV2.RuntimeMode
            let interactionMode: CodeV2.InteractionMode
        }
        try await send(.sessionSetMode, params: P(sessionId: sessionId, runtimeMode: runtimeMode, interactionMode: interactionMode), to: deviceID)
    }

    @discardableResult
    func turnStart(_ deviceID: String, _ params: TurnStartParams) async throws -> String {
        try await request(.turnStart, params: params, as: TurnStartResult.self, to: deviceID).turnId
    }

    func turnSteer(_ deviceID: String, sessionId: String, turnId: String, input: CodeV2.UserInput) async throws -> Bool {
        struct P: Encodable { let sessionId: String; let turnId: String; let input: CodeV2.UserInput }
        return try await request(.turnSteer, params: P(sessionId: sessionId, turnId: turnId, input: input), as: SteerResult.self, to: deviceID).accepted
    }

    @discardableResult
    func turnQueue(_ deviceID: String, sessionId: String, input: CodeV2.UserInput) async throws -> String {
        struct P: Encodable { let sessionId: String; let input: CodeV2.UserInput }
        return try await request(.turnQueue, params: P(sessionId: sessionId, input: input), as: QueueResult.self, to: deviceID).queuedId
    }

    func turnInterrupt(_ deviceID: String, sessionId: String, turnId: String?) async throws {
        struct P: Encodable { let sessionId: String; let turnId: String? }
        try await send(.turnInterrupt, params: P(sessionId: sessionId, turnId: turnId), to: deviceID)
    }

    func approvalRespond(
        _ deviceID: String, sessionId: String, requestId: String, decision: CodeV2.ApprovalDecision,
        answers: [String: [String]]? = nil
    ) async throws {
        struct P: Encodable {
            let sessionId: String
            let requestId: String
            let decision: CodeV2.ApprovalDecision
            let answers: [String: [String]]?
        }
        try await send(.approvalRespond, params: P(sessionId: sessionId, requestId: requestId, decision: decision, answers: answers), to: deviceID)
    }

    func checkpointDiff(_ deviceID: String, sessionId: String, checkpointId: String?) async throws -> DiffResult {
        struct P: Encodable { let sessionId: String; let checkpointId: String? }
        return try await request(.checkpointDiff, params: P(sessionId: sessionId, checkpointId: checkpointId), as: DiffResult.self, to: deviceID)
    }

    @discardableResult
    func checkpointApplyPatch(
        _ deviceID: String, sessionId: String, patch: String, reverse: Bool, checkOnly: Bool = false
    ) async throws -> ApplyPatchResult {
        struct P: Encodable { let sessionId: String; let patch: String; let reverse: Bool?; let checkOnly: Bool? }
        return try await request(
            .checkpointApplyPatch,
            params: P(sessionId: sessionId, patch: patch, reverse: reverse ? true : nil, checkOnly: checkOnly ? true : nil),
            as: ApplyPatchResult.self, to: deviceID
        )
    }

    func providerList(_ deviceID: String) async throws -> [CodeV2.ProviderInstance] {
        try await request(.providerList, params: CodeLinkEmpty(), as: InstancesResult.self, to: deviceID).instances
    }

    func skillsList(_ deviceID: String, sessionId: String? = nil, cwd: String? = nil) async throws -> [CodeV2.LocalSkillSummary] {
        struct P: Encodable { let cwd: String?; let sessionId: String? }
        return try await request(.skillsList, params: P(cwd: cwd, sessionId: sessionId), as: SkillsResult.self, to: deviceID).skills
    }

    func terminalOpen(_ deviceID: String, cwd: String, cols: Int, rows: Int) async throws -> String {
        struct P: Encodable { let cwd: String; let cols: Int; let rows: Int }
        return try await request(.terminalOpen, params: P(cwd: cwd, cols: cols, rows: rows), as: TerminalResult.self, to: deviceID).terminalId
    }

    func terminalWrite(_ deviceID: String, terminalId: String, data: String) async throws {
        struct P: Encodable { let terminalId: String; let data: String }
        try await send(.terminalWrite, params: P(terminalId: terminalId, data: data), to: deviceID)
    }

    func terminalResize(_ deviceID: String, terminalId: String, cols: Int, rows: Int) async throws {
        struct P: Encodable { let terminalId: String; let cols: Int; let rows: Int }
        try await send(.terminalResize, params: P(terminalId: terminalId, cols: cols, rows: rows), to: deviceID)
    }

    func terminalClose(_ deviceID: String, terminalId: String) async throws {
        struct P: Encodable { let terminalId: String }
        try await send(.terminalClose, params: P(terminalId: terminalId), to: deviceID)
    }

    func hostInfo(_ deviceID: String) async throws -> CodeV2.HostInfo {
        try await request(.hostInfo, params: CodeLinkEmpty(), as: CodeV2.HostInfo.self, to: deviceID)
    }

    func hostCapture(_ deviceID: String, target: CodeV2.RemoteCaptureTarget) async throws -> CodeV2.HostCapture {
        struct P: Encodable { let target: CodeV2.RemoteCaptureTarget }
        return try await request(.hostCapture, params: P(target: target), as: CodeV2.HostCapture.self, to: deviceID)
    }

    /// Hands the Mac a file attached on this device; its answer's `ref` is the path the agent reads.
    func hostUpload(_ deviceID: String, name: String, mediaType: String, data: Data) async throws -> CodeV2.HostUpload {
        struct P: Encodable { let name: String; let mediaType: String; let data: String }
        return try await request(
            .hostUpload, params: P(name: name, mediaType: mediaType, data: data.base64EncodedString()),
            as: CodeV2.HostUpload.self, to: deviceID
        )
    }

    func gitStatus(_ deviceID: String, sessionId: String) async throws -> CodeV2.GitStatusResult {
        struct P: Encodable { let sessionId: String }
        return try await request(.gitStatus, params: P(sessionId: sessionId), as: CodeV2.GitStatusResult.self, to: deviceID)
    }

    func gitCommit(_ deviceID: String, sessionId: String, message: String) async throws -> CommitResult {
        struct P: Encodable { let sessionId: String; let message: String }
        return try await request(.gitCommit, params: P(sessionId: sessionId, message: message), as: CommitResult.self, to: deviceID)
    }

    func gitPush(_ deviceID: String, sessionId: String) async throws -> PushResult {
        struct P: Encodable { let sessionId: String }
        return try await request(.gitPush, params: P(sessionId: sessionId), as: PushResult.self, to: deviceID)
    }

    func gitPullRequest(
        _ deviceID: String, sessionId: String, title: String, body: String? = nil, draft: Bool? = nil
    ) async throws -> PullRequestResult {
        struct P: Encodable { let sessionId: String; let title: String; let body: String?; let draft: Bool? }
        return try await request(.gitPr, params: P(sessionId: sessionId, title: title, body: body, draft: draft), as: PullRequestResult.self, to: deviceID)
    }

    func fsList(_ deviceID: String, path: String) async throws -> CodeV2.FsListing {
        struct P: Encodable { let path: String }
        return try await request(.fsList, params: P(path: path), as: CodeV2.FsListing.self, to: deviceID)
    }
}

public extension CodeV2.HostCapture {
    /// The PNG's bytes, nil when `data` is not base64.
    var imageData: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }
}
