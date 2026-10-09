import Foundation
import JunoCodeCore

/// One text-frame duplex channel to the env server. The production transport
/// is a loopback WebSocket; tests use an in-memory pair.
public protocol EnvServerTransport: Sendable {
    func send(_ text: String) async throws
    /// The next text frame, or nil when the channel closed.
    func receive() async throws -> String?
    func close() async
}

/// `URLSessionWebSocketTask` with the bearer token in the `Authorization`
/// header (never in the URL, where logs and process lists would keep it).
public final class WebSocketEnvServerTransport: EnvServerTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession

    public init(url: URL, token: String) {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(CodeV2.protocolName, forHTTPHeaderField: "X-Alevr-Protocol")
        request.timeoutInterval = 30
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 64 * 1_024 * 1_024
        task.resume()
    }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func receive() async throws -> String? {
        do {
            switch try await task.receive() {
            case let .string(text): return text
            case let .data(data): return String(decoding: data, as: UTF8.self)
            @unknown default: return nil
            }
        } catch {
            if task.closeCode != .invalid { return nil }
            throw error
        }
    }

    public func close() async {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

/// A command as it goes on the wire, by its wire name.
private struct EnvServerRawCommand: Encodable {
    let id: String
    let type: String
    let params: JSONValue
}

public enum EnvServerConnectionError: Error, Equatable, LocalizedError, Sendable {
    case closed
    case timedOut(String)
    case server(CodeV2.WireErrorCode, String)
    case malformedResult(String)

    public var errorDescription: String? {
        switch self {
        case .closed: "The local environment server is not connected."
        case let .timedOut(type): "The local environment server did not answer \(type) in time."
        case let .server(_, message): message
        case let .malformedResult(type): "The local environment server sent an unreadable answer to \(type)."
        }
    }
}

/// The client half of the env-server wire (SPEC §3.1; `contracts/code/README.md`):
/// every command gets exactly one response matched by id; session events carry
/// a gap-free sequence and are fanned out to subscribers.
public actor EnvServerConnection {
    private let transport: any EnvServerTransport
    private let commandTimeout: Duration
    private var pending: [String: CheckedContinuation<CodeV2.ServerResponse, Error>] = [:]
    private var subscribers: [UUID: AsyncStream<CodeV2.ServerEventEnvelope>.Continuation] = [:]
    private var setupSubscribers: [UUID: AsyncStream<EnvRuntimeSetup.Update>.Continuation] = [:]
    private var receiveTask: Task<Void, Never>?
    private var nextID = 0
    private(set) public var isClosed = false

    public init(transport: any EnvServerTransport, commandTimeout: Duration = .seconds(30)) {
        self.transport = transport
        self.commandTimeout = commandTimeout
    }

    /// Starts reading frames. Idempotent.
    public func start() {
        guard receiveTask == nil, !isClosed else { return }
        receiveTask = Task { [weak self] in
            await self?.readLoop()
        }
    }

    public func close() async {
        guard !isClosed else { return }
        isClosed = true
        receiveTask?.cancel()
        await transport.close()
        fail(all: .closed)
        for continuation in subscribers.values { continuation.finish() }
        subscribers.removeAll()
        for continuation in setupSubscribers.values { continuation.finish() }
        setupSubscribers.removeAll()
    }

    /// Every event envelope, session and global streams alike.
    public func events() -> AsyncStream<CodeV2.ServerEventEnvelope> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<CodeV2.ServerEventEnvelope>.makeStream(bufferingPolicy: .unbounded)
        if isClosed {
            continuation.finish()
            return stream
        }
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        return stream
    }

    private func unsubscribe(_ id: UUID) { subscribers[id] = nil }

    /// Managed-runtime install and sign-in progress (Antigravity), read from
    /// `provider.updated` frames.
    public func runtimeSetupUpdates() -> AsyncStream<EnvRuntimeSetup.Update> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<EnvRuntimeSetup.Update>.makeStream(bufferingPolicy: .unbounded)
        if isClosed {
            continuation.finish()
            return stream
        }
        setupSubscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribeSetup(id) }
        }
        return stream
    }

    private func unsubscribeSetup(_ id: UUID) { setupSubscribers[id] = nil }

    private func readLoop() async {
        let decoder = JSONDecoder()
        while !Task.isCancelled {
            let frame: String?
            do {
                frame = try await transport.receive()
            } catch {
                break
            }
            guard let frame else { break }
            guard let data = frame.data(using: .utf8),
                  let message = try? decoder.decode(CodeV2.ServerMessage.self, from: data)
            else { continue }
            switch message {
            case let .response(response):
                pending.removeValue(forKey: response.id)?.resume(returning: response)
            case let .event(envelope):
                if case .providerUpdated = envelope.event, !setupSubscribers.isEmpty,
                   let update = EnvRuntimeSetup.update(fromFrame: frame) {
                    for continuation in setupSubscribers.values { continuation.yield(update) }
                }
                for continuation in subscribers.values { continuation.yield(envelope) }
            case .unknown:
                continue
            }
        }
        isClosed = true
        fail(all: .closed)
        for continuation in subscribers.values { continuation.finish() }
        subscribers.removeAll()
        for continuation in setupSubscribers.values { continuation.finish() }
        setupSubscribers.removeAll()
    }

    private func fail(all error: EnvServerConnectionError) {
        let waiting = pending
        pending.removeAll()
        for continuation in waiting.values { continuation.resume(throwing: error) }
    }

    // MARK: Commands

    /// Sends one command and waits for its response. Throws the server's
    /// error when `ok` is false.
    public func send(_ type: CodeV2.ClientCommandType, params: some Encodable) async throws -> JSONValue? {
        try await send(rawType: type.rawValue, params: params)
    }

    /// A command by its wire name: for commands newer than this build's
    /// contract mirror (the runtime lane's `provider.install`, `provider.auth`).
    public func send(rawType type: String, params: some Encodable) async throws -> JSONValue? {
        guard !isClosed else { throw EnvServerConnectionError.closed }
        start()
        nextID += 1
        let id = "mac-\(nextID)"
        let command = EnvServerRawCommand(id: id, type: type, params: try CodeV2.ClientCommand.encodeParams(params))
        let text = String(decoding: try JSONEncoder().encode(command), as: UTF8.self)
        let timeout = commandTimeout
        let response: CodeV2.ServerResponse = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do {
                    try await self.transport.send(text)
                } catch {
                    self.resolve(id, with: .failure(EnvServerConnectionError.closed))
                    return
                }
                try? await Task.sleep(for: timeout)
                self.resolve(id, with: .failure(EnvServerConnectionError.timedOut(type)))
            }
        }
        guard response.ok else {
            throw EnvServerConnectionError.server(response.error?.code ?? .internal, response.error?.message ?? "The request failed.")
        }
        return response.result
    }

    private func resolve(_ id: String, with result: Result<CodeV2.ServerResponse, Error>) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(with: result)
    }

    /// Sends a command and decodes its result.
    public func request<Result: Decodable>(
        _ type: CodeV2.ClientCommandType, params: some Encodable, as: Result.Type
    ) async throws -> Result {
        let value = try await send(type, params: params) ?? .object([:])
        do {
            return try JSONDecoder().decode(Result.self, from: JSONEncoder().encode(value))
        } catch {
            throw EnvServerConnectionError.malformedResult(type.rawValue)
        }
    }
}

