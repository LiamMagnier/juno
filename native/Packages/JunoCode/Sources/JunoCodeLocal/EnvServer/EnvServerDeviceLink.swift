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
        // Runtime lane: reject a hunk, resume at reset, a managed runtime's install and sign-in.
        .checkpointApplyPatch, .turnSchedule, .turnUnschedule, .providerInstall, .providerAuth,
        // Cross-conversation lane: another conversation's message, written by
        // Alevr's backend after its checks; a bounded read; the thread's toggle.
        .conversationDeliver, .conversationRead, .conversationToggle,
        // Skills lane: the skills installed here, names, descriptions and paths
        // only (the env server never answers with a body); a linked thread's
        // selection, set from another device.
        .skillsList, .skillsSelect,
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
    /// Terminals opened through the link. Terminal events are global (keyed
    /// by terminal id, not session), so only these are ever relayed, and a
    /// remote may only write to, resize or close these: never the shells the
    /// Mac's own Dock › Terminal opened.
    private var linkedTerminals: Set<String> = []
    /// Where shareable events go as they arrive (the relay channel's outbox).
    private var outbound: (@Sendable (CodeV2.ServerEventEnvelope) async -> Void)?

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

    /// Whether the user shared this Mac's terminal with other devices. The
    /// channel reports it on every pull so the hub relays `terminal.*` only
    /// while it is on (this actor checks it again before running one).
    public func sharesTerminal() async -> Bool {
        await allowsTerminal()
    }

    // MARK: Events

    /// Sends every event a remote may see to `sink` as it is recorded (the
    /// relay channel pushes them to the backend hub). Nil stops it.
    public func setOutbound(_ sink: (@Sendable (CodeV2.ServerEventEnvelope) async -> Void)?) {
        outbound = sink
    }

    /// Records an env-server event for remote readers.
    public func record(_ envelope: CodeV2.ServerEventEnvelope) async {
        var envelope = envelope
        // A project's `skills.updated` names its folder, which may not be one
        // shared with other devices: remotes hear only that skills changed.
        if case let .skillsUpdated(cwd) = envelope.event, cwd != nil {
            envelope.event = .skillsUpdated(cwd: nil)
        }
        buffer.append(envelope)
        if buffer.count > bufferLimit { buffer.removeFirst(buffer.count - bufferLimit) }
        let waiting = waiters
        waiters.removeAll()
        for continuation in waiting.values { continuation.resume() }
        if let outbound, await shareable(envelope) { await outbound(envelope) }
    }

    /// Whether a remote may see this event at all: the provider stream, and
    /// sessions opened through the link (terminal output only when shared).
    func shareable(_ envelope: CodeV2.ServerEventEnvelope) async -> Bool {
        switch envelope.stream {
        case .global:
            switch envelope.event {
            case .providerUpdated, .skillsUpdated: return true
            case let .terminalOutput(id, _), let .terminalExited(id, _):
                return linkedTerminals.contains(id) ? await allowsTerminal() : false
            default: return false
            }
        case .session:
            guard let sessionId = envelope.sessionId, linkedSessions.contains(sessionId) else { return false }
            switch envelope.event {
            case .terminalOutput, .terminalExited: return await allowsTerminal()
            default: return true
            }
        }
    }

    func pending(cursors: [String: Int], globalCursor: Int, terminal: Bool) -> [CodeV2.ServerEventEnvelope] {
        buffer.filter { envelope in
            switch envelope.stream {
            case .global:
                guard envelope.sequence > globalCursor else { return false }
                switch envelope.event {
                case .providerUpdated, .skillsUpdated: return true
                case let .terminalOutput(id, _), let .terminalExited(id, _): return terminal && linkedTerminals.contains(id)
                default: return false
                }
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
            var result = try await forward(type, params)
            if type == .sessionOpen, case let .object(object)? = result, case let .string(id)? = object["sessionId"] {
                linkedSessions.insert(id)
            }
            if type == .terminalOpen, case let .object(object)? = result, case let .string(id)? = object["terminalId"] {
                linkedTerminals.insert(id)
            }
            if type == .sessionList { let roots = await allowedRoots(); result = Self.onlyShared(result, roots: roots) }
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
            // Re-opening a session the link already follows (the hub's replay
            // after a gap): the env server ignores `cwd` for an existing session.
            if type == .sessionOpen, case let .string(id)? = object["sessionId"], linkedSessions.contains(id) { return nil }
            // Re-attaching to a terminal by id repaints its scrollback: only a
            // terminal the link itself opened.
            if type == .terminalOpen, case let .string(id)? = object["terminalId"], !linkedTerminals.contains(id) {
                return "Open the terminal first."
            }
            guard case let .string(cwd)? = object["cwd"] else { return "A folder is required." }
            let roots = await allowedRoots()
            guard Self.isInside(cwd, roots: roots) else {
                return "That folder is not shared with other devices. Share it from Alevr on your Mac first."
            }
            // The env server ignores `cwd` when the id names a session that
            // already exists, so a remote could attach to a session in a folder
            // that is not shared by naming its id next to a shared folder.
            // An existing session must itself live in a shared folder.
            if type == .sessionOpen, case let .string(id)? = object["sessionId"] {
                guard let listed = try? await forward(.sessionList, .object([:])) else {
                    return "Your Mac could not check that session."
                }
                if let existing = Self.sessionCwd(id, in: listed), !Self.isInside(existing, roots: roots) {
                    return "That session is not in a folder shared with other devices."
                }
            }
            return nil
        case .sessionList:
            if case let .string(cwd)? = object["cwd"], !Self.isInside(cwd, roots: await allowedRoots()) {
                return "That folder is not shared with other devices."
            }
            return nil
        case .skillsList:
            // A project's skills only for a folder shared with other devices,
            // or a session the link itself opened; with neither, the Mac's own.
            if case let .string(cwd)? = object["cwd"], !Self.isInside(cwd, roots: await allowedRoots()) {
                return "That folder is not shared with other devices."
            }
            if case let .string(id)? = object["sessionId"], !linkedSessions.contains(id) {
                return "Open the session first."
            }
            return nil
        case .terminalWrite, .terminalResize, .terminalClose:
            guard case let .string(id)? = object["terminalId"] else { return "A terminal is required." }
            return linkedTerminals.contains(id) ? nil : "Open the terminal first."
        case .turnStart, .turnSteer, .turnQueue, .turnInterrupt, .approvalRespond, .checkpointRollback,
             .checkpointDiff, .sessionClose, .checkpointApplyPatch, .turnSchedule, .turnUnschedule, .skillsSelect:
            guard case let .string(id)? = object["sessionId"] else { return "A session is required." }
            return linkedSessions.contains(id) ? nil : "Open the session first."
        default:
            return nil
        }
    }

    /// The cwd of session `id` in a `session.list` result, if it is listed.
    static func sessionCwd(_ id: String, in listed: JSONValue?) -> String? {
        guard case let .object(object)? = listed, case let .array(sessions)? = object["sessions"] else { return nil }
        for case let .object(session) in sessions {
            if case .string(id)? = session["id"], case let .string(cwd)? = session["cwd"] { return cwd }
        }
        return nil
    }

    /// A `session.list` result reduced to the sessions in shared folders.
    static func onlyShared(_ listed: JSONValue?, roots: [String]) -> JSONValue? {
        guard case var .object(object)? = listed, case let .array(sessions)? = object["sessions"] else { return listed }
        object["sessions"] = .array(sessions.filter { entry in
            guard case let .object(session) = entry, case let .string(cwd)? = session["cwd"] else { return false }
            return isInside(cwd, roots: roots)
        })
        return .object(object)
    }

    /// Whether `path` is one of `roots` or inside one, after resolving `..`
    /// and symbolic links (a link inside a shared folder may point outside it).
    public static func isInside(_ path: String, roots: [String]) -> Bool {
        let target = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        return roots.contains { root in
            let base = URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path
            return target == base || target.hasPrefix(base.hasSuffix("/") ? base : base + "/")
        }
    }

    private func refuse(_ id: String, _ code: CodeV2.WireErrorCode, _ message: String) -> CodeV2.ServerResponse {
        CodeV2.ServerResponse(id: id, ok: false, error: CodeV2.WireError(code: code, message: message))
    }
}

