import Foundation
import JunoCodeCore

/// Command output too long to return whole, kept in full in the session's
/// folder and paged with `read_file`.
///
/// A command used to be killed once it had printed 2 MB, which lost the tail
/// — where a build prints its error — and cut long builds short. Now every
/// byte goes to a file as it arrives, the tool result carries the head and the
/// tail, and the model is told the path to read the middle from. The kill is a
/// separate ceiling, far above any real build, that exists only to stop a
/// runaway command filling the disk.
public struct CommandOutputSpill: Sendable {
    /// How the model names a saved output to `read_file`.
    public static let pathPrefix = "juno://command-output/"
    /// The most a command may print before it is stopped.
    public static let ceilingBytes = 256 * 1_024 * 1_024

    public let fileName: String
    public let url: URL

    /// The model-facing path for this output.
    public var modelPath: String { Self.pathPrefix + fileName }

    /// A file for one call's output, in `directory`.
    public init(directory: URL, toolCallID: String) {
        let safe = String(
            toolCallID.unicodeScalars
                .map { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" ? Character($0) : "_" }
                .prefix(100)
        )
        fileName = (safe.isEmpty ? "output" : safe) + ".log"
        url = directory.appendingPathComponent(fileName)
    }

    /// The saved output `path` names, when it names one in `directory`:
    /// a plain file name, nothing that climbs out of the folder.
    public static func resolve(_ path: String, in directory: URL?) -> URL? {
        guard let directory, path.hasPrefix(pathPrefix) else { return nil }
        let name = String(path.dropFirst(pathPrefix.count))
        guard !name.isEmpty, name.count <= 120, name.hasSuffix(".log"),
              name.unicodeScalars.allSatisfy({
                  ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "_" || $0 == "-" || $0 == "."
              }),
              !name.hasPrefix(".")
        else { return nil }
        return directory.appendingPathComponent(name)
    }

    // MARK: - Writing

    /// Appends to the file as output arrives. Not thread-safe; one command
    /// streams into one writer.
    public final class Writer {
        private let handle: FileHandle?
        public private(set) var bytesWritten = 0

        public init(spill: CommandOutputSpill) {
            let directory = spill.url.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: spill.url.path, contents: nil)
            handle = try? FileHandle(forWritingTo: spill.url)
        }

        /// Whether the file could be opened at all.
        public var isOpen: Bool { handle != nil }

        public func write(_ text: String) {
            let data = Data(text.utf8)
            bytesWritten += data.count
            try? handle?.write(contentsOf: data)
        }

        public func close() {
            try? handle?.close()
        }
    }

    // MARK: - Reading

