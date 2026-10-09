import Foundation
import JunoCodeCore

// MARK: - Wire

/// One request the hosted web sends this Mac through the device relay
/// (`DeviceLinkTransport` in `src/lib/code-v2/env-client.ts`): an env-server
/// command to run, or a long-poll for events past the cursors the web holds.
///
/// The command is kept as raw JSON (`type` a string) so a command this build
/// does not know is refused with a proper response instead of failing to
/// decode the whole request.
public struct EnvLinkRequest: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case rpc, poll }

    public struct Command: Codable, Sendable, Equatable {
        public var id: String
        public var type: String
        public var params: JSONValue?

        public init(id: String, type: String, params: JSONValue? = nil) {
            self.id = id
            self.type = type
            self.params = params
        }
    }

    public var kind: Kind
    public var command: Command?
    /// Session id → last applied sequence.
    public var cursors: [String: Int]?
    public var globalCursor: Int?

    public init(kind: Kind, command: Command? = nil, cursors: [String: Int]? = nil, globalCursor: Int? = nil) {
        self.kind = kind
        self.command = command
        self.cursors = cursors
        self.globalCursor = globalCursor
    }
}

/// What the Mac answers (`LinkReply` on the web).
public struct EnvLinkReply: Codable, Sendable, Equatable {
    public var responses: [CodeV2.ServerResponse]?
    public var events: [CodeV2.ServerEventEnvelope]?
    /// The env server is not running on this Mac.
    public var offline: Bool?
    public var message: String?

    public init(
        responses: [CodeV2.ServerResponse]? = nil,
        events: [CodeV2.ServerEventEnvelope]? = nil,
        offline: Bool? = nil,
        message: String? = nil
    ) {
        self.responses = responses
        self.events = events
        self.offline = offline
        self.message = message
    }
}

// MARK: - Relay core