// MARK: - Channel to the relay

/// Drains the backend's device-link hub (`src/lib/code-v2/env-link-hub.ts`,
/// docs/code-v2/DEVICE-LINK.md "Mac side") for this Mac:
///
/// - `POST /api/code/v2/link/<deviceId>/host {kind:"pull", protocol, appVersion, waitMs, terminal}`
///   long-polls the commands the web relayed (`{protocol, commands:[ClientCommand]}`);
///   the pull is also this Mac's heartbeat. Each command runs through
///   ``EnvServerDeviceLink/run(_:)`` (the same remote rules) on its own task.
/// - `POST …/host {kind:"push", responses, events}` hands back the env
///   server's responses and the events a remote may see, in arrival order,
///   flushed every ~50 ms (≤ 1,000 items per push).
///
/// A 404 means the pairing is gone and a 409 that the protocol differs: both
/// stop the loop until it is started again.
public actor EnvServerDeviceLinkChannel {
    public typealias Perform = @Sendable (_ method: String, _ path: String, _ body: Data?) async throws -> (Int, Data)

    struct Pulled: Decodable {
        let commands: [EnvLinkRequest.Command]
    }

    enum Outgoing {
        case response(CodeV2.ServerResponse)
        case event(CodeV2.ServerEventEnvelope)
    }

    public static let protocolName = "alevr-code-v2"
    static let maxPushItems = 1_000

    private let deviceId: String
    private let link: EnvServerDeviceLink
    private let perform: Perform
    private let appVersion: String?
    private let pullWaitMs: Int
    private let flushDelay: Duration
    private var loop: Task<Void, Never>?
    private var failures = 0
    private var outbox: [Outgoing] = []
    private var flushing: Task<Void, Never>?
    /// Set when the backend says this Mac can no longer serve (unpaired, or another protocol).
    public private(set) var stoppedReason: String?

    public init(
        deviceId: String,
        link: EnvServerDeviceLink,
        appVersion: String? = nil,
        pullWaitMs: Int = 25_000,
        flushDelay: Duration = .milliseconds(50),
        perform: @escaping Perform
    ) {
        self.deviceId = deviceId
        self.link = link
        self.appVersion = appVersion
        self.pullWaitMs = pullWaitMs
        self.flushDelay = flushDelay
        self.perform = perform
    }

    var hostPath: String {
        let id = deviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? deviceId
        return "/api/code/v2/link/\(id)/host"
    }

    public var isRunning: Bool { loop != nil }

    public func start() async {
        guard loop == nil else { return }
        stoppedReason = nil
        await link.setOutbound { [weak self] envelope in
            await self?.enqueue(.event(envelope))
        }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard let delay = await self.pullOnce() else { continue }
                if await self.stoppedReason != nil { return }
                try? await Task.sleep(for: delay)
            }
        }
    }

    public func stop() async {
        loop?.cancel()
        loop = nil
        await link.setOutbound(nil)
    }

    /// One pull. Returns how long to wait before the next (nil: at once).
    @discardableResult
    public func pullOnce() async -> Duration? {
        do {
            var body: [String: Any] = ["kind": "pull", "protocol": Self.protocolName, "waitMs": pullWaitMs]
            if let appVersion { body["appVersion"] = appVersion }
            body["terminal"] = await link.sharesTerminal()
            let (status, data) = try await perform("POST", hostPath, try JSONSerialization.data(withJSONObject: body))
            if status == 404 || status == 409 {
                stoppedReason = status == 404 ? "This Mac is no longer paired with your account." : "Update Alevr to keep using this Mac from the web."
                loop?.cancel()
                loop = nil
                return .seconds(60)
            }
            guard (200..<300).contains(status) else { return backoff() }
            failures = 0
            let pulled = try JSONDecoder().decode(Pulled.self, from: data)
            for command in pulled.commands {
                Task { await self.answer(command) }
            }
            return nil
        } catch {
            return backoff()
        }
    }

    private func backoff() -> Duration {
        failures += 1
        return .seconds(min(15, 1 << min(failures - 1, 4)))
    }

    func answer(_ command: EnvLinkRequest.Command) async {
        let response = await link.run(command)
        enqueue(.response(response))
    }

    func enqueue(_ item: Outgoing) {
        outbox.append(item)
        guard flushing == nil else { return }
        let delay = flushDelay
        flushing = Task { [weak self] in
            try? await Task.sleep(for: delay)
            await self?.flush()
        }
    }

    /// Pushes everything queued, in order, in batches the hub accepts.
    public func flush() async {
        flushing = nil
        while !outbox.isEmpty {
            let batch = outbox.prefix(Self.maxPushItems)
            outbox.removeFirst(batch.count)
            var responses: [CodeV2.ServerResponse] = []
            var events: [CodeV2.ServerEventEnvelope] = []
            for item in batch {
                switch item {
                case let .response(response): responses.append(response)
                case let .event(event): events.append(event)
                }
            }
            struct Push: Encodable {
                let kind = "push"
                let responses: [CodeV2.ServerResponse]
                let events: [CodeV2.ServerEventEnvelope]
            }
            guard let body = try? JSONEncoder().encode(Push(responses: responses, events: events)) else { continue }
            _ = try? await perform("POST", hostPath, body)
        }
    }
}
