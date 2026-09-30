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

    /// What a session's saved outputs may take on disk together. Past it the
    /// oldest go as a new one starts, so a long session of long builds cannot
    /// fill the disk a few hundred megabytes at a time; a path handed out
    /// earlier then reads as no longer saved, which is the truth.
    public static let sessionBudgetBytes = 512 * 1_024 * 1_024

    /// A file for one call's output, in `directory`, named after the call.
    ///
    /// A provider that numbers its calls afresh each turn reuses an id, and a
    /// later output must not overwrite one the model was already pointed at,
    /// so a name that is taken gets a numeral.
    public init(directory: URL, toolCallID: String) {
        let safe = String(
            toolCallID.unicodeScalars
                .map { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" ? Character($0) : "_" }
                .prefix(100)
        )
        let base = safe.isEmpty ? "output" : safe
        var name = base + ".log"
        var numeral = 2
        while FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) {
            name = "\(base)-\(numeral).log"
            numeral += 1
        }
        fileName = name
        url = directory.appendingPathComponent(fileName)
    }

    /// Removes the oldest saved outputs in `directory`, `sparing` aside,
    /// until the rest fit within `budget` bytes.
    static func prune(_ directory: URL, toFit budget: Int, sparing: URL) {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return }
        let spared = sparing.standardizedFileURL.path
        var saved = files.compactMap { file -> (url: URL, date: Date, size: Int)? in
            guard file.pathExtension == "log",
                  file.standardizedFileURL.path != spared,
                  let values = try? file.resourceValues(forKeys: keys)
            else { return nil }
            return (file, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }
        var total = saved.reduce(0) { $0 + $1.size }
        guard total > budget else { return }
        saved.sort { $0.date < $1.date }
        for file in saved {
            guard total > budget else { break }
            try? FileManager.default.removeItem(at: file.url)
            total -= file.size
        }
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

        public init(spill: CommandOutputSpill, sessionBudgetBytes: Int = CommandOutputSpill.sessionBudgetBytes) {
            let directory = spill.url.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            CommandOutputSpill.prune(directory, toFit: sessionBudgetBytes, sparing: spill.url)
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

/// One command's output as it streams: every byte to the session's spill
/// file, both ends in memory for the result, and the transcript up to its own
/// budget. Shared by `run_command` and `run_tests`, so neither is stopped at
/// the transcript's limit nor loses the end a failing build prints last.
struct CommandOutputCapture {
    let spill: CommandOutputSpill?
    private let writer: CommandOutputSpill.Writer?
    private(set) var ends: HeadTailBuffer
    private var transcriptBytes = 0
    private var transcriptFull = false

    /// The limit the command itself runs under. The same with or without a
    /// file to spill to: the ends are what the result needs, and memory holds
    /// only those.
    static let outputLimit = OutputLimit(maximumBytes: CommandOutputSpill.ceilingBytes)

    /// What a result says when the command reached that limit and was stopped.
    static let ceilingNote = "stopped after printing \(CommandOutputSpill.ceilingBytes / 1_024 / 1_024) MB"

    init(context: ToolContext, headBytes: Int, tailBytes: Int) {
        spill = context.commandOutputDirectory.map {
            CommandOutputSpill(directory: $0, toolCallID: context.toolCallID)
        }
        writer = spill.map { CommandOutputSpill.Writer(spill: $0) }
        ends = HeadTailBuffer(headBytes: headBytes, tailBytes: tailBytes)
    }

    /// Takes one chunk: to the file, to the ends, and to the transcript while
    /// it has room.
    mutating func take(_ channel: ToolOutputChannel, _ text: String, context: ToolContext) async {
        writer?.write(text)
        ends.append(text)
        guard !transcriptFull else { return }
        transcriptBytes += text.utf8.count
        if transcriptBytes <= OutputLimit.commandOutput.maximumBytes {
            await context.emitOutput(channel, text)
        } else {
            transcriptFull = true
            await context.emitOutput(channel, "\n… [the rest of this output is not shown here]\n")
        }
    }

    /// Closes the file, and removes it when the output fit the result whole:
    /// there is nothing in it the model has not been given.
    func finish() {
        writer?.close()
        if ends.isWhole, let spill {
            try? FileManager.default.removeItem(at: spill.url)
        }
    }

    /// The output for the tool result: whole when it fit, and otherwise its
    /// two ends around a note of how much was left out and, when it was
    /// saved, where to read it.
    func rendered() -> String {
        if ends.isWhole {
            return ends.joined { _ in "" }
        }
        if let spill, writer?.isOpen == true {
            return ends.joined { omitted in
                "\n… [\(omitted) bytes omitted. The whole output (\(ends.totalBytes) bytes) is saved: read it with read_file, path \"\(spill.modelPath)\", paging with offset and limit.] …\n"
            }
        }
        return ends.joined { omitted in "\n… [\(omitted) bytes omitted] …\n" }
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
