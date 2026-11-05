import Foundation
import SwiftUI

// MARK: - What the screen is told

/// The live writing state a paced reply hands down to its prose: how much of
/// the trailing text sits in each ink band.
///
/// Set by ``JunoPacedStream`` and scoped by the views beneath it to the *last*
/// thing being written — the last segment, the last block, the last list item
/// — so earlier paragraphs never fade.
public struct JunoStreamReveal: Equatable, Sendable {
    /// Trailing glyphs in each ink band, cumulative from the end and newest
    /// first (``JunoStreamInkClock/bands(now:)``). Empty when all is solid.
    public var bands: [Int]
    /// Whether this text is being written right now. The settled prefix of a
    /// live reply says `false`: solid, and its blocks are simply there.
    public var isLive: Bool

    public init(bands: [Int], isLive: Bool = true) {
        self.bands = bands
        self.isLive = isLive
    }

    /// A tail of `span` glyphs spread evenly over the five bands — for a
    /// snapshot posing a mid-stream fade.
    public init(span: Double) {
        let count = JunoStreamInk.bands
        self.init(bands: (0..<count).map { Int((span * Double($0 + 1) / Double(count)).rounded(.up)) })
    }

    /// Text that belongs to a live reply but is no longer being written.
    public static let settled = JunoStreamReveal(bands: [], isLive: false)

    /// Glyphs still fading in.
    public var span: Int { bands.last ?? 0 }

    /// The ink of the glyph `fromEnd` places from the end (1 is the last).
    public func ink(fromEnd: Int) -> Double {
        for (band, reach) in bands.enumerated() where fromEnd <= reach {
            return JunoStreamInk.opacity[min(band, JunoStreamInk.opacity.count - 1)]
        }
        return 1
    }
}

public extension EnvironmentValues {
    /// The reply being written, or nil for text that is not streaming.
    @Entry var junoStreamReveal: JunoStreamReveal? = nil
    /// Bumped by a transcript when the reader takes over — a scroll, a copy —
    /// so every paced reply shows what it has at once.
    @Entry var junoStreamFlush: Int = 0
    /// This prose continues a run drawn above it (the live tail under a
    /// settled prefix): its first block is not the reply's first block.
    @Entry var junoProseContinuesRun: Bool = false
}

// MARK: - The paced stream

/// Paces a streaming reply and hands its children the text to draw.
///
/// ```swift
/// JunoPacedStream(message.content, live: message.isPending) { text in
///     JunoLessonText(text, streaming: message.isPending)
/// }
/// ```
///
/// While `live`, on every display frame (`TimelineView(.animation)`):
///
/// - **Pacing.** The text shown runs a beat behind the text received
///   (``JunoStreamPacer``, the web's pacer), released a whole word at a time
///   and tidied so half-written Markdown never flashes as syntax
///   (``JunoStreamTidy``).
/// - **Ink.** The newest words fade in over five bands (``JunoStreamInk``),
///   drawn by a `TextRenderer` over the text already laid out — no per-word
///   views, no re-layout for the fade.
/// - **Append-only.** Finished paragraphs move into a settled prefix that is
///   drawn once (an `Equatable` view over its text) and never re-parsed or
///   re-laid out; only the tail being written is (``JunoStreamSettle``).
/// - **Flush.** Everything received shows at once when the reader scrolls or
///   copies (``EnvironmentValues/junoStreamFlush``), when the app is not
///   active, and when the stream ends. Then the last fade finishes and the
///   reply settles into one ordinary render of its whole text.
///
/// Under Reduce Motion the text is still paced — it is how text arrives, not
/// movement (REA test T5, and the web's rule) — but nothing fades or rises.
public struct JunoPacedStream<Content: View>: View {
    private let source: String
    private let live: Bool
    private let content: (String) -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.junoStreamFlush) private var flush
    @Environment(\.junoProseStyle) private var style
    @Environment(\.junoTextScale) private var textScale
    @State private var engine = JunoPacedStreamEngine()
    /// The fade still finishing after the stream ended.
    @State private var settling = false

    public init(_ source: String, live: Bool, @ViewBuilder content: @escaping (String) -> Content) {
        self.source = source
        self.live = live
        self.content = content
    }

    public var body: some View {
        TimelineView(.animation(paused: !(live || settling))) { context in
            let frame = engine.frame(
                source: source,
                live: live,
                now: context.date.timeIntervalSinceReferenceDate,
                drain: scenePhase != .active,
                flush: flush,
                reduceMotion: reduceMotion
            )
            draw(frame)
        }
        .onChange(of: live) { wasLive, isLive in
            if wasLive, !isLive { settling = true }
        }
        .task(id: settling) {
            guard settling else { return }
            // The last fade's life, and one band of slack, then one final
            // render of the whole reply.
            try? await Task.sleep(for: .seconds(JunoGeneratedTiming.streamBand + JunoStreamInk.bandDuration))
            settling = false
        }
    }

    private func draw(_ frame: JunoPacedStreamEngine.Frame) -> some View {
        VStack(alignment: .leading, spacing: gap) {
            if !frame.prefix.isEmpty {
                JunoSettledRun(text: frame.prefix, content: content)
                    .equatable()
                    .environment(\.junoStreamReveal, .settled)
            }
            content(frame.tail)
                .environment(\.junoProseContinuesRun, !frame.prefix.isEmpty)
                // Only a stream this view is pacing says so; otherwise
                // whatever the surroundings set stands (an offscreen snapshot
                // can pose a mid-stream fade that way).
                .transformEnvironment(\.junoStreamReveal) { reveal in
                    if frame.paced { reveal = frame.reveal }
                }
        }
    }

    /// The gap the prose itself puts between blocks, so the seam between the
    /// settled prefix and the tail is invisible.
    private var gap: CGFloat {
        style == .reading ? JunoProseMetrics.blockGap * textScale : JunoMarkdownText.blockSpacing
    }
}

