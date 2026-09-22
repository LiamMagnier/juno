import Foundation
import JunoCodeCore

/// What a session's transcript amounts to, without the transcript.
///
/// Every list surface reads the session record (`session.json`: title,
/// project, status, dates) and nothing else. A few callers also need facts
/// that only the transcript knows: how many events it holds — which is the
/// next sequence number, and the cursor a thin client resumes from — how many
/// messages were exchanged, when it last moved, and how much code it changed.
/// Each of those used to be answered by decoding the whole of `events.jsonl`,
/// at launch, for every session. This is the same answer kept beside the
/// transcript and updated as it grows.
public struct SessionTranscriptSummary: Hashable, Codable, Sendable {
    /// Lines in `events.jsonl`, readable or not. A line that no longer decodes
    /// still consumed a sequence number when it was written, so it is counted:
    /// this is the sequence the next event receives.
    public private(set) var eventCount: Int
    /// Prompts, instructions sent while working, and replies — the turns the
    /// thread shows as speech rather than as machine work.
    public private(set) var messageCount: Int
    /// The timestamp of the newest event that decodes.
    public private(set) var lastEventAt: Date?
    public private(set) var linesAdded: Int
    public private(set) var linesRemoved: Int
    /// Distinct paths, rather than a running count, so a file edited ten times
    /// is one file — the rule the changes panel and the run's closing line use.
    private var changedPaths: Set<String>

    public var filesChanged: Int { changedPaths.count }

    public static let empty = SessionTranscriptSummary(
        eventCount: 0,
        messageCount: 0,
        lastEventAt: nil,
        linesAdded: 0,
        linesRemoved: 0,
        changedPaths: []
    )

    private init(
        eventCount: Int,
        messageCount: Int,
        lastEventAt: Date?,
        linesAdded: Int,
        linesRemoved: Int,
        changedPaths: Set<String>
    ) {
        self.eventCount = eventCount
        self.messageCount = messageCount
        self.lastEventAt = lastEventAt
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
        self.changedPaths = changedPaths
    }

    /// Folds one transcript line in. `event` is nil for a line that did not
    /// decode, which still counts toward the sequence and nothing else.
    mutating func absorb(_ event: SessionEvent?) {
        eventCount += 1
        guard let event else { return }
        lastEventAt = event.timestamp
        switch event.payload {
        case .userPrompt, .userInstruction, .assistantMessage:
            messageCount += 1
        case let .fileChanged(change):
            linesAdded += change.linesAdded
            linesRemoved += change.linesRemoved
            changedPaths.insert(change.path.value)
        default:
            break
        }
    }
}

/// Decodes one line of `events.jsonl`.
///
/// A seam rather than a hard-coded `JSONDecoder` so a test can count decodes:
/// the promise this store makes — listing sessions never decodes a transcript
/// — is only worth something if it is measured.
struct SessionEventLineDecoder: Sendable {
    let decode: @Sendable (Data) -> SessionEvent?

    static let standard: SessionEventLineDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return SessionEventLineDecoder { line in
            try? decoder.decode(SessionEvent.self, from: line)
        }
    }()
}

/// The store's running account of one `events.jsonl`: the public summary,
/// plus what it takes to trust a saved copy of it on the next launch.
///
/// A saved summary is trusted only for the bytes it says it covers, and only
/// if the last of those bytes are still the bytes it saw. The transcript is
/// append-only, so that pair decides everything: equal length means current;
/// a longer file whose prefix still matches means the app stopped between an
/// append and the next save, and only the appended tail needs reading; any
/// other shape — shorter, rewritten, unreadable, a different format version —
/// means the summary describes a file that no longer exists, and it is rebuilt
/// from the transcript.
struct TranscriptIndex: Equatable, Sendable {
    static let formatVersion = 1
    /// How much of the covered range the fingerprint spans: more than the
    /// shortest event line, so a file cut back and regrown to the same length
    /// does not match by the accident of one repeated line, and little enough
    /// to read on every check.
    static let fingerprintLength = 256

