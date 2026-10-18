import Foundation

// MARK: - The pacer

/// Turns a reply that arrives in bursts into text that reaches the screen at a
/// steady reading cadence: the web's `src/lib/chat/stream-pacer.ts`, ported
/// line for line.
///
/// The shown text trails the received text by a small, deliberate buffer, and
/// a velocity follows the arrival *rate*: chunks that land 300 characters at a
/// time on an irregular clock come out as a few characters every frame. When
/// the shown text falls behind it catches up quickly (a backlog drains in well
/// under a second), and a huge backlog (a reconnect replay, an app that slept)
/// is cut to the last screenful at once. ``revealCut(in:shown:)`` snaps a
/// release forward to the end of the word it lands in, so a word never appears
/// half-written. The caller flushes to the full text when the stream ends.
///
/// **One spec, two platforms.** The constants and the expected shown length
/// for a set of recorded arrival traces live in
/// `contracts/chat/stream-pacer.v1.json`, generated from the web pacer; the
/// web test and `JunoStreamPacerContractTests` both replay it, so Mac, iPhone
/// and web reveal the same text at the same moment (REA chat UX test T4).
///
/// Units match the web: lengths are UTF-16 code units, times milliseconds.
/// Pure value logic — the view owns the clock.
public struct JunoStreamPacer: Equatable, Sendable {
    /// `PACER` in stream-pacer.ts. Held equal to the contract by test.
    public enum Constants {
        /// First guess at the arrival rate before any measurement (chars/s).
        public static let initialRate: Double = 260
        public static let minRate: Double = 40
        public static let maxRate: Double = 4000
        /// How far behind the received text the shown text sits by design
        /// (seconds of arrival).
        public static let bufferSeconds: Double = 0.12
        /// Time constant for draining a backlog above the buffer (s).
        public static let drainSeconds: Double = 0.38
        /// Arrival-rate smoothing time constant (ms).
        public static let rateTau: Double = 900
        /// A backlog larger than this jumps to within `jumpKeep` of the end.
        public static let jumpAbove: Double = 2400
        public static let jumpKeep: Double = 320
        /// The longest snap to a word end, in characters.
        public static let wordSnap: Int = 18
    }

    /// Characters shown, fractional (the velocity integrates here).
    public private(set) var shown: Double
    /// Arrival rate estimate, characters per second.
    public private(set) var rate: Double
    /// Received length at the last arrival, and when it arrived (ms).
    public private(set) var lastLength: Int
    public private(set) var lastArrival: Double

    /// `initPacer`: a pacer that starts with `length` already shown.
    public init(length: Int = 0, now: Double = 0) {
        shown = Double(length)
        rate = Constants.initialRate
        lastLength = length
        lastArrival = now
    }

    /// `pacerArrive`: the received text is now `length` long.
    public mutating func arrive(length: Int, now: Double) {
        if length == lastLength { return }
        if length < lastLength {
            // The text was replaced (an edit, a regenerate): start over from it.
            shown = min(shown, Double(length))
            lastLength = length
            lastArrival = now
            return
        }
        let dt = max(16, now - lastArrival)
        let instant = Double(length - lastLength) / dt * 1000
        // A gap longer than a second says nothing about the rate within a
        // burst: weigh it lightly.
        let alpha = 1 - exp(-min(dt, 1000) / Constants.rateTau)
        rate = min(Constants.maxRate, max(Constants.minRate, rate + (instant - rate) * alpha))
        lastLength = length
        lastArrival = now
    }

    /// `pacerStep`: advance the shown length by one frame of `dtMs`.
    public mutating func step(length: Int, dtMs: Double) {
        let target = Double(length)
        let backlog = target - shown
        if backlog <= 0 {
            shown = target
            return
        }
        if backlog > Constants.jumpAbove {
            shown = target - Constants.jumpKeep
            return
        }
        let dt = min(0.1, dtMs / 1000)
        let buffer = rate * Constants.bufferSeconds
        // Follow the arrival rate, plus a proportional pull on whatever sits
        // above the buffer.
        let velocity = max(rate * 0.35, rate + (backlog - buffer) / Constants.drainSeconds)
        shown = min(target, shown + velocity * dt)
    }