/// The settled prefix: redrawn only when its text changes, which is once per
/// finished paragraph rather than once per frame.
private struct JunoSettledRun<Content: View>: View, Equatable {
    let text: String
    let content: (String) -> Content

    var body: some View { content(text) }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text }
}

/// The paced stream's clock-driven state. A plain class read and advanced from
/// the timeline's content, deliberately not observable: a frame is a function
/// of the display clock, and publishing it would invalidate the view a second
/// time per frame.
@MainActor
final class JunoPacedStreamEngine {
    struct Frame: Equatable {
        /// The settled prefix, drawn once; empty when there is none.
        var prefix: String
        /// The text being written (or the whole reply, once settled).
        var tail: String
        /// What the tail's prose is told; nil under Reduce Motion.
        var reveal: JunoStreamReveal?
        /// Whether this view is pacing (live, or finishing its last fade).
        var paced: Bool
    }

    private var pacer: JunoStreamPacer?
    private var lastTick: Double?
    private var ink = JunoStreamInkClock()
    private var wasLive = false
    private var flushSeen: Int?
    /// The settled prefix and its UTF-16 length.
    private var prefix = ""
    private var committed = 0
    /// Safe cuts seen in the tail, and when each was first seen. One commits
    /// once the text before it has finished its fade.
    private var candidates: [(offset: Int, seenAt: TimeInterval)] = []

    init() {}

    func frame(source: String, live: Bool, now: TimeInterval, drain: Bool, flush: Int, reduceMotion: Bool) -> Frame {
        let length = source.utf16.count
        defer { flushSeen = flush }

        // Text replaced under the prefix (a retry, an edit): start over.
        if committed > 0, length < committed || !Self.extends(source, prefix) {
            resetPrefix()
        }

        var cut = length
        if live {
            wasLive = true
            let ms = now * 1000
            var next = pacer ?? JunoStreamPacer(length: length, now: ms)
            let dt = max(0, ms - (lastTick ?? ms))
            lastTick = ms
            next.arrive(length: length, now: ms)
            next.step(length: length, dtMs: dt)
            if drain || (flushSeen.map { $0 != flush } ?? false) { next.flush(to: length) }
            pacer = next
            cut = JunoStreamTidy.boundary(in: source, at: JunoStreamPacer.revealCut(in: source, shown: next.shown))
        } else {
            pacer = nil
            lastTick = nil
        }

        guard wasLive else {
            return Frame(prefix: "", tail: source, reveal: nil, paced: false)
        }
        ink.record(length: cut, now: now)
        let bands = ink.bands(now: now)
        if !live, bands.isEmpty || drain {
            // Finished, and the last fade is done: one ordinary render.
            wasLive = false
            ink = JunoStreamInkClock()
            resetPrefix()
            return Frame(prefix: "", tail: source, reveal: nil, paced: false)
        }

        settle(source: source, upTo: cut, now: now)
        let tailText = Self.slice(source, from: committed, to: cut)
        return Frame(
            prefix: prefix,
            tail: live ? JunoStreamTidy.tidy(tailText) : tailText,
            reveal: reduceMotion ? nil : JunoStreamReveal(bands: bands),
            paced: true
        )
    }