    var summary: SessionTranscriptSummary
    /// Bytes of `events.jsonl` this index accounts for.
    var byteCount: Int
    /// The last `fingerprintLength` of those bytes, kept so the fingerprint
    /// can be recomputed after an append shorter than it.
    var tail: Data

    static let empty = TranscriptIndex(summary: .empty, byteCount: 0, tail: Data())

    var fingerprint: String { Digests.sha256Hex(tail) }

    /// Accounts for bytes appended to the covered range. `bytes` must start
    /// where the covered range ended, and no line may straddle the two: the
    /// store only ever appends whole lines, preceded by a newline when the
    /// file ended in a cut-off one.
    mutating func absorb(_ bytes: Data, decoder: SessionEventLineDecoder) {
        for line in bytes.split(separator: 0x0A) {
            summary.absorb(decoder.decode(Data(line)))
        }
        advance(over: bytes)
    }

    /// Accounts for one event the store has just written as `bytes`, without
    /// decoding what it already holds.
    mutating func absorb(_ event: SessionEvent, writtenAs bytes: Data) {
        summary.absorb(event)
        advance(over: bytes)
    }

    private mutating func advance(over bytes: Data) {
        byteCount += bytes.count
        var combined = tail
        combined.append(bytes)
        tail = Data(combined.suffix(Self.fingerprintLength))
    }
}

/// `summary.json`, as it sits on disk.
struct TranscriptIndexRecord: Codable, Sendable {
    let formatVersion: Int
    let byteCount: Int
    let tailFingerprint: String
    let summary: SessionTranscriptSummary

    init(_ index: TranscriptIndex) {
        formatVersion = TranscriptIndex.formatVersion
        byteCount = index.byteCount
        tailFingerprint = index.fingerprint
        summary = index.summary
    }
}

/// File access for one session's transcript and its summary. Synchronous and
/// free of any actor, so the store can run it on its own executor when an
/// append needs the answer before it can number an event, and on a detached
/// task when nothing is waiting.
enum TranscriptFiles {
    static let summaryFileName = "summary.json"

    struct Loaded: Sendable {
        let index: TranscriptIndex
        /// False when the saved summary was already exact, so nothing needs
        /// writing back.
        let needsSave: Bool
    }

    /// The saved summary, checked against the transcript, caught up or rebuilt
    /// as the checks require.
    static func loadIndex(
        eventsURL: URL,
        summaryURL: URL,
        decoder: SessionEventLineDecoder
    ) -> Loaded {
        let length = regularFileLength(eventsURL) ?? 0
        if let saved = savedRecord(at: summaryURL),
            saved.formatVersion == TranscriptIndex.formatVersion,
            saved.byteCount >= 0,
            saved.byteCount <= length
        {
            let tailStart = max(0, saved.byteCount - TranscriptIndex.fingerprintLength)
            if let tail = bytes(of: eventsURL, in: tailStart..<saved.byteCount),
                Digests.sha256Hex(tail) == saved.tailFingerprint
            {
                var index = TranscriptIndex(
                    summary: saved.summary,
                    byteCount: saved.byteCount,
                    tail: tail
                )
                if saved.byteCount == length {
                    return Loaded(index: index, needsSave: false)
                }
                // Catching up from the middle of a line is only safe when this
                // store wrote what followed, because it ends a cut-off line
                // before appending. An older build would have continued it, so
                // a summary that stops mid-line is rebuilt instead.
                if tail.isEmpty || tail.last == 0x0A,
                    let appended = bytes(of: eventsURL, in: saved.byteCount..<length)
                {
                    index.absorb(appended, decoder: decoder)
                    return Loaded(index: index, needsSave: true)
                }
            }
        }
        return Loaded(
            index: rebuiltIndex(eventsURL: eventsURL, length: length, decoder: decoder),
            needsSave: true
        )
    }

