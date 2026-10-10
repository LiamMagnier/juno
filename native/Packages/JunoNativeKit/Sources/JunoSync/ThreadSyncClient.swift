import Foundation
import JunoAPI
import JunoAuth
import JunoCore

// Per-thread state every device shares (docs/code-v2/REMOTE-CONTROL.md §Sync):
// the unsent draft, the composer's model / effort / mode / team / skills, and
// whether the thread is unread or needs the person. The backend keeps one row
// per thread key; the newer write by the writer's own clock wins, field group
// by field group, and readers long-poll for what changed after their cursor.

/// `chat:<conversationId>` or `code:<deviceId>:<sessionId>`.
public enum ThreadSyncKey {
    public static func chat(_ conversationID: String) -> String { "chat:\(conversationID)" }
    public static func code(deviceID: String, sessionID: String) -> String { "code:\(deviceID):\(sessionID)" }
}

/// The composer settings a thread carries between devices.
public struct ThreadSyncPrefs: Codable, Sendable, Equatable, Hashable {
    public var model: String?
    public var effort: String?
    public var mode: String?
    public var interactionMode: String?
    public var team: String?
    public var skills: [String]?

    public init(
        model: String? = nil, effort: String? = nil, mode: String? = nil, interactionMode: String? = nil,
        team: String? = nil, skills: [String]? = nil
    ) {
        self.model = model
        self.effort = effort
        self.mode = mode
        self.interactionMode = interactionMode
        self.team = team
        self.skills = skills
    }

    public var isEmpty: Bool { self == ThreadSyncPrefs() }
}

/// One thread's shared state.
public struct ThreadSyncState: Codable, Sendable, Equatable, Identifiable {
    public var key: String
    public var draft: String
    public var draftUpdatedAt: Date?
    public var draftBy: String?
    public var prefs: ThreadSyncPrefs
    public var prefsUpdatedAt: Date?
    public var needsYou: Bool
    public var readAt: Date?
    public var updatedAt: Date
    public var id: String { key }

    public init(
        key: String, draft: String = "", draftUpdatedAt: Date? = nil, draftBy: String? = nil,
        prefs: ThreadSyncPrefs = ThreadSyncPrefs(), prefsUpdatedAt: Date? = nil, needsYou: Bool = false,
        readAt: Date? = nil, updatedAt: Date
    ) {
        self.key = key
        self.draft = draft
        self.draftUpdatedAt = draftUpdatedAt
        self.draftBy = draftBy
        self.prefs = prefs
        self.prefsUpdatedAt = prefsUpdatedAt
        self.needsYou = needsYou
        self.readAt = readAt
        self.updatedAt = updatedAt
    }
}

/// What a device writes. Absent fields are left alone.
public struct ThreadSyncUpdate: Sendable, Equatable {
    public var draft: String?
    public var draftUpdatedAt: Date?
    public var prefs: ThreadSyncPrefs?
    public var prefsUpdatedAt: Date?
    public var read: Bool?
    public var needsYou: Bool?
    public var device: String?

    public init(
        draft: String? = nil, draftUpdatedAt: Date? = nil, prefs: ThreadSyncPrefs? = nil, prefsUpdatedAt: Date? = nil,
        read: Bool? = nil, needsYou: Bool? = nil, device: String? = nil
    ) {
        self.draft = draft
        self.draftUpdatedAt = draftUpdatedAt
        self.prefs = prefs
        self.prefsUpdatedAt = prefsUpdatedAt
        self.read = read
        self.needsYou = needsYou
        self.device = device
    }

    /// The JSON body the PUT route reads.
    public func body() throws -> Data {
        var object: [String: Any] = [:]
        if let draft { object["draft"] = draft }
        if let draftUpdatedAt { object["draftUpdatedAt"] = ThreadSyncDates.format(draftUpdatedAt) }
        if let prefs {
            var p: [String: Any] = [:]
            if let v = prefs.model { p["model"] = v }
            if let v = prefs.effort { p["effort"] = v }
            if let v = prefs.mode { p["mode"] = v }
            if let v = prefs.interactionMode { p["interactionMode"] = v }
            if let v = prefs.team { p["team"] = v }
            if let v = prefs.skills { p["skills"] = v }
            object["prefs"] = p
        }
        if let prefsUpdatedAt { object["prefsUpdatedAt"] = ThreadSyncDates.format(prefsUpdatedAt) }
        if let read { object["read"] = read }
        if let needsYou { object["needsYou"] = needsYou }
        if let device { object["device"] = device }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

public enum ThreadSyncDates {
    public static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    public static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = parse(text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a date: \(text)"))
            }
            return date
        }
        return decoder
    }()
}

public struct ThreadSyncPage: Sendable, Equatable {
    public let threads: [ThreadSyncState]
    public let cursor: String?
}

public enum ThreadSyncError: Error, Equatable, Sendable {
    case server(Int)
}

