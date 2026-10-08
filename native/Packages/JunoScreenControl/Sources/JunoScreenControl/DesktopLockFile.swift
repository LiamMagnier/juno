import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// The cross-process half of the desktop lock (Alevr Code v2 SPEC §3.12).
///
/// ``ScreenControlLock`` keeps every session and Work task inside this app to
/// one pointer. Agents driving the Mac through the env server's Alevr MCP
/// server, and a second copy of the app (a development build beside the
/// release), are other processes; they meet here, in one JSON record at
/// `~/Library/Application Support/Alevr/computer-use/desktop.lock`.
///
/// The algorithm is the env server's `DesktopLock` (runner/env-server/src/mcp/
/// desktop-lock.ts), step for step — keep the two in step:
///
/// - acquire: create the file exclusively. If it exists: the same holder id is
///   re-entrant (rewritten with our pid and a fresh heartbeat); a dead pid, a
///   heartbeat older than ``staleAfter`` or an unreadable record is stale and
///   removed, then one more try; anything else is refused, naming the holder.
/// - heartbeat: rewrite `heartbeatAt` atomically while it is ours.
/// - release: remove the file iff the record is ours.
public struct DesktopLockFile: Sendable {
    /// The record, with the contract's JSON keys (`DesktopLockRecord`).
    public struct Record: Codable, Hashable, Sendable {
        public enum Kind: String, Codable, Hashable, Sendable {
            case codeSession = "code_session"
            case workTask = "work_task"
            case envServer = "env_server"
        }

        public var holderId: String
        public var kind: Kind
        public var title: String
        public var pid: Int32
        public var app: String?
        public var acquiredAt: String
        public var heartbeatAt: String

        public init(holderId: String, kind: Kind, title: String, pid: Int32, app: String? = nil, acquiredAt: String, heartbeatAt: String) {
            self.holderId = holderId
            self.kind = kind
            self.title = title
            self.pid = pid
            self.app = app
            self.acquiredAt = acquiredAt
            self.heartbeatAt = heartbeatAt
        }

        /// "Alevr is using TextEdit for ‘Fix the export sheet’".
        public var sentence: String {
            let what = app.map { "Alevr is using \($0)" } ?? "Alevr is already using apps"
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return "\(what) for ‘\(trimmed)’" }
            switch kind {
            case .workTask: return what + " for a Work task"
            case .envServer: return what + " for a connected agent"
            case .codeSession: return what + " in another session"
            }
        }
    }

    public enum Outcome: Hashable, Sendable {
        case acquired(Record)
        case held(by: Record)
        /// Lost two races in a row; someone is claiming it right now.
        case contended
    }

    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Alevr", isDirectory: true)
            .appendingPathComponent("computer-use", isDirectory: true)
    }

    public static var defaultURL: URL { defaultDirectory.appendingPathComponent("desktop.lock") }

    /// `DESKTOP_LOCK_STALE_MS`.
    public static let defaultStaleAfter: TimeInterval = 15

    public let url: URL
    public let pid: Int32
    public let staleAfter: TimeInterval
    private let now: @Sendable () -> Date
    private let isAlive: @Sendable (Int32) -> Bool

    public init(
        url: URL = DesktopLockFile.defaultURL,
        pid: Int32 = ProcessInfo.processInfo.processIdentifier,
        staleAfter: TimeInterval = DesktopLockFile.defaultStaleAfter,
        now: @escaping @Sendable () -> Date = { Date() },
        isAlive: @escaping @Sendable (Int32) -> Bool = DesktopLockFile.processIsAlive
    ) {
        self.url = url
        self.pid = pid
        self.staleAfter = staleAfter
        self.now = now
        self.isAlive = isAlive
    }

    @Sendable public static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    private static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func parse(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    public func read() -> Record? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    public func isStale(_ record: Record) -> Bool {
        guard isAlive(record.pid), let beat = Self.parse(record.heartbeatAt) else { return true }
        return now().timeIntervalSince(beat) > staleAfter
    }

    /// The live holder, or nil.
    public func holder() -> Record? {
        guard let record = read(), !isStale(record) else { return nil }
        return record
    }

    public func acquire(holderID: String, kind: Record.Kind, title: String, app: String? = nil) -> Outcome {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        for _ in 0..<2 {
            let stamp = Self.stamp(now())
            let fresh = Record(holderId: holderID, kind: kind, title: title, pid: pid, app: app, acquiredAt: stamp, heartbeatAt: stamp)
            if createExclusively(fresh) { return .acquired(fresh) }
            let existing = read()
            if let existing, existing.holderId == holderID {
                var renewed = existing
                renewed.pid = pid
                if !title.isEmpty { renewed.title = title }
                if let app { renewed.app = app }
                renewed.heartbeatAt = stamp
                writeAtomically(renewed)
                return .acquired(renewed)
            }
            if let existing, !isStale(existing) { return .held(by: existing) }
            try? FileManager.default.removeItem(at: url)
        }
        if let holder = read() { return .held(by: holder) }
        return .contended
    }

    @discardableResult
    public func heartbeat(holderID: String, app: String? = nil) -> Bool {
        guard var record = read(), record.holderId == holderID else { return false }
        if let app { record.app = app }
        record.heartbeatAt = Self.stamp(now())
        writeAtomically(record)
        return true
    }

    @discardableResult
    public func release(holderID: String) -> Bool {
        guard let record = read(), record.holderId == holderID else { return false }
        return (try? FileManager.default.removeItem(at: url)) != nil
    }

    private func createExclusively(_ record: Record) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        return written == data.count
    }

    private func writeAtomically(_ record: Record) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        let tmp = url.deletingLastPathComponent().appendingPathComponent("desktop.lock.\(pid).\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        if rename(tmp.path, url.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
    }
}