// MARK: - Typed commands

public struct EnvServerEmpty: Codable, Sendable { public init() {} }

public extension EnvServerConnection {
    struct InstancesResult: Decodable, Sendable { public let instances: [CodeV2.ProviderInstance] }
    struct InstanceResult: Decodable, Sendable { public let instance: CodeV2.ProviderInstance }
    struct SetupResult: Decodable, Sendable { public let step: CodeV2.ProviderSetupStep? }
    struct SessionOpenResult: Decodable, Sendable { public let sessionId: String }
    struct TurnStartResult: Decodable, Sendable { public let turnId: String }
    struct SteerResult: Decodable, Sendable { public let accepted: Bool }
    struct QueueResult: Decodable, Sendable { public let queuedId: String }
    struct RollbackResult: Decodable, Sendable { public let restoredFiles: Int }
    struct DiffResult: Decodable, Sendable {
        public let diff: String
        public let files: [CodeV2.FileChangeEntry]
    }
    struct SessionsResult: Decodable, Sendable { public let sessions: [CodeV2.SessionSummary] }
    struct ApplyPatchResult: Decodable, Sendable {
        public let applied: Bool
        public let files: [String]
    }
    struct ScheduleResult: Decodable, Sendable { public let schedule: CodeV2.ScheduledResume }
    struct UnscheduleResult: Decodable, Sendable { public let cancelled: Bool }
    struct InstallResult: Decodable, Sendable { public let install: CodeV2.ProviderInstallState }
    struct AuthResult: Decodable, Sendable { public let auth: CodeV2.ProviderAuthState }
    struct TerminalResult: Decodable, Sendable { public let terminalId: String }

