import Foundation
import JunoCodeCore

/// A dev server's output, held by the service rather than a view
/// (CODE_AGENT_SPEC §4.2, PV-12): the newest 5,000 lines, each with a
/// monotonic cursor so the model can read "what is new since my last look".
public struct PreviewLogBuffer: Sendable {
    public struct Entry: Equatable, Sendable, Identifiable {
        /// Monotonic across the buffer's life; never reused after a drop.
        public let id: Int
        public let channel: ToolOutputChannel
        public let text: String
        public let at: Date

        public init(id: Int, channel: ToolOutputChannel, text: String, at: Date) {
            self.id = id
            self.channel = channel
            self.text = text
            self.at = at
        }

        /// Whether the line reads as an error: stderr, or the words servers
        /// use for one on stdout.
        public var isError: Bool {
            if channel == .stderr { return true }
            return PreviewLogBuffer.looksLikeError(text)
        }
    }

    public enum Level: String, Sendable {
        case all
        case error
    }

    /// One read of the buffer.
    public struct Page: Equatable, Sendable {
        public var entries: [Entry]
        /// Pass back as `since` to read only what came after.
        public var cursor: Int
        /// Lines that matched but fell out of the buffer before this read.
        public var droppedBefore: Int
        public var totalLines: Int
    }

    public static let defaultCapacity = 5_000
    /// A line longer than this is cut (a minified bundle or a base64 payload
    /// on one line), so 5,000 lines stay a few megabytes, not gigabytes.
    public static let maximumLineLength = 4_096

    public let capacity: Int
    public private(set) var entries: [Entry] = []
    private var nextID = 1
    /// How many lines ever fell out of the front.
    public private(set) var dropped = 0

    public init(capacity: Int = PreviewLogBuffer.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    public var lastID: Int { nextID - 1 }

    @discardableResult
    public mutating func append(channel: ToolOutputChannel, text: String, at: Date = Date()) -> Entry {
        let bounded = text.count > Self.maximumLineLength ? String(text.prefix(Self.maximumLineLength)) + " …" : text
        let entry = Entry(id: nextID, channel: channel, text: bounded, at: at)
        nextID += 1
        entries.append(entry)
        if entries.count > capacity {
            let overflow = entries.count - capacity
            entries.removeFirst(overflow)
            dropped += overflow
        }
        return entry
    }

    public mutating func clear() {
        dropped += entries.count
        entries.removeAll()
    }

    /// Lines after `since` (or the newest `limit` when nil), filtered by level
    /// and a case-insensitive search, newest `limit` kept.
    public func page(since: Int? = nil, level: Level = .all, search: String? = nil, limit: Int = 120) -> Page {
        let bounded = min(max(limit, 1), 500)
        let needle = search?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var matching = entries.filter { entry in
            if let since, entry.id <= since { return false }
            if level == .error, !entry.isError { return false }
            if let needle, !needle.isEmpty, !entry.text.lowercased().contains(needle) { return false }
            return true
        }
        let droppedBefore: Int
        if let since, let first = entries.first, since < first.id - 1 {
            droppedBefore = first.id - 1 - since
        } else {
            droppedBefore = 0
        }
        if matching.count > bounded {
            matching = Array(matching.suffix(bounded))
        }
        return Page(entries: matching, cursor: lastID, droppedBefore: droppedBefore, totalLines: entries.count)
    }

    /// Lines after `since` that read as a compile or server error
    /// (CODE_AGENT_SPEC §4.6 step 2).
    public func compileErrors(since: Int) -> [Entry] {
        entries.filter { $0.id > since && Self.looksLikeCompileError($0.text) }
    }

    /// Error lines after `since`, compile errors included.
    public func errors(since: Int) -> [Entry] {
        entries.filter { $0.id > since && $0.isError }
    }

    static let compileErrorPatterns: [String] = [
        "failed to compile", "module not found", "error ts", "[vite] internal server error",
        "syntaxerror", "build failed", "error: cannot find module", "unhandled runtime error",
        "⨯ ", "error in ", "compiled with problems",
    ]

    public static func looksLikeCompileError(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return compileErrorPatterns.contains { lowered.contains($0) }
    }

    static func looksLikeError(_ text: String) -> Bool {
        let lowered = text.lowercased()
        if looksLikeCompileError(lowered) { return true }
        return lowered.hasPrefix("error") || lowered.contains(" error:") || lowered.contains("exception")
            || lowered.contains("eaddrinuse") || lowered.contains("traceback (most recent call last)")
    }
}

/// Reads a blocked outbound attempt out of a dev server's log, so Juno can ask
/// once whether this project's server may use the internet (§4.2, PV-7).
public enum PreviewNetworkHints {
    /// The host a line shows the server failing to reach, or nil.
    public static func blockedHost(in line: String) -> String? {
        let lowered = line.lowercased()
        if lowered.contains("google fonts") || lowered.contains("fonts.googleapis.com") || lowered.contains("fonts.gstatic.com") {
            if lowered.contains("fail") || lowered.contains("error") || lowered.contains("enotfound") {
                return "fonts.googleapis.com"
            }
        }
        for marker in ["enotfound ", "eai_again ", "getaddrinfo enotfound "] {
            if let range = lowered.range(of: marker) {
                let tail = line[range.upperBound...]
                if let host = tail.split(whereSeparator: { " ,;)'\"".contains($0) }).first {
                    let value = host.trimmingCharacters(in: CharacterSet(charactersIn: ".:"))
                    if !value.isEmpty, !PreviewOrigin.isLoopbackHost(value) { return value }
                }
            }
        }
        if let range = lowered.range(of: "connect eperm ") {
            let tail = line[range.upperBound...]
            if let address = tail.split(separator: " ").first {
                let host = address.split(separator: ":").dropLast().joined(separator: ":")
                let value = host.isEmpty ? String(address) : host
                if !PreviewOrigin.isLoopbackHost(value) { return value }
            }
        }
        if lowered.contains("fetch failed") || lowered.contains("request to http") {
            if let url = line.split(separator: " ").compactMap({ URL(string: String($0)) }).first(where: { $0.host != nil }),
               let host = url.host, !PreviewOrigin.isLoopbackHost(host)
            {
                return host
            }
        }
        return nil
    }
}
