import Foundation
import SwiftUI

// MARK: - The pacer

/// Releases streamed text at a steady cadence, whatever the network does.
///
/// Tokens arrive in bursts — twenty characters, nothing for 90ms, forty more —
/// and painting each burst as it lands is what made streamed answers look
/// jerky. The pacer sits between the stream and the screen: the screen shows
/// `shown` characters of the `target`, and every frame `shown` moves toward
/// the target at a velocity that is itself smoothed.
///
/// - **Adaptive.** The desired velocity is the backlog over ``lag`` (a
///   quarter second): a fast model builds a larger backlog and is released
///   faster, a slow one slower, and a burst is spread across the gap that
///   follows it instead of popping in. The velocity eases toward that desire
///   over ``smoothing``, so a burst never lurches the text.
/// - **Catches up.** A floor of ``floor`` characters a second drains a small
///   tail, and a backlog past ``maxBacklog`` (a reply loaded half-written, a
///   network stall releasing at once) jumps to within ``maxBacklog`` / 2.
/// - **Flushes at the end.** When the stream stops, the caller shows the whole
///   text at once: nothing is held back from a finished answer.
///
/// Pure value logic, so it is tested as a function of time.
public struct JunoStreamPacer: Equatable, Sendable {
    public static let lag: Double = 0.25
    public static let smoothing: Double = 0.12
    public static let floor: Double = 40
    public static let maxBacklog: Int = 900

    /// Characters released (UTF-16 units).
    public private(set) var shown: Double
    /// The current release velocity, characters per second.
    public private(set) var velocity: Double = 0

    public init(shown: Int = 0) {
        self.shown = Double(shown)
    }

    /// Advances by `dt` seconds toward `target` characters and returns the
    /// whole number of characters to show.
    @discardableResult
    public mutating func step(target: Int, dt: Double) -> Int {
        let goal = Double(target)
        if goal < shown {
            // The text was replaced (a retry, an edit): follow it down.
            shown = goal
            velocity = 0
            return target
        }
        if goal - shown > Double(Self.maxBacklog) {
            shown = goal - Double(Self.maxBacklog / 2)
        }
        let backlog = goal - shown
        guard backlog > 0, dt > 0 else {
            velocity = 0
            return Int(shown)
        }
        let desired = max(backlog / Self.lag, Self.floor)
        velocity += (desired - velocity) * min(1, dt / Self.smoothing)
        shown = min(goal, shown + max(velocity, Self.floor) * dt)
        return Int(shown)
    }

    /// How many trailing characters are still fading in: what the release
    /// velocity covers in ``JunoStreamReveal/fadeDuration``.
    public var fadeSpan: Double {
        min(max(velocity * JunoStreamReveal.fadeDuration, 10), 56)
    }
}

// MARK: - What the screen is told

/// The live writing state a paced reply hands down to its prose: how many
/// trailing characters of the run being written are still fading in.
///
/// Set by ``JunoPacedStream`` and scoped by the views beneath it to the *last*
/// thing being written — the last segment, the last block, the last list item
/// — so earlier paragraphs never fade.
public struct JunoStreamReveal: Equatable, Sendable {
    /// Fresh words fade in over this long (the web's `--dur-base`).
    public static let fadeDuration: Double = JunoMotion.Duration.base

    /// Trailing characters still fading in; 0 when everything is solid.
    public var span: Double

    public init(span: Double) {
        self.span = span
    }
}

public extension EnvironmentValues {
    /// The reply being written, or nil for text that is not streaming.
    @Entry var junoStreamReveal: JunoStreamReveal? = nil
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
/// While `live`, the text shown runs a little behind the text received (see
/// ``JunoStreamPacer``), is tidied so half-written Markdown never flashes as
/// syntax (``JunoStreamTidy``), and the environment carries a
/// ``JunoStreamReveal`` so the newest words fade in and new blocks rise. When
/// `live` ends the whole text shows at once and the last fade settles.
///
/// Under Reduce Motion the text is still paced — it is how text arrives, not a
/// decoration — but nothing fades or rises.
public struct JunoPacedStream<Content: View>: View {
    private let source: String
    private let live: Bool
    private let content: (String) -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pacer: JunoStreamPacer?
    @State private var span: Double = 0
    @State private var paced = false
    /// The source's current length, mirrored into state. The pacing loop runs
    /// in a `.task` that captured this view's value when it started, so its
    /// own `source` is the text as it was *then* — empty, for a reply that
    /// began streaming after its row was built. Reading the target through
    /// state is what lets the loop see the reply grow; reading `source`
    /// directly left every live answer blank until its `done` frame.
    @State private var liveLength = 0

