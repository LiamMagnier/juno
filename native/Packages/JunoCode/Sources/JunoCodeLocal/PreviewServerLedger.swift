import Darwin
import Foundation

/// A record of every dev server Juno started, kept on disk so a crash cannot
/// leave one holding its port forever (CODE_AGENT_SPEC §4.1, PV-14).
///
/// Each entry is the server's process group, its leader's pid and start time,
/// its folder and configuration hash, and the Juno process that started it.
/// On launch, entries whose owner is gone are reaped: the group is signalled
/// only after the leader's recorded start time is checked, so a pid the system
/// has since given to an unrelated process is never signalled.
public final class PreviewServerLedger: @unchecked Sendable {
    public struct Entry: Codable, Hashable, Sendable {
        public var pgid: Int32
        public var pid: Int32
        public var startedAt: ProcessStartTime
        public var cwd: String
        public var configHash: String
        public var name: String
        public var ownerPID: Int32
        public var ownerStartedAt: ProcessStartTime?

        public init(
            pgid: Int32,
            pid: Int32,
            startedAt: ProcessStartTime,
            cwd: String,
            configHash: String,
            name: String,
            ownerPID: Int32,
            ownerStartedAt: ProcessStartTime?
        ) {
            self.pgid = pgid
            self.pid = pid
            self.startedAt = startedAt
            self.cwd = cwd
            self.configHash = configHash
            self.name = name
            self.ownerPID = ownerPID
            self.ownerStartedAt = ownerStartedAt
        }
    }

    /// What a reaping pass did.
    public struct ReapReport: Equatable, Sendable {
        /// Orphans whose group was signalled.
        public var reaped: [Entry] = []
        /// Entries dropped without a signal: the server was already gone, or
        /// its pid now belongs to another process.
        public var dropped: [Entry] = []
        /// Entries kept because their owner still runs.
        public var kept: [Entry] = []
    }

    /// How the ledger looks at and signals processes; a fake in tests.
    public protocol ProcessControl: Sendable {
        func startTime(of pid: pid_t) -> ProcessStartTime?
        func groupMembers(_ pgid: pid_t) -> [pid_t]
        /// The process's working directory, nil when it cannot be read.
        func currentDirectory(of pid: pid_t) -> String?
        func signalGroup(_ pgid: pid_t, _ signal: Int32)
        var currentPID: pid_t { get }
    }

    /// The real kernel.
    public struct SystemProcessControl: ProcessControl {
        public init() {}
        public func startTime(of pid: pid_t) -> ProcessStartTime? { ListeningSocketOwnership.startTime(of: pid) }
        public func groupMembers(_ pgid: pid_t) -> [pid_t] { ListeningSocketOwnership.groupMembers(pgid) }
        public func currentDirectory(of pid: pid_t) -> String? { ListeningSocketOwnership.currentDirectory(of: pid) }
        public func signalGroup(_ pgid: pid_t, _ signal: Int32) { _ = kill(-pgid, signal) }
        public var currentPID: pid_t { getpid() }
    }

    public let fileURL: URL
    private let control: any ProcessControl
    private let lock = NSLock()