    /// Moves finished paragraphs into the prefix: the newest safe cut whose
    /// text has been shown for a whole fade, so nothing still fading moves.
    private func settle(source: String, upTo cut: Int, now: TimeInterval) {
        let known = candidates.last?.offset ?? committed
        for offset in JunoStreamSettle.boundaries(in: source, from: committed, to: cut) where offset > known {
            candidates.append((offset, now))
        }
        guard let ready = candidates.last(where: { now - $0.seenAt >= JunoGeneratedTiming.streamBand }) else { return }
        committed = ready.offset
        prefix = Self.slice(source, from: 0, to: committed)
        candidates.removeAll { $0.offset <= committed }
    }

    private func resetPrefix() {
        prefix = ""
        committed = 0
        candidates = []
    }

    /// A native slice between two UTF-16 offsets that sit on character
    /// boundaries (a reveal cut, a line start). Native rather than bridged
    /// through NSString, so the Markdown parser downstream walks UTF-8.
    static func slice(_ text: String, from start: Int, to end: Int) -> String {
        let lower = String.Index(utf16Offset: start, in: text)
        let upper = String.Index(utf16Offset: max(start, end), in: text)
        return String(text[lower..<upper])
    }

    /// Whether `text` still begins with `prefix`. Checks the prefix's last
    /// stretch, where the settled text meets the tail: a reply replaced
    /// under a settled prefix (a retry) restarts shorter, and is caught by
    /// length first, so the whole prefix is not compared on every frame.
    static func extends(_ text: String, _ prefix: String) -> Bool {
        let window = 256
        let bytes = prefix.utf8.count
        guard text.utf8.count >= bytes else { return false }
        let from = max(0, bytes - window)
        let a = text.utf8.index(text.utf8.startIndex, offsetBy: from)
        let b = prefix.utf8.index(prefix.utf8.startIndex, offsetBy: from)
        return text.utf8[a...].starts(with: prefix.utf8[b...])
    }
}

// MARK: - Tidy tails

/// Keeps half-written Markdown from flashing as syntax while it streams.
///
/// Applied only to the *shown* text of a live reply; the stored text is never
/// touched. Three rules, the ones that cover what visibly flickered:
///
/// 1. A line still being written that is a table row, a fence opener or a bare
///    block marker (`#`, `-`, `1.`, `>`) is held back until its newline, so a
///    table does not draw a row of pipes and a list does not draw a lone dash.
/// 2. Trailing emphasis and link syntax (`*`, `_`, `` ` ``, `~`, an unclosed
///    `[text](`) is held back until it closes.
/// 3. Unclosed `**` and `` ` `` on the line being written are closed, so bold
///    and code read as bold and code from their first character instead of
///    as asterisks that later vanish.
///
/// Inside an open code fence nothing is tidied: it is code.
public enum JunoStreamTidy {
    /// The cut nearest `offset` (UTF-16) that does not split a character.
    public static func boundary(in source: String, at offset: Int) -> Int {
        let string = source as NSString
        guard offset > 0 else { return 0 }
        guard offset < string.length else { return string.length }
        let range = string.rangeOfComposedCharacterSequence(at: offset)
        return range.location
    }

    public static func tidy(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let fences = lines.dropLast().filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        let lastLine = String(lines.last ?? "")
        let head = lines.count > 1 ? lines.dropLast().joined(separator: "\n") + "\n" : ""
        let trimmed = lastLine.trimmingCharacters(in: .whitespaces)

        // Inside an open fence the line is code; only a closing fence being
        // typed is held back, so the block does not flash a stray backtick.
        if fences % 2 == 1 {
            return trimmed.hasPrefix("`") ? head : text
        }

        // 1. Lines that mean nothing until they end.
        if trimmed.hasPrefix("|") || trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
            || isBareMarker(trimmed) || trimmed.hasPrefix("$$")
        {
            return head
        }

        var line = lastLine
        // 2. Trailing syntax still opening.
        if let open = unclosedLinkStart(line) {
            line = String(line[..<open])
        }
        while let last = line.last, "*_`~".contains(last) {
            line.removeLast()
        }
        // 3. Close what is open, so it reads as what it will be.
        let ticks = line.filter { $0 == "`" }.count
        if ticks % 2 == 1 {
            line += "`"
        } else if line.components(separatedBy: "**").count % 2 == 0 {
            line += "**"
        }
        return head + line
    }