    public init(_ source: String, live: Bool, @ViewBuilder content: @escaping (String) -> Content) {
        self.source = source
        self.live = live
        self.content = content
    }

    private var sourceLength: Int { (source as NSString).length }

    public var body: some View {
        content(displayed)
            // Only a stream this view is pacing says so; otherwise whatever
            // the surroundings set stands (an offscreen snapshot can pose a
            // mid-stream fade that way).
            .transformEnvironment(\.junoStreamReveal) { reveal in
                if paced { reveal = reduceMotion ? nil : JunoStreamReveal(span: span) }
            }
            .onChange(of: sourceLength, initial: true) { _, length in
                liveLength = length
            }
            .task(id: live) {
                guard live else {
                    finish()
                    return
                }
                await run()
            }
    }

    /// What the children draw.
    private var displayed: String {
        guard live, let pacer else { return source }
        let cut = JunoStreamTidy.boundary(in: source, at: Int(pacer.shown))
        return JunoStreamTidy.tidy(String((source as NSString).substring(to: cut)))
    }

    private func run() async {
        // A reply that was already part-written when its row was built (a
        // lazy stack rebuilding it, a conversation opened mid-stream) starts
        // near its end rather than replaying everything it has.
        if pacer == nil {
            pacer = JunoStreamPacer(shown: max(0, liveLength - 24))
        }
        paced = true
        var last = Date()
        while !Task.isCancelled {
            let now = Date()
            let dt = min(now.timeIntervalSince(last), 0.1)
            last = now
            var next = pacer ?? JunoStreamPacer()
            let target = liveLength
            let before = Int(next.shown)
            let after = next.step(target: target, dt: dt)
            if after != before || next.velocity != pacer?.velocity {
                pacer = next
                span = next.fadeSpan
            }
            // A frame while there is something to release; a slower poll while
            // caught up, waiting for the next burst. Long replies re-lay out
            // their Markdown on every release, so they step at half rate.
            let caughtUp = after >= target
            let interval: Duration = caughtUp ? .milliseconds(40) : (target > 6000 ? .milliseconds(33) : .milliseconds(16))
            try? await Task.sleep(for: interval)
        }
    }

    private func finish() {
        guard paced else { return }
        pacer = nil
        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)) {
            span = 0
        }
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

/// Draws a text run with its newest glyphs fading in: the last `span` glyphs
/// ramp from transparent and slightly blurred to solid, so a word arrives as
/// ink settling rather than as a block appearing.
///
/// Position stands in for time. The pacer releases text at a steady rate, so
/// a glyph `k` from the end was released `k / velocity` seconds ago, and a
/// ramp over the last `velocity × 250ms` glyphs *is* a 250ms fade — with no
/// per-glyph clocks, and nothing to store between frames. When the stream
/// ends `span` animates to zero and the tail settles.
public struct JunoStreamRevealRenderer: TextRenderer, Animatable {
    public var span: Double

    public init(span: Double) {
        self.span = span
    }

    public var animatableData: Double {
        get { span }
        set { span = newValue }
    }

    public func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        guard span >= 1 else {
            for line in layout { context.draw(line) }
            return
        }
        var total = 0
        for line in layout {
            for run in line { total += run.count }
        }
        let fading = Int(span.rounded(.up))
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
                    let fromEnd = Double(total - index)
                    let progress = min(max(fromEnd / span, 0), 1)
                    if progress >= 1 {
                        context.draw(slice)
                    } else {
                        // smoothstep, so the ramp has no visible front edge.
                        let eased = progress * progress * (3 - 2 * progress)
                        var glyph = context
                        glyph.opacity = eased
                        let blur = (1 - eased) * 2.2
                        if blur > 0.15 { glyph.addFilter(.blur(radius: blur)) }
                        glyph.translateBy(x: 0, y: (1 - eased) * 1.5)
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
    /// finished reply, or one rebuilt by a lazy stack, is simply there.
    func junoStreamBlockReveal() -> some View {
        modifier(JunoStreamBlockReveal())
    }
}

private struct JunoStreamRevealTextModifier: ViewModifier {
    @Environment(\.junoStreamReveal) private var reveal

    func body(content: Content) -> some View {
        if let reveal {
            content.textRenderer(JunoStreamRevealRenderer(span: reveal.span))
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
        // Only a block on screen while its reply is live waits to rise: a
        // finished reply (no reveal) and Reduce Motion draw it at once.
        let shown = risen || reveal == nil || reduceMotion
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