/// The Mac's side of the device link: lets the hosted web drive env-server
/// sessions through this Mac (Code v2 SPEC §2: "The hosted web reaches it
/// through the user's Mac").
///
/// It does two things and nothing else:
/// - **rpc**: checks a command against what a remote may do, forwards it to
///   the env server and wraps the answer as a wire response;
/// - **poll**: answers with the buffered events past the web's cursors, or
///   waits (long poll) until one arrives.
///
/// What a remote may NOT do, whatever it sends:
/// - `env.configure` and any type this build does not know (it carries the
///   user's session and BYOK keys; local only);
/// - the `terminal.*` family unless the user allowed a remote terminal (a
///   shell on this Mac is more than a coding session);
/// - open a session, list sessions or open a terminal outside a folder the
///   user shared with Remote (`allowedRoots`).
///
/// Events are recorded from the hub's relay sink; the buffer keeps the newest
/// `bufferLimit` so a web that fell far behind gets a sequence gap and
/// re-opens with `afterSequence`, which the env server replays from its log.
public actor EnvServerDeviceLink {
    public typealias Forward = @Sendable (_ type: CodeV2.ClientCommandType, _ params: JSONValue) async throws -> JSONValue?

    /// Commands a remote may send.
    public static let remoteCommands: Set<CodeV2.ClientCommandType> = [
        .sessionOpen, .turnStart, .turnSteer, .turnQueue, .turnInterrupt, .approvalRespond,
        .checkpointRollback, .checkpointDiff, .providerList, .providerProbe, .providerSetup,
        .sessionList, .sessionClose,
    ]
    public static let terminalCommands: Set<CodeV2.ClientCommandType> = [
        .terminalOpen, .terminalWrite, .terminalResize, .terminalClose,
    ]

    private let forward: Forward
    private let allowedRoots: @Sendable () async -> [String]
    private let allowsTerminal: @Sendable () async -> Bool
    private let isOnline: @Sendable () async -> Bool
    private let bufferLimit: Int
    private var buffer: [CodeV2.ServerEventEnvelope] = []
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    /// Sessions opened through the link: a remote may only drive these.
    private var linkedSessions: Set<String> = []

    public init(
        bufferLimit: Int = 4_000,
        isOnline: @escaping @Sendable () async -> Bool = { true },
        allowedRoots: @escaping @Sendable () async -> [String],
        allowsTerminal: @escaping @Sendable () async -> Bool = { false },
        forward: @escaping Forward
    ) {
        self.bufferLimit = bufferLimit
        self.isOnline = isOnline
        self.allowedRoots = allowedRoots
        self.allowsTerminal = allowsTerminal
        self.forward = forward
    }

    // MARK: Events

    /// Records an env-server event for remote readers.
    public func record(_ envelope: CodeV2.ServerEventEnvelope) {
        // Terminal output only leaves when a remote terminal is allowed; the
        // poll filters it, but there is no reason to hold it either.
        buffer.append(envelope)
        if buffer.count > bufferLimit { buffer.removeFirst(buffer.count - bufferLimit) }
        let waiting = waiters
        waiters.removeAll()
        for continuation in waiting.values { continuation.resume() }
    }

    func pending(cursors: [String: Int], globalCursor: Int, terminal: Bool) -> [CodeV2.ServerEventEnvelope] {
        buffer.filter { envelope in
            switch envelope.stream {
            case .global:
                guard envelope.sequence > globalCursor else { return false }
                if case .providerUpdated = envelope.event { return true }
                return false
            case .session:
                guard let sessionId = envelope.sessionId, let cursor = cursors[sessionId] else { return false }
                guard envelope.sequence > cursor else { return false }
                switch envelope.event {
                case .terminalOutput, .terminalExited: return terminal
                default: return true
                }
            }
        }
    }

    // MARK: Requests

    /// Answers one request. A poll with nothing to say waits up to
    /// `longPoll` for an event before answering empty.
    public func handle(_ request: EnvLinkRequest, longPoll: Duration = .seconds(20)) async -> EnvLinkReply {
        guard await isOnline() else {
            return EnvLinkReply(offline: true, message: "Alevr's local environment is not running on this Mac.")
        }
        switch request.kind {
        case .rpc:
            guard let command = request.command else {
                return EnvLinkReply(message: "The request carried no command.")
            }
            return EnvLinkReply(responses: [await run(command)])
        case .poll:
            let cursors = request.cursors ?? [:]
            let global = request.globalCursor ?? -1
            let terminal = await allowsTerminal()
            var events = pending(cursors: cursors, globalCursor: global, terminal: terminal)
            if events.isEmpty, longPoll > .zero {
                await wait(upTo: longPoll)
                events = pending(cursors: cursors, globalCursor: global, terminal: terminal)
            }
            return EnvLinkReply(events: events)
        }
    }

    private func wait(upTo duration: Duration) async {
        let id = UUID()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters[id] = continuation
            Task {
                try? await Task.sleep(for: duration)
                self.timeOut(id)
            }
        }
    }

    private func timeOut(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume()
    }

    func run(_ command: EnvLinkRequest.Command) async -> CodeV2.ServerResponse {
        guard let type = CodeV2.ClientCommandType(rawValue: command.type) else {
            return refuse(command.id, .unsupported, "This command is not available from another device.")
        }
        let params = command.params ?? .object([:])
        if Self.terminalCommands.contains(type) {
            guard await allowsTerminal() else {
                return refuse(command.id, .unsupported, "The terminal on this Mac is not shared with other devices.")
            }
        } else if !Self.remoteCommands.contains(type) {
            return refuse(command.id, .unsupported, "This command is not available from another device.")
        }
        if let problem = await check(type, params) {
            return refuse(command.id, .badRequest, problem)
        }
        do {
            let result = try await forward(type, params)
            if type == .sessionOpen, case let .object(object)? = result, case let .string(id)? = object["sessionId"] {
                linkedSessions.insert(id)
            }
            return CodeV2.ServerResponse(id: command.id, ok: true, result: result)
        } catch let EnvServerConnectionError.server(code, message) {
            return refuse(command.id, code, message)
        } catch {
            return refuse(command.id, .notReady, (error as? LocalizedError)?.errorDescription ?? "Your Mac could not run that.")
        }
    }

    /// Folder and session rules. Nil when the command may run.
    private func check(_ type: CodeV2.ClientCommandType, _ params: JSONValue) async -> String? {
        guard case let .object(object) = params else { return "The command's parameters were not an object." }
        switch type {
        case .sessionOpen, .terminalOpen:
            guard case let .string(cwd)? = object["cwd"] else { return "A folder is required." }
            guard Self.isInside(cwd, roots: await allowedRoots()) else {
                return "That folder is not shared with other devices. Share it from Alevr on your Mac first."
            }
            if type == .sessionOpen, case let .string(id)? = object["sessionId"] { linkedSessions.insert(id) }
            return nil
        case .sessionList:
            if case let .string(cwd)? = object["cwd"], !Self.isInside(cwd, roots: await allowedRoots()) {
                return "That folder is not shared with other devices."
            }
            return nil
        case .turnStart, .turnSteer, .turnQueue, .turnInterrupt, .approvalRespond, .checkpointRollback,
             .checkpointDiff, .sessionClose:
            guard case let .string(id)? = object["sessionId"] else { return "A session is required." }
            return linkedSessions.contains(id) ? nil : "Open the session first."
        default:
            return nil
        }
    }

    /// Whether `path` is one of `roots` or inside one, after resolving `..`.
    public static func isInside(_ path: String, roots: [String]) -> Bool {
        let target = URL(fileURLWithPath: path).standardizedFileURL.path
        return roots.contains { root in
            let base = URL(fileURLWithPath: root).standardizedFileURL.path
            return target == base || target.hasPrefix(base.hasSuffix("/") ? base : base + "/")
        }
    }

    private func refuse(_ id: String, _ code: CodeV2.WireErrorCode, _ message: String) -> CodeV2.ServerResponse {
        CodeV2.ServerResponse(id: id, ok: false, error: CodeV2.WireError(code: code, message: message))
    }
}