    /// `~/Library/Application Support/Juno/preview-servers.json`.
    public static var defaultFileURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Juno", isDirectory: true).appendingPathComponent("preview-servers.json")
    }

    public init(fileURL: URL = PreviewServerLedger.defaultFileURL, control: any ProcessControl = SystemProcessControl()) {
        self.fileURL = fileURL
        self.control = control
    }

    public func entries() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return readLocked()
    }

    /// Records a server this process started.
    public func record(pgid: Int32, pid: Int32, cwd: String, configHash: String, name: String) {
        guard let startedAt = control.startTime(of: pid) else { return }
        let entry = Entry(
            pgid: pgid,
            pid: pid,
            startedAt: startedAt,
            cwd: cwd,
            configHash: configHash,
            name: name,
            ownerPID: control.currentPID,
            ownerStartedAt: control.startTime(of: control.currentPID)
        )
        record(entry)
    }

    public func record(_ entry: Entry) {
        lock.lock()
        defer { lock.unlock() }
        var entries = readLocked().filter { $0.pgid != entry.pgid }
        entries.append(entry)
        writeLocked(entries)
    }

    /// Forgets a server that stopped.
    public func remove(pgid: Int32) {
        lock.lock()
        defer { lock.unlock() }
        let entries = readLocked()
        let remaining = entries.filter { $0.pgid != pgid }
        if remaining.count != entries.count { writeLocked(remaining) }
    }

    /// Signals the groups of servers whose owning Juno is gone, and drops
    /// entries that no longer name a live server of Juno's. `SIGTERM` now;
    /// `SIGKILL` follows after `killDelay` for any group whose leader is still
    /// the same process.
    @discardableResult
    public func reapOrphans(killDelay: TimeInterval = 2) -> ReapReport {
        lock.lock()
        let entries = readLocked()
        var report = ReapReport()
        var remaining: [Entry] = []
        for entry in entries {
            if ownerIsAlive(entry) {
                report.kept.append(entry)
                remaining.append(entry)
                continue
            }
            if isSameServer(entry) {
                control.signalGroup(entry.pgid, SIGTERM)
                report.reaped.append(entry)
            } else {
                report.dropped.append(entry)
            }
        }
        writeLocked(remaining)
        lock.unlock()

        let reaped = report.reaped
        guard !reaped.isEmpty else { return report }
        let control = self.control
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + killDelay) {
            for entry in reaped where Self.isSameServer(entry, control: control) {
                control.signalGroup(entry.pgid, SIGKILL)
            }
        }
        return report
    }

    /// The app is quitting: every server this process started gets SIGTERM
    /// now, synchronously, and leaves the ledger. A server that ignores it is
    /// reaped by the next launch.
    @discardableResult
    public func terminateServersOwnedByThisProcess() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        let entries = readLocked()
        let mine = entries.filter { $0.ownerPID == control.currentPID }
        for entry in mine where isSameServer(entry) {
            control.signalGroup(entry.pgid, SIGTERM)
        }
        writeLocked(entries.filter { $0.ownerPID != control.currentPID })
        return mine
    }

    /// Whether the Juno that started `entry` still runs. This process counts:
    /// its own servers are not orphans.
    func ownerIsAlive(_ entry: Entry) -> Bool {
        if entry.ownerPID == control.currentPID {
            return entry.ownerStartedAt == nil || control.startTime(of: control.currentPID) == entry.ownerStartedAt
        }
        guard let started = control.startTime(of: entry.ownerPID) else { return false }
        return entry.ownerStartedAt == nil || started == entry.ownerStartedAt
    }

    func isSameServer(_ entry: Entry) -> Bool {
        Self.isSameServer(entry, control: control)
    }

    /// The leader still has its recorded start time; or the leader is gone but
    /// the group still has members that started no earlier than it did and
    /// work inside the server's folder.
    ///
    /// The start time alone is not proof once the leader is gone: after the
    /// old group died, the pid can go to an unrelated process that leads a new
    /// group of the same number and then exits, leaving members that also
    /// started later. Those are someone else's (a Terminal job, a build), and
    /// their working directory says so; a server's processes run in its
    /// folder.
    static func isSameServer(_ entry: Entry, control: any ProcessControl) -> Bool {
        if let started = control.startTime(of: entry.pid) {
            return started == entry.startedAt
        }
        let members = control.groupMembers(entry.pgid)
        guard !members.isEmpty else { return false }
        let folder = normalizedPath(entry.cwd)
        return members.allSatisfy { member in
            guard let started = control.startTime(of: member),
                  (started.seconds, started.microseconds) >= (entry.startedAt.seconds, entry.startedAt.microseconds),
                  let directory = control.currentDirectory(of: member).map(normalizedPath)
            else { return false }
            return directory == folder || directory.hasPrefix(folder + "/")
        }
    }

    /// `/private/tmp/x` and `/tmp/x` are one folder: the kernel reports the
    /// former, Foundation often writes the latter.
    static func normalizedPath(_ path: String) -> String {
        var trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        for prefix in ["/private/tmp", "/private/var", "/private/etc"] where trimmed == prefix || trimmed.hasPrefix(prefix + "/") {
            trimmed = String(trimmed.dropFirst("/private".count))
        }
        return trimmed
    }

    // MARK: - Storage

    private func readLocked() -> [Entry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    private func writeLocked(_ entries: [Entry]) {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(entries).write(to: fileURL, options: .atomic)
        } catch {
            // The ledger is a safety net; a write that fails costs only the
            // next launch's cleanup of this one server.
        }
    }
}
