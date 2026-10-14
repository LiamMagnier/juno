import CryptoKit
import Foundation
import JunoCodeCore

/// What this Mac already did for each command the device relay delivered,
/// keyed by relay id (`link_<uuid>` / `replay_<uuid>`), so a command delivered
/// twice runs once (docs/code-v2/DEVICE-LINK.md "Receipts").
///
/// The Postgres relay hands a command out again when its answer has not come
/// back within a short window (a lost pull reply), but only to a host whose
/// pull says `receipts: true`, which ``EnvServerDeviceLinkChannel`` sends only
/// with a durable store. A repeat is answered from here: the answer kept when
/// the command finished, or nothing while it still runs. It never runs again.
///
/// One small file per receipt in `directory`, written before the command runs
/// and again when it finishes, so the receipt outlives an app restart. A
/// receipt left unfinished by a previous launch (the app quit or crashed while
/// it ran) answers a repeat with an error instead of running it a second time:
/// whatever it did on this Mac may have happened. Bounded by count and age;
/// an answer too large to keep is replaced by an error that says so.
public final class EnvLinkReceipts: @unchecked Sendable {
    public enum Begin: Equatable, Sendable {
        /// First delivery: run it, then ``finish(_:_:)``.
        case run
        /// Already running here: answer nothing (the first delivery will).
        case running
        /// Already done: send this answer again.
        case finished(CodeV2.ServerResponse)
    }

    struct Record: Codable {
        var id: String
        var at: Date
        var finished: Bool
        var response: CodeV2.ServerResponse?
    }

    private struct Entry {
        var at: Date
        var finished: Bool
        /// Kept in memory only without a directory; otherwise read from its file.
        var response: CodeV2.ServerResponse?
    }

    /// `~/Library/Application Support/Juno/device-link-receipts`.
    public static var defaultDirectory: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Juno", isDirectory: true).appendingPathComponent("device-link-receipts", isDirectory: true)
    }

    /// Nil keeps receipts in memory only (not restart-safe, never advertised).
    public let directory: URL?
    private let limit: Int
    private let keepFor: TimeInterval
    private let maxCachedBytes: Int
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    /// `keepFor` must outlast the relay's redelivery (a command lives at most
    /// two RPC windows, a minute, on the relay).
    public init(
        directory: URL?,
        limit: Int = 256,
        keepFor: TimeInterval = 600,
        maxCachedBytes: Int = 128 * 1024,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.directory = directory
        self.limit = max(1, limit)
        self.keepFor = keepFor
        self.maxCachedBytes = maxCachedBytes
        self.now = now
        if let directory { load(from: directory) }
    }

    /// Whether receipts survive an app restart (the relay may then redeliver).
    public var isDurable: Bool { directory != nil }

    /// Records the start of command `id`, or says what this Mac already did with it.
    public func begin(_ id: String) -> Begin {
        lock.lock()
        defer { lock.unlock() }
        pruneLocked()
        if let entry = entries[id] {
            guard entry.finished else { return .running }
            if let response = entry.response ?? readLocked(id)?.response { return .finished(response) }
            return .finished(Self.lost(id))
        }
        let entry = Entry(at: now(), finished: false)
        entries[id] = entry
        writeLocked(Record(id: id, at: entry.at, finished: false, response: nil))
        return .run
    }

    /// Keeps the answer of command `id` for a repeat delivery.
    public func finish(_ id: String, _ response: CodeV2.ServerResponse) {
        lock.lock()
        defer { lock.unlock() }
        var kept = response
        if let size = try? JSONEncoder().encode(response).count, size > maxCachedBytes {
            kept = CodeV2.ServerResponse(
                id: id,
                ok: false,
                error: CodeV2.WireError(code: .notReady, message: "Your Mac finished this, but its answer was lost on the way and is too large to send again. Try again.")
            )
        }
        let at = entries[id]?.at ?? now()
        entries[id] = Entry(at: at, finished: true, response: directory == nil ? kept : nil)
        writeLocked(Record(id: id, at: at, finished: true, response: kept))
        pruneLocked()
    }

    /// Receipts currently kept (tests).
    var count: Int { lock.withLock { entries.count } }

    // MARK: Storage

    private func load(from directory: URL) {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONDecoder()
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file), let record = try? decoder.decode(Record.self, from: data) else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            if record.finished {
                entries[record.id] = Entry(at: record.at, finished: true)
            } else {
                // Running when the previous launch ended: it may have done part of its work.
                let interrupted = Record(id: record.id, at: record.at, finished: true, response: Self.interrupted(record.id))
                entries[record.id] = Entry(at: record.at, finished: true)
                writeLocked(interrupted)
            }
        }
        pruneLocked()
    }

    private func pruneLocked() {
        let cutoff = now().addingTimeInterval(-keepFor)
        for (id, entry) in entries where entry.at < cutoff {
            entries[id] = nil
            removeLocked(id)
        }
        guard entries.count > limit else { return }
        // Oldest first, finished ones before running ones.
        let drop = entries.sorted { a, b in
            a.value.finished != b.value.finished ? a.value.finished : a.value.at < b.value.at
        }.prefix(entries.count - limit)
        for (id, _) in drop {
            entries[id] = nil
            removeLocked(id)
        }
    }

    private func file(for id: String) -> URL? {
        guard let directory else { return nil }
        let plain = id.count <= 120 && id.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "_" || $0 == "-" }
        let name = plain ? id : "h_" + SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name).appendingPathExtension("json")
    }

    private func writeLocked(_ record: Record) {
        guard let directory, let url = file(for: record.id), let data = try? JSONEncoder().encode(record) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    private func readLocked(_ id: String) -> Record? {
        guard let url = file(for: id), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private func removeLocked(_ id: String) {
        guard let url = file(for: id) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    static func interrupted(_ id: String) -> CodeV2.ServerResponse {
        CodeV2.ServerResponse(
            id: id,
            ok: false,
            error: CodeV2.WireError(code: .notReady, message: "Alevr on your Mac restarted while doing this, so it did not run it again. Check the result before trying again.")
        )
    }

    static func lost(_ id: String) -> CodeV2.ServerResponse {
        CodeV2.ServerResponse(
            id: id,
            ok: false,
            error: CodeV2.WireError(code: .notReady, message: "Your Mac already did this, but its answer was lost on the way. Check the result before trying again.")
        )
    }
}