    /// `#`, `##`, `-`, `*`, `+`, `>`, `1.` — a block marker with no text yet.
    static func isBareMarker(_ trimmed: String) -> Bool {
        if trimmed.isEmpty { return false }
        if trimmed.allSatisfy({ $0 == "#" }) { return true }
        if ["-", "*", "+", ">", "- [", "- [ ]", "- [x]"].contains(trimmed) { return true }
        if trimmed.last == ".", trimmed.dropLast().allSatisfy(\.isNumber), trimmed.count <= 4 { return true }
        // A thematic break or a setext underline still being typed.
        if trimmed.count <= 3, trimmed.allSatisfy({ $0 == "-" || $0 == "=" }) { return true }
        return false
    }

    /// Where an unfinished `[text](url` or `[text` starts on the line.
    static func unclosedLinkStart(_ line: String) -> String.Index? {
        guard let open = line.lastIndex(of: "[") else { return nil }
        let rest = line[open...]
        if !rest.contains("]") { return open }
        if let paren = rest.range(of: "](") {
            return rest[paren.upperBound...].contains(")") ? nil : open
        }
        return nil
    }
}

// MARK: - Fresh words fade in

/// Draws a text run with its newest glyphs inking in: each glyph in the
/// trailing bands is drawn at its band's ink (``JunoStreamInk/opacity``), so a
/// word arrives faint and reaches full ink over ~280ms — the web's five
/// `::highlight(stream-f*)` bands, without wrapping a single word.
///
/// The renderer only changes how already-laid-out glyphs are painted: the
/// text's layout, and so the transcript's scroll geometry, is the same as the
/// settled text's on every frame.
public struct JunoStreamRevealRenderer: TextRenderer {
    public var reveal: JunoStreamReveal

    public init(reveal: JunoStreamReveal) {
        self.reveal = reveal
    }

    public init(span: Double) {
        self.init(reveal: JunoStreamReveal(span: span))
    }

    public func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let fading = reveal.span
        guard fading > 0 else {
            for line in layout { context.draw(line) }
            return
        }
        var total = 0
        for line in layout {
            for run in line { total += run.count }
        }
        var index = 0
        for line in layout {
            for run in line {
                let end = index + run.count
                if total - end >= fading {
                    // Entirely settled: one draw for the whole run.
                    context.draw(run)
                    index = end
                    continue
                }
                for slice in run {
                    let ink = reveal.ink(fromEnd: total - index)
                    if ink >= 1 {
                        context.draw(slice)
                    } else {
                        var glyph = context
                        glyph.opacity = ink
                        glyph.draw(slice)
                    }
                    index += 1
                }
            }
        }
    }
}

public extension View {
    /// Fades the newest glyphs of this text in, when the environment says it
    /// is the run being written.
    func junoStreamRevealText() -> some View {
        modifier(JunoStreamRevealTextModifier())
    }

    /// Limits the live reveal to this view only when it is the last thing
    /// being written; earlier siblings draw solid.
    func junoStreamRevealScope(isLast: Bool) -> some View {
        modifier(JunoStreamRevealScope(isLast: isLast))
    }

    /// A block that appears while its reply is being written fades and rises
    /// in (``JunoMotion/riseIn``, 6pt) instead of popping; a block in a
    /// finished reply, in the settled part of a live one, or one rebuilt by a
    /// lazy stack, is simply there.
    func junoStreamBlockReveal() -> some View {
        modifier(JunoStreamBlockReveal())
    }
}

private struct JunoStreamRevealTextModifier: ViewModifier {
    @Environment(\.junoStreamReveal) private var reveal

    func body(content: Content) -> some View {
        if let reveal, reveal.isLive {
            content.textRenderer(JunoStreamRevealRenderer(reveal: reveal))
        } else {
            content
        }
    }
}

private struct JunoStreamRevealScope: ViewModifier {
    let isLast: Bool
    @Environment(\.junoStreamReveal) private var reveal

    func body(content: Content) -> some View {
        content.environment(\.junoStreamReveal, isLast ? reveal : nil)
    }
}

private struct JunoStreamBlockReveal: ViewModifier {
    @Environment(\.junoStreamReveal) private var reveal
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen = false

    func body(content: Content) -> some View {
        // Only a block on screen while its reply is being written waits to
        // rise: a finished reply (no reveal), the settled prefix and Reduce
        // Motion draw it at once.
        let shown = risen || reveal?.isLive != true || reduceMotion
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : JunoMotion.riseDistance)
            .onAppear {
                guard !risen else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)) {
                    risen = true
                }
            }
    }
}