    /// A window of a saved output, rendered like a `read_file` window: a JSON
    /// header, then the lines. Streamed, so a file of any size is paged
    /// without holding it in memory.
    public static func render(
        url: URL,
        modelPath: String,
        offset: Int?,
        limit: Int?,
        maximumBytes: Int
    ) throws -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw ToolError.invalidInput(message: "No saved command output at \(modelPath).")
        }
        defer { try? handle.close() }
        let start = max(1, offset ?? 1)
        let count = max(1, limit ?? ReadFileTool.defaultLineLimit)

        var lineNumber = 1
        var current = Data()
        var shown: [String] = []
        var used = 0
        var lastShown = start - 1
        var stoppedForBytes = false
        var totalLines = 0
        func finishLine(_ line: Data) {
            totalLines = lineNumber
            if lineNumber >= start, lineNumber < start + count, !stoppedForBytes {
                let text = String(decoding: line, as: UTF8.self)
                let cost = text.utf8.count + (shown.isEmpty ? 0 : 1)
                if used + cost <= maximumBytes {
                    shown.append(text)
                    used += cost
                    lastShown = lineNumber
                } else if shown.isEmpty {
                    // One line longer than the budget: its head, so paging
                    // can get past it.
                    shown.append(String(decoding: line.prefix(maximumBytes), as: UTF8.self))
                    lastShown = lineNumber
                    stoppedForBytes = true
                } else {
                    stoppedForBytes = true
                }
            }
            lineNumber += 1
        }
        while let chunk = try handle.read(upToCount: 256 * 1_024), !chunk.isEmpty {
            var rest = chunk[...]
            while let newline = rest.firstIndex(of: 0x0A) {
                current.append(contentsOf: rest[..<newline])
                finishLine(current)
                current.removeAll(keepingCapacity: true)
                rest = rest[rest.index(after: newline)...]
            }
            current.append(contentsOf: rest)
        }
        if !current.isEmpty { finishLine(current) }

        guard start <= max(totalLines, 1) else {
            return "{\"path\":\(jsonString(modelPath)),\"total_lines\":\(totalLines),\"note\":\"offset is past the end of the output\"}\n"
        }
        var header = [
            "\"path\":\(jsonString(modelPath))",
            "\"first_line\":\(start)",
            "\"last_line\":\(lastShown)",
            "\"total_lines\":\(totalLines)",
        ]
        if lastShown < totalLines {
            header.append("\"note\":\(jsonString("partial read; pass offset \(lastShown + 1) to continue"))")
        }
        return "{\(header.joined(separator: ","))}\n" + shown.joined(separator: "\n")
    }

    private static func jsonString(_ value: String) -> String {
        (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }
}

/// The first and last bytes of a stream too long to keep whole.
///
/// The head says what the command was doing; the tail holds what it printed
/// last, which for a failing build is the error. Everything is counted, so the
/// result can say how much was left out.
public struct HeadTailBuffer: Sendable {
    public let headBytes: Int
    public let tailBytes: Int
    public private(set) var head = ""
    /// What followed the head, up to twice `tailBytes`: trimmed in batches
    /// rather than on every chunk, which would copy the tail each time.
    private var tailStorage = ""
    public private(set) var totalBytes = 0
    private var headFull = false

    public init(headBytes: Int, tailBytes: Int) {
        self.headBytes = headBytes
        self.tailBytes = tailBytes
    }

    public var isWhole: Bool { totalBytes <= headBytes + tailBytes }

    /// The last `tailBytes` of what followed the head.
    public var tail: String {
        let excess = tailStorage.utf8.count - tailBytes
        guard excess > 0 else { return tailStorage }
        return String(Self.suffix(tailStorage[...], droppingAtLeast: excess))
    }

    public mutating func append(_ text: String) {
        totalBytes += text.utf8.count
        var remaining = Substring(text)
        if !headFull {
            let room = headBytes - head.utf8.count
            let taken = Self.prefix(remaining, fittingBytes: room)
            head += taken
            remaining = remaining.dropFirst(taken.count)
            if !remaining.isEmpty { headFull = true }
        }
        guard !remaining.isEmpty else { return }
        tailStorage += remaining
        if tailStorage.utf8.count > 2 * tailBytes {
            tailStorage = tail
        }
    }

    /// Everything, when it fit; otherwise the two ends around `marker`.
    public func joined(marker: (_ omittedBytes: Int) -> String) -> String {
        guard !isWhole else { return head + tailStorage }
        let tail = self.tail
        let omitted = totalBytes - head.utf8.count - tail.utf8.count
        return head + marker(omitted) + tail
    }

    private static func prefix(_ text: Substring, fittingBytes bytes: Int) -> Substring {
        guard bytes > 0 else { return text.prefix(0) }
        var used = 0
        var end = text.startIndex
        for index in text.indices {
            let size = text[index].utf8.count
            if used + size > bytes { break }
            used += size
            end = text.index(after: index)
        }
        return text[..<end]
    }

    private static func suffix(_ text: Substring, droppingAtLeast bytes: Int) -> Substring {
        var dropped = 0
        var start = text.startIndex
        while dropped < bytes, start < text.endIndex {
            dropped += text[start].utf8.count
            start = text.index(after: start)
        }
        return text[start...]
    }
}