// MARK: - Channel to the relay

/// Pulls link requests the backend queued for this Mac and posts the replies.
///
/// The backend half (`/api/code/v2/link/device/*`) belongs to the web lane;
/// the wire is: `POST pull {deviceId}` → `{requests: [{requestId, request}]}`
/// (long-polled server side), then `POST reply {deviceId, requestId, reply}`.
/// Each request is answered on its own task so one long poll never holds up a
/// command.
public actor EnvServerDeviceLinkChannel {
    public typealias Perform = @Sendable (_ method: String, _ path: String, _ body: Data?) async throws -> (Int, Data)

    struct Pulled: Decodable {
        struct Entry: Decodable {
            let requestId: String
            let request: EnvLinkRequest
        }
        let requests: [Entry]
    }

    private let deviceId: String
    private let link: EnvServerDeviceLink
    private let perform: Perform
    private var loop: Task<Void, Never>?
    private var failures = 0

    public init(deviceId: String, link: EnvServerDeviceLink, perform: @escaping Perform) {
        self.deviceId = deviceId
        self.link = link
        self.perform = perform
    }

    public var isRunning: Bool { loop != nil }

    public func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let delay = await self.pullOnce()
                if let delay { try? await Task.sleep(for: delay) }
            }
        }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
    }

    /// One pull. Returns how long to wait before the next (nil: at once).
    @discardableResult
    public func pullOnce() async -> Duration? {
        do {
            let body = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId])
            let (status, data) = try await perform("POST", "/api/code/v2/link/device/pull", body)
            guard (200..<300).contains(status) else {
                return backoff(status == 404 ? 60 : nil)
            }
            failures = 0
            let pulled = try JSONDecoder().decode(Pulled.self, from: data)
            for entry in pulled.requests {
                Task { await self.answer(entry.requestId, entry.request) }
            }
            return pulled.requests.isEmpty ? .milliseconds(250) : nil
        } catch {
            return backoff(nil)
        }
    }

    private func backoff(_ fixed: Int?) -> Duration {
        failures += 1
        if let fixed { return .seconds(fixed) }
        return .seconds(min(30, 1 << min(failures, 5)))
    }

    func answer(_ requestId: String, _ request: EnvLinkRequest) async {
        let reply = await link.handle(request)
        struct Wire: Encodable {
            let deviceId: String
            let requestId: String
            let reply: EnvLinkReply
        }
        guard let body = try? JSONEncoder().encode(Wire(deviceId: deviceId, requestId: requestId, reply: reply)) else { return }
        _ = try? await perform("POST", "/api/code/v2/link/device/reply", body)
    }
}