/// `/api/sync/threads` and `/api/sync/handoff`.
public struct ThreadSyncClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    static func segment(_ key: String) -> String {
        key.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))) ?? key
    }

    public func thread(_ key: String, for accountID: AccountID) async throws -> ThreadSyncState? {
        let request = try NativeBearerRequest(
            path: "/api/sync/threads/\(Self.segment(key))", method: .get, headers: try HTTPHeaders(["accept": "application/json"])
        )
        let response = try await sender.send(request, for: accountID)
        guard (200..<300).contains(response.statusCode) else { throw ThreadSyncError.server(response.statusCode) }
        struct Wire: Decodable { let thread: ThreadSyncState? }
        return try ThreadSyncDates.decoder.decode(Wire.self, from: response.body).thread
    }

    @discardableResult
    public func write(_ key: String, _ update: ThreadSyncUpdate, for accountID: AccountID) async throws -> ThreadSyncState {
        let request = try NativeBearerRequest(
            path: "/api/sync/threads/\(Self.segment(key))",
            method: .put,
            headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
            body: try update.body()
        )
        let response = try await sender.send(request, for: accountID)
        guard (200..<300).contains(response.statusCode) else { throw ThreadSyncError.server(response.statusCode) }
        struct Wire: Decodable { let thread: ThreadSyncState }
        return try ThreadSyncDates.decoder.decode(Wire.self, from: response.body).thread
    }

    /// Rows after `cursor`; with `waitMs`, a long-poll (≤ 20 s) when there are none.
    public func changes(after cursor: String?, waitMs: Int = 0, keys: [String] = [], for accountID: AccountID) async throws -> ThreadSyncPage {
        var query: [URLQueryItem] = []
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        if waitMs > 0 { query.append(URLQueryItem(name: "wait", value: String(min(waitMs, 20_000)))) }
        if !keys.isEmpty { query.append(URLQueryItem(name: "keys", value: keys.joined(separator: ","))) }
        let request = try NativeBearerRequest(
            path: "/api/sync/threads", method: .get, queryItems: query, headers: try HTTPHeaders(["accept": "application/json"])
        )
        let response = try await sender.send(request, for: accountID)
        guard (200..<300).contains(response.statusCode) else { throw ThreadSyncError.server(response.statusCode) }
        struct Wire: Decodable {
            let threads: [ThreadSyncState]
            let cursor: String?
        }
        let wire = try ThreadSyncDates.decoder.decode(Wire.self, from: response.body)
        return ThreadSyncPage(threads: wire.threads, cursor: wire.cursor)
    }

    /// "Continue on iPhone / Mac": the other app gets a notification that opens this thread.
    public func handOff(_ handoff: JunoHandoff, to target: JunoHandoff.Target, for accountID: AccountID) async throws {
        var object: [String: Any] = ["target": target.rawValue, "kind": handoff.kind.rawValue, "id": handoff.id]
        if let deviceID = handoff.deviceID { object["deviceId"] = deviceID }
        if let title = handoff.title, !title.isEmpty { object["title"] = String(title.prefix(300)) }
        let request = try NativeBearerRequest(
            path: "/api/sync/handoff",
            method: .post,
            headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
            body: try JSONSerialization.data(withJSONObject: object)
        )
        let response = try await sender.send(request, for: accountID)
        guard (200..<300).contains(response.statusCode) else {
            struct ErrorWire: Decodable { let error: String? }
            if let message = (try? JSONDecoder().decode(ErrorWire.self, from: response.body))?.error {
                throw JunoHandoffError.refused(message)
            }
            throw ThreadSyncError.server(response.statusCode)
        }
    }
}

public enum JunoHandoffError: Error, Equatable, Sendable, LocalizedError {
    case refused(String)
    public var errorDescription: String? {
        switch self {
        case let .refused(message): message
        }
    }
}

/// Debounces one thread's draft before it goes to the backend: a burst of
/// keystrokes becomes one write `delay` after the last, stamped with the time
/// of that last keystroke (so the newest typing wins on every device).
public actor ThreadDraftSyncer {
    public typealias Write = @Sendable (_ key: String, _ update: ThreadSyncUpdate) async throws -> Void

    private let delay: Duration
    private let device: String
    private let write: Write
    private var pending: [String: (text: String, at: Date)] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    /// What this device last sent per thread, so an echo of it is not applied back.
    private var lastSent: [String: String] = [:]

    public init(device: String, delay: Duration = .milliseconds(700), write: @escaping Write) {
        self.device = device
        self.delay = delay
        self.write = write
    }

    /// The person typed: schedule a write.
    public func draftChanged(_ key: String, text: String, at date: Date = Date()) {
        pending[key] = (text, date)
        timers[key]?.cancel()
        let delay = self.delay
        timers[key] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.flush(key)
        }
    }

    /// Writes now (leaving the thread, the app going to the background).
    public func flush(_ key: String) async {
        timers[key]?.cancel()
        timers[key] = nil
        guard let draft = pending.removeValue(forKey: key) else { return }
        lastSent[key] = draft.text
        try? await write(key, ThreadSyncUpdate(draft: draft.text, draftUpdatedAt: draft.at, device: device))
    }

    public func flushAll() async {
        for key in Array(pending.keys) { await flush(key) }
    }

    /// A message was sent: the draft is gone everywhere, at once.
    public func cleared(_ key: String, at date: Date = Date()) async {
        timers[key]?.cancel()
        timers[key] = nil
        pending[key] = nil
        lastSent[key] = ""
        try? await write(key, ThreadSyncUpdate(draft: "", draftUpdatedAt: date, device: device))
    }

    /// Whether a remote state should replace what this device shows: not its
    /// own echo, and not while this device has unsent typing for the thread.
    public func shouldApply(_ state: ThreadSyncState) -> Bool {
        if pending[state.key] != nil { return false }
        if state.draftBy == device, lastSent[state.key] == state.draft { return false }
        return true
    }
}