    /// Shows everything received at once: the reader scrolled, copied, or
    /// left the app, and nothing should still be trickling in.
    public mutating func flush(to length: Int) {
        shown = Double(length)
    }

    /// `revealCut`: the UTF-16 offset to cut `text` at for a fractional
    /// `shown` — forward to the end of the word it lands in (when that end has
    /// arrived and is close), back to the word's start when it has not, and
    /// never inside a surrogate pair.
    public static func revealCut(in text: String, shown: Double) -> Int {
        let units = text.utf16
        let length = units.count
        var cut = min(length, max(0, Int(shown.rounded(.down))))
        if cut >= length || cut == 0 { return cut }
        // Only the few units around the cut are ever read.
        func unit(_ offset: Int) -> UInt16 { units[units.index(units.startIndex, offsetBy: offset)] }
        func isWord(_ offset: Int) -> Bool { !isJavaScriptSpace(unit(offset)) }

        if isWord(cut - 1), isWord(cut) {
            let limit = min(length, cut + Constants.wordSnap)
            var end = cut
            while end < limit, isWord(end) { end += 1 }
            if end < length, end < limit {
                cut = end
            } else {
                // The word's end has not arrived yet: hold at its start rather
                // than show half of it.
                var start = cut
                while start > 0, cut - start < Constants.wordSnap, isWord(start - 1) { start -= 1 }
                if start > 0, cut - start < Constants.wordSnap { cut = start }
            }
        }
        if (0xD800...0xDBFF).contains(unit(cut - 1)) { cut += 1 }
        return cut
    }

    /// JavaScript's `\s`, unit by unit, so `\S` means here what it means on
    /// the web.
    static func isJavaScriptSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}

// MARK: - Ink

/// The ink-in fade: the newest characters arrive faint and reach full ink in
/// five age bands over `--stream-band` (280ms). The same five steps the web
/// paints with `::highlight(stream-f0…4)`; held to the contract by test.
public enum JunoStreamInk {
    /// Ink per band, newest first. The first band is 35% ink (spec C2).
    public static let opacity: [Double] = [0.35, 0.52, 0.68, 0.82, 0.92]
    public static var bands: Int { opacity.count }
    /// One band's age span: `--stream-band` / 5 (56ms).
    public static let bandDuration: TimeInterval = JunoGeneratedTiming.streamBand / Double(opacity.count)
}

/// When each stretch of the shown text was released, so its ink can be read
/// off its age: the web's `born` list in stream-text.tsx.
public struct JunoStreamInkClock: Equatable, Sendable {
    private struct Birth: Equatable, Sendable {
        var length: Int
        var at: TimeInterval
    }

    private var births: [Birth] = []

    public init() {}

    /// The shown text is now `length` long at `now` (seconds). The first call
    /// is the baseline: text already there when pacing began does not fade.
    public mutating func record(length: Int, now: TimeInterval) {
        guard let previous = births.last else {
            births = [Birth(length: length, at: now - 10)]
            return
        }
        if length < previous.length {
            births = [Birth(length: length, at: now - 10)]
        } else if length > previous.length {
            births.append(Birth(length: length, at: now))
        }
    }

    /// How many trailing characters sit in each band, cumulative from the end
    /// and newest first; empty when nothing is fading.
    public mutating func bands(now: TimeInterval) -> [Int] {
        let life = JunoStreamInk.bandDuration * Double(JunoStreamInk.bands)
        // Keep one entry older than the fade as the baseline.
        while births.count > 1, now - births[1].at > life { births.removeFirst() }
        guard births.count >= 2 else { return [] }
        var counts = [Int](repeating: 0, count: JunoStreamInk.bands)
        var any = false
        for index in 1..<births.count {
            let band = Int(((now - births[index].at) / JunoStreamInk.bandDuration).rounded(.down))
            guard band < JunoStreamInk.bands else { continue }
            let added = births[index].length - births[index - 1].length
            guard added > 0 else { continue }
            counts[max(0, band)] += added
            any = true
        }
        guard any else { return [] }
        var running = 0
        return counts.map { running += $0; return running }
    }
}