    /// Reads the whole transcript into a fresh index — the path for a session
    /// written before summaries existed, and for any summary that failed its
    /// checks.
    static func rebuiltIndex(
        eventsURL: URL,
        length: Int,
        decoder: SessionEventLineDecoder
    ) -> TranscriptIndex {
        var index = TranscriptIndex.empty
        if length > 0, let data = bytes(of: eventsURL, in: 0..<length) {
            index.absorb(data, decoder: decoder)
        }
        return index
    }

    /// Decodes the first `length` bytes of the transcript — the file as it was
    /// when the caller asked, even if an append lands while it is being read.
    static func events(
        in eventsURL: URL,
        length: Int,
        decoder: SessionEventLineDecoder
    ) -> (events: [SessionEvent], index: TranscriptIndex) {
        var index = TranscriptIndex.empty
        guard length > 0, let data = bytes(of: eventsURL, in: 0..<length) else {
            return ([], index)
        }
        var events: [SessionEvent] = []
        for line in data.split(separator: 0x0A) {
            let event = decoder.decode(Data(line))
            index.summary.absorb(event)
            if let event { events.append(event) }
        }
        index.byteCount = data.count
        index.tail = Data(data.suffix(TranscriptIndex.fingerprintLength))
        return (events, index)
    }

    /// The newest `limit` events that decode, oldest first, read backwards
    /// from the end of the file so a long transcript costs a chunk or two.
    ///
    /// Undecodable lines are skipped rather than counted, which is what the
    /// interruption repair has always compared against: the last two events
    /// the transcript can still show.
    static func trailingEvents(
        in eventsURL: URL,
        limit: Int,
        decoder: SessionEventLineDecoder
    ) -> [SessionEvent] {
        guard limit > 0,
            regularFileLength(eventsURL) != nil,
            let handle = try? FileHandle(forReadingFrom: eventsURL)
        else { return [] }
        defer { try? handle.close() }
        guard var offset = try? handle.seekToEnd(), offset > 0 else { return [] }

        let chunkLength: UInt64 = 64 * 1_024
        var newestFirst: [SessionEvent] = []
        // The front of the previous chunk, which may be the end of a line that
        // began further back.
        var carried = Data()
        while offset > 0, newestFirst.count < limit {
            let start = offset > chunkLength ? offset - chunkLength : 0
            guard (try? handle.seek(toOffset: start)) != nil,
                let read = try? handle.read(upToCount: Int(offset - start))
            else { break }
            var buffer = read
            buffer.append(carried)
            offset = start
            var lines = buffer.split(separator: 0x0A, omittingEmptySubsequences: false)
            carried = start > 0 ? Data(lines.removeFirst()) : Data()
            for line in lines.reversed() where !line.isEmpty {
                guard let event = decoder.decode(Data(line)) else { continue }
                newestFirst.append(event)
                if newestFirst.count == limit { break }
            }
        }
        return newestFirst.reversed()
    }

    static func save(_ index: TranscriptIndex, to summaryURL: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(TranscriptIndexRecord(index))
        // Atomic, so a reader — this process on the next launch, or the
        // background pass of this one — sees the old summary or the new one and
        // never half of each. No intermediate directories: a session deleted
        // while a save was pending must stay deleted.
        try data.write(to: summaryURL, options: .atomic)
    }

    /// The length of a regular file, or nil when there is none at `url`. A
    /// directory or a socket where the transcript should be is treated as no
    /// transcript to read, and left for the next write to fail on loudly.
    static func regularFileLength(_ url: URL) -> Int? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
            attributes[.type] as? FileAttributeType == .typeRegular
        else { return nil }
        return (attributes[.size] as? NSNumber)?.intValue
    }

    private static func savedRecord(at url: URL) -> TranscriptIndexRecord? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(TranscriptIndexRecord.self, from: data)
    }

    private static func bytes(of url: URL, in range: Range<Int>) -> Data? {
        guard !range.isEmpty else { return Data() }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: UInt64(range.lowerBound))) != nil,
            let data = try? handle.read(upToCount: range.count),
            data.count == range.count
        else { return nil }
        return data
    }
}