    func providerList() async throws -> [CodeV2.ProviderInstance] {
        try await request(.providerList, params: EnvServerEmpty(), as: InstancesResult.self).instances
    }

    func providerProbe(_ instanceId: String) async throws -> CodeV2.ProviderInstance {
        struct P: Encodable { let instanceId: String }
        return try await request(.providerProbe, params: P(instanceId: instanceId), as: InstanceResult.self).instance
    }

    func providerSetup(_ instanceId: String, action: CodeV2.ProviderSetupAction) async throws -> CodeV2.ProviderSetupStep? {
        struct P: Encodable { let instanceId: String; let action: CodeV2.ProviderSetupAction }
        return try await request(.providerSetup, params: P(instanceId: instanceId, action: action), as: SetupResult.self).step
    }

    func sessionOpen(sessionId: String?, cwd: String, selection: CodeV2.ModelSelection?, afterSequence: Int? = nil) async throws -> String {
        struct P: Encodable {
            let sessionId: String?
            let cwd: String
            let selection: CodeV2.ModelSelection?
            let afterSequence: Int?
        }
        return try await request(
            .sessionOpen, params: P(sessionId: sessionId, cwd: cwd, selection: selection, afterSequence: afterSequence),
            as: SessionOpenResult.self
        ).sessionId
    }

    func turnStart(
        sessionId: String, input: CodeV2.UserInput, selection: CodeV2.ModelSelection, routing: CodeV2.RoleRouting?,
        runtimeMode: CodeV2.RuntimeMode, interactionMode: CodeV2.InteractionMode
    ) async throws -> String {
        struct P: Encodable {
            let sessionId: String
            let input: CodeV2.UserInput
            let selection: CodeV2.ModelSelection
            let routing: CodeV2.RoleRouting?
            let runtimeMode: CodeV2.RuntimeMode
            let interactionMode: CodeV2.InteractionMode
        }
        return try await request(.turnStart, params: P(
            sessionId: sessionId, input: input, selection: selection, routing: routing,
            runtimeMode: runtimeMode, interactionMode: interactionMode
        ), as: TurnStartResult.self).turnId
    }

    func turnSteer(sessionId: String, turnId: String, input: CodeV2.UserInput) async throws -> Bool {
        struct P: Encodable { let sessionId: String; let turnId: String; let input: CodeV2.UserInput }
        return try await request(.turnSteer, params: P(sessionId: sessionId, turnId: turnId, input: input), as: SteerResult.self).accepted
    }

    func turnQueue(sessionId: String, input: CodeV2.UserInput) async throws -> String {
        struct P: Encodable { let sessionId: String; let input: CodeV2.UserInput }
        return try await request(.turnQueue, params: P(sessionId: sessionId, input: input), as: QueueResult.self).queuedId
    }

    func turnInterrupt(sessionId: String, turnId: String?) async throws {
        struct P: Encodable { let sessionId: String; let turnId: String? }
        _ = try await send(.turnInterrupt, params: P(sessionId: sessionId, turnId: turnId))
    }

    func approvalRespond(
        sessionId: String, requestId: String, decision: CodeV2.ApprovalDecision, answers: [String: [String]]? = nil
    ) async throws {
        struct P: Encodable {
            let sessionId: String
            let requestId: String
            let decision: CodeV2.ApprovalDecision
            let answers: [String: [String]]?
        }
        _ = try await send(.approvalRespond, params: P(sessionId: sessionId, requestId: requestId, decision: decision, answers: answers))
    }

    func checkpointRollback(sessionId: String, checkpointId: String) async throws -> Int {
        struct P: Encodable { let sessionId: String; let checkpointId: String }
        return try await request(.checkpointRollback, params: P(sessionId: sessionId, checkpointId: checkpointId), as: RollbackResult.self).restoredFiles
    }

    func checkpointDiff(sessionId: String, checkpointId: String?) async throws -> DiffResult {
        struct P: Encodable { let sessionId: String; let checkpointId: String? }
        return try await request(.checkpointDiff, params: P(sessionId: sessionId, checkpointId: checkpointId), as: DiffResult.self)
    }