// MARK: - The settled prefix

/// Where a streaming reply can be cut into a settled prefix and a live tail.
///
/// The prefix is drawn once and left alone; only the tail re-lays out as words
/// are released, so a long answer costs the same per frame as a short one. A
/// cut is only safe where rendering the two halves separately draws what the
/// whole would: the start of a line that follows a blank line, outside every
/// fence, math block, `:::` block and `<juno:…>` tag, and starting with plain
/// prose or a heading — never a list item, quote, table row, link definition,
/// tag or indented line, which would join the block before it.
public enum JunoStreamSettle {
    /// Every safe cut in `text` after the UTF-16 offset `from` (itself a safe
    /// cut, or 0) and before `to`, in order. Reads only that range, so a caller
    /// that advances `from` as it settles scans each line about once.
    public static func boundaries(in text: String, from: Int, to: Int) -> [Int] {
        let units = text.utf16
        guard to > from, from >= 0, to <= units.count else { return [] }
        let start = units.index(units.startIndex, offsetBy: from)
        let end = units.index(start, offsetBy: to - from)
        let slice = Array(units[start..<end])

        var found: [Int] = []
        var fence: UInt16? = nil  // ` or ~ while inside a fence
        var math = false
        var colonDepth = 0
        var tagDepth = 0
        var previousBlank = false
        var lineStart = 0
        while lineStart < slice.count {
            var lineEnd = lineStart
            while lineEnd < slice.count, slice[lineEnd] != 0x0A { lineEnd += 1 }
            let line = slice[lineStart..<lineEnd]

            if previousBlank, fence == nil, !math, colonDepth == 0, tagDepth == 0,
                let first = line.first, startsProse(first)
            {
                found.append(from + lineStart)
            }

            let trimmed = line.drop { $0 == 0x20 }
            let indent = line.count - trimmed.count
            if let marker = fence {
                if indent <= 3, trimmed.prefix(3).allSatisfy({ $0 == marker }), trimmed.count >= 3 { fence = nil }
            } else if indent <= 3, trimmed.count >= 3, let mark = trimmed.first, mark == 0x60 || mark == 0x7E,
                trimmed.prefix(3).allSatisfy({ $0 == mark })
            {
                fence = mark
            } else {
                if count(of: [0x24, 0x24], in: line) % 2 == 1 { math.toggle() }
                if !math {
                    if trimmed.starts(with: [0x3A, 0x3A, 0x3A]) {
                        let rest = trimmed.dropFirst(3).drop { $0 == 0x20 || $0 == 0x0D }
                        colonDepth = rest.isEmpty ? max(0, colonDepth - 1) : colonDepth + 1
                    }
                    tagDepth += count(of: Array("<juno:".utf16), in: line)
                    tagDepth = max(0, tagDepth - count(of: Array("</juno:".utf16), in: line))
                }
            }
            previousBlank = line.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
            lineStart = lineEnd + 1
        }
        return found
    }

    /// Plain prose or a heading: not whitespace, a list or quote marker, a
    /// table, a tag, a link definition, a fence, math, a `:::` block, or a
    /// number that could start an ordered list.
    private static func startsProse(_ first: UInt16) -> Bool {
        switch first {
        case 0x20, 0x09, 0x0D, 0x2D, 0x2A, 0x2B, 0x3E, 0x7C, 0x5B, 0x3C, 0x3A, 0x24, 0x7E, 0x60, 0x3D, 0x5F:
            return false
        case 0x30...0x39:
            return false
        default:
            return true
        }
    }

    private static func count(of needle: [UInt16], in haystack: ArraySlice<UInt16>) -> Int {
        guard needle.count <= haystack.count, let head = needle.first else { return 0 }
        var hits = 0
        var index = haystack.startIndex
        let last = haystack.endIndex - needle.count
        while index <= last {
            if haystack[index] == head, haystack[index..<(index + needle.count)].elementsEqual(needle) {
                hits += 1
                index += needle.count
            } else {
                index += 1
            }
        }
        return hits
    }
}