    /// Applies a unified diff (or its reverse: a rejected hunk) in the
    /// session's own folder, all or nothing. Paths are repository-relative.
    func checkpointApplyPatch(sessionId: String, patch: String, reverse: Bool = false, checkOnly: Bool = false) async throws -> ApplyPatchResult {
        struct P: Encodable { let sessionId: String; let patch: String; let reverse: Bool?; let checkOnly: Bool? }
        return try await request(
            .checkpointApplyPatch,
            params: P(sessionId: sessionId, patch: patch, reverse: reverse ? true : nil, checkOnly: checkOnly ? true : nil),
            as: ApplyPatchResult.self
        )
    }

    /// Resume at reset: the env server starts `input` (default: a "continue"
    /// message) at `at` (default: the session's own reset time).
    func turnSchedule(sessionId: String, at: String? = nil, input: CodeV2.UserInput? = nil) async throws -> CodeV2.ScheduledResume {
        struct P: Encodable { let sessionId: String; let at: String?; let input: CodeV2.UserInput? }
        return try await request(.turnSchedule, params: P(sessionId: sessionId, at: at, input: input), as: ScheduleResult.self).schedule
    }

    func turnUnschedule(sessionId: String, scheduleId: String? = nil) async throws -> Bool {
        struct P: Encodable { let sessionId: String; let scheduleId: String? }
        return try await request(.turnUnschedule, params: P(sessionId: sessionId, scheduleId: scheduleId), as: UnscheduleResult.self).cancelled
    }

    /// A managed runtime (Antigravity): download Google's release, cancel it, or remove it.
    func providerInstall(_ instanceId: String, action: CodeV2.ProviderInstallAction, operationId: String? = nil) async throws -> CodeV2.ProviderInstallState {
        struct P: Encodable { let instanceId: String; let action: CodeV2.ProviderInstallAction; let operationId: String? }
        return try await request(.providerInstall, params: P(instanceId: instanceId, action: action, operationId: operationId), as: InstallResult.self).install
    }

    /// Google sign-in for a managed runtime: start, complete with a pasted
    /// redirect address, cancel, or sign out.
    func providerAuth(
        _ instanceId: String, action: CodeV2.ProviderAuthAction, flowId: String? = nil, callbackUrl: String? = nil
    ) async throws -> CodeV2.ProviderAuthState {
        struct P: Encodable { let instanceId: String; let action: CodeV2.ProviderAuthAction; let flowId: String?; let callbackUrl: String? }
        return try await request(
            .providerAuth, params: P(instanceId: instanceId, action: action, flowId: flowId, callbackUrl: callbackUrl), as: AuthResult.self
        ).auth
    }

    func sessionList(cwd: String? = nil, query: String? = nil, limit: Int? = nil) async throws -> [CodeV2.SessionSummary] {
        struct P: Encodable { let cwd: String?; let query: String?; let limit: Int? }
        return try await request(.sessionList, params: P(cwd: cwd, query: query, limit: limit), as: SessionsResult.self).sessions
    }

    func sessionClose(_ sessionId: String) async throws {
        struct P: Encodable { let sessionId: String }
        _ = try await send(.sessionClose, params: P(sessionId: sessionId))
    }

    func terminalOpen(cwd: String, cols: Int, rows: Int, command: String? = nil, terminalId: String? = nil) async throws -> String {
        struct P: Encodable { let terminalId: String?; let cwd: String; let cols: Int; let rows: Int; let command: String? }
        return try await request(
            .terminalOpen, params: P(terminalId: terminalId, cwd: cwd, cols: cols, rows: rows, command: command),
            as: TerminalResult.self
        ).terminalId
    }

    func terminalWrite(_ terminalId: String, data: String) async throws {
        struct P: Encodable { let terminalId: String; let data: String }
        _ = try await send(.terminalWrite, params: P(terminalId: terminalId, data: data))
    }

    func terminalResize(_ terminalId: String, cols: Int, rows: Int) async throws {
        struct P: Encodable { let terminalId: String; let cols: Int; let rows: Int }
        _ = try await send(.terminalResize, params: P(terminalId: terminalId, cols: cols, rows: rows))
    }

    func terminalClose(_ terminalId: String) async throws {
        struct P: Encodable { let terminalId: String }
        _ = try await send(.terminalClose, params: P(terminalId: terminalId))
    }
}

public extension CodeV2 {
    static let protocolName = "alevr-code-v2/1"
}
