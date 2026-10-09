import SwiftUI

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Which reading an assistant's Markdown gets.
///
/// `.standard` is what every surface has always drawn: the inherited font on a
/// 7pt leading, AIcss's code block, the streaming caret. `.reading` is the web's
/// `.prose-juno` as it is set **today** (`src/app/globals.css`): the `reading`
/// rung, 16pt on 1.7, a 0.85em block rhythm, a 75ch paragraph measure, headings
/// demoted one level, the opaque code card and the bordered table, inline code
/// on the muted ground, links in the accent's ink, and no caret.
///
/// The Mac transcript opts in with `.environment(\.junoProseStyle, .reading)`.
/// Nothing else does, so the phone, Juno Code's studio and the library keep the
/// reading they were designed against until each is moved on purpose.
public enum JunoProseStyle: Sendable, Equatable {
    case standard
    case reading
}

/// `.prose-juno`'s numbers, in points at the default text size.
public enum JunoProseMetrics {
    /// `font-size: 1rem`: the `reading` rung, read from the projection so a
    /// retune of the rung on the web reaches the transcript.
    public static let bodySize: CGFloat = JunoGeneratedType.reading.minSize
    /// `line-height: 1.7`: the `reading` rung's.
    public static let lineHeight: CGFloat = JunoGeneratedType.reading.lineHeight
    /// `> * + * { margin-top: 0.85em }`: 13.6pt.
    public static let blockGap: CGFloat = 0.85 * bodySize
    /// `h3, h4, h5 { line-height: 1.3; margin-top: 1.3em }`.
    public static let headingLineHeight: CGFloat = 1.3
    public static let headingLead: CGFloat = 1.3
    /// `ul, ol { padding-left: 1.4em }`.
    public static let listIndent: CGFloat = 1.4 * bodySize
    /// `li { margin: 0.2em 0 }` — adjacent vertical margins collapse, so one
    /// 0.2em between items.
    public static let listItemGap: CGFloat = 0.2 * bodySize
    /// `blockquote { border-left: 3px; padding-left: 1em }`.
    public static let quoteBar: CGFloat = 3
    public static let quoteInset: CGFloat = bodySize
    /// `code { font-size: 0.875em }`.
    public static let inlineCodeScale: CGFloat = 0.875
    /// The citation chip's `text-[0.72em]`.
    public static let citationScale: CGFloat = 0.72
    /// `max-inline-size: 75ch`.
    public static let measureCharacters: CGFloat = 75
    /// The `stream-tail` mask applies past this many characters…
    public static let tailFadeCharacters = 140
    /// …over the last 1.35em, down to 30%.
    public static let tailFadeHeight: CGFloat = 1.35 * bodySize
    public static let tailFadeFloor: Double = 0.3

    /// The model's `#` / `##` / `###` as the web draws them after demoting
    /// them two levels (`markdown-headings.ts`): h3 1.5em, h4 1.3em, h5 1.12em,
    /// and anything deeper at the body size.
    public static func headingSize(level: Int) -> CGFloat {
        switch level {
        case ...1: 1.5 * bodySize
        case 2: 1.3 * bodySize
        case 3: 1.12 * bodySize
        default: bodySize
        }
    }

    /// The heading's rung: semibold on 1.3.
    public static func headingType(level: Int) -> JunoType {
        JunoType(
            size: headingSize(level: level),
            weight: .semibold,
            lineHeight: headingLineHeight,
            textStyle: level <= 1 ? .title2 : (level == 2 ? .title3 : .headline)
        )
    }

    /// The space a heading adds above itself beyond the block rhythm: 1.3em of
    /// its own size, less the 0.85em every block already has.
    public static func headingExtraLead(level: Int) -> CGFloat {
        max(0, headingLead * headingSize(level: level) - blockGap)
    }

    /// `75ch` at `scale`: seventy-five advances of "0" in the body face.
    ///
    /// Measured rather than guessed because `ch` is defined by that glyph,
    /// and SF's tabular zero is what the web's Inter stand-in resolves to here.
    @MainActor
    public static func measure(scale: CGFloat) -> CGFloat {
        if let cached = measureCache[scale] { return cached }
        let size = bodySize * scale
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        let font = NSFont.systemFont(ofSize: size)
        let advance = ("0" as NSString).size(withAttributes: [.font: font]).width
        #elseif canImport(UIKit)
        let font = UIFont.systemFont(ofSize: size)
        let advance = ("0" as NSString).size(withAttributes: [.font: font]).width
        #else
        let advance = size * 0.6
        #endif
        let measured = (advance * measureCharacters).rounded()
        measureCache[scale] = measured
        return measured
    }

    @MainActor private static var measureCache: [CGFloat: CGFloat] = [:]
}

public extension EnvironmentValues {
    /// Which reading Markdown below this point gets. See ``JunoProseStyle``.
    @Entry var junoProseStyle: JunoProseStyle = .standard

    /// ⌘F's highlight, for the message this environment reaches: every match
    /// of the query on a faint foreground run, the current one on a stronger
    /// one. Nil draws nothing. Only the reading style reads it.
    @Entry var junoFindHighlight: JunoFindHighlight? = nil

    /// How many of the answer's sources were handed to the model as a numbered
    /// corpus — the web's `sources.some(s => s.cited) ? sources.length : 0`.
    /// Only then does a `[n]` in the prose mean "source n", and only then is it
    /// drawn as a citation. Zero leaves brackets as the text they are.
    @Entry var junoCitationCount: Int = 0

    /// What a clicked citation shows, by its 1-based number. Nil leaves a
    /// citation's link to the system (which ignores the `juno-cite:` scheme).
    @Entry var junoCitationPopover: JunoCitationPopover? = nil
}

/// The popover a citation opens: the host supplies the source's face, the
/// prose supplies the anchor.
public struct JunoCitationPopover {
    public let content: (Int) -> AnyView

    public init(content: @escaping (Int) -> AnyView) {
        self.content = content
    }
}

// MARK: - Find

/// One message's share of a find: the query, which of its matches is the
/// current one, and — as the environment reaches deeper runs — how many matches
/// came before this run in the message.
public struct JunoFindHighlight: Equatable, Sendable {
    public var query: String
    /// The current match's ordinal within the message, or nil when the current
    /// match is in another message.
    public var current: Int?
    /// The ordinal of this run's first match within its message.
    public var base: Int

    public init(query: String, current: Int?, base: Int = 0) {
        self.query = query
        self.current = current
        self.base = base
    }

    /// The same highlight for a run whose first match is `count` further on.
    public func shifted(by count: Int) -> JunoFindHighlight {
        var next = self
        next.base += count
        return next
    }

    public var isActive: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A match's ground: the foreground at 10%.
    public static let matchOpacity: Double = 0.10
    /// The current match's ground: the foreground at 22%.
    public static let currentOpacity: Double = 0.22
}

/// Finding text the way the transcript draws it.
///
/// **One traversal, used twice.** The find bar's "3 of 12" and the runs the
/// prose highlights have to agree on what counts as a match and in which order,
/// or the current match would be drawn on the wrong words. Both go through the
/// same functions here, over the same rendered strings — the prose's *drawn*
/// characters (inline Markdown resolved, citations as chips), not its source.
public enum JunoFindText {
    /// Every match of `query` in `text`, in order, without overlaps. Case and
    /// diacritics are ignored, as Safari's find does.
    public static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty, !text.isEmpty else { return [] }
        var found: [Range<String.Index>] = []
        var cursor = text.startIndex
        while cursor < text.endIndex,
            let range = text.range(
                of: needle,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: cursor..<text.endIndex
            )
        {
            found.append(range)
            cursor = range.upperBound
        }
        return found
    }

    public static func count(of query: String, in text: String) -> Int {
        ranges(of: query, in: text).count
    }

    /// Matches in one Markdown run as the reading style draws it.
    public static func count(of query: String, inMarkdown source: String, citations: Int = 0) -> Int {
        JunoMarkdown.blocks(from: source).reduce(0) { total, block in
            total + count(of: query, inBlock: block, citations: citations)
        }
    }

    /// Matches in a reply's text as ``JunoLessonText`` draws it: its prose runs,
    /// not the insides of its lessons.
    public static func count(of query: String, inLesson source: String, citations: Int = 0) -> Int {
        JunoLessonText.split(source).reduce(0) { total, segment in
            switch segment {
            case .markdown(let text): total + count(of: query, inMarkdown: text, citations: citations)
            case .live: total
            }
        }
    }

    /// Matches in one block, in the order its views draw them.
    static func count(of query: String, inBlock block: JunoMarkdownBlock, citations: Int) -> Int {
        blockTexts(block, citations: citations).reduce(0) { $0 + count(of: query, in: $1) }
    }

    /// The drawn strings of one block, in drawing order.
    static func blockTexts(_ block: JunoMarkdownBlock, citations: Int) -> [String] {
        switch block {
        case .paragraph(let text), .heading(_, let text), .quote(let text):
            [inlineText(text, citations: citations)]
        case .list(_, _, let items):
            items.map { inlineText($0.text, citations: citations) }
        case .table(let header, let rows):
            (header + rows.flatMap { $0 }).map { inlineText($0, citations: citations) }
        case .code(let language, let source, let isClosed):
            // Diagrams, charts and visuals are drawn, not printed: there are
            // no characters of theirs on screen to find. The same gates as the
            // block view — a still-open diagram, or a chart that does not
            // parse, is on screen as its source.
            if JunoVisualMarkup.isVisualFence(info: language)
                || (isClosed && JunoMermaidMarkup.isMermaidFence(info: language))
                || (isClosed && JunoChartMarkup.data(fenceInfo: language, source: source) != nil)
            {
                []
            } else {
                [source]
            }
        case .math, .thematicBreak:
            []
        }
    }

    static func inlineText(_ source: String, citations: Int) -> String {
        String(JunoProseInline.styled(source, baseSize: JunoProseMetrics.bodySize, scale: 1, citations: citations).characters)
    }

    /// `attributed`, with every match of the highlight's query on a
    /// foreground-10% run and the current one on 22%. Neutral, never the accent:
    /// a find highlight is a place, not an action.
    public static func highlighted(
        _ attributed: AttributedString,
        with highlight: JunoFindHighlight?
    ) -> AttributedString {
        guard let highlight, highlight.isActive else { return attributed }
        let plain = String(attributed.characters)
        let matches = ranges(of: highlight.query, in: plain)
        guard !matches.isEmpty else { return attributed }
        var result = attributed
        // Walked forward from the previous match rather than from the start
        // each time: an attributed string's offsets are linear to reach.
        var plainCursor = plain.startIndex
        var attributedCursor = result.startIndex
        for (index, match) in matches.enumerated() {
            let gap = plain.distance(from: plainCursor, to: match.lowerBound)
            let length = plain.distance(from: match.lowerBound, to: match.upperBound)
            let start = result.characters.index(attributedCursor, offsetBy: gap)
            let end = result.characters.index(start, offsetBy: length)
            let isCurrent = highlight.current == highlight.base + index
            result[start..<end].backgroundColor = Color.junoForeground.opacity(
                isCurrent ? JunoFindHighlight.currentOpacity : JunoFindHighlight.matchOpacity
            )
            plainCursor = match.upperBound
            attributedCursor = end
        }
        return result
    }

    /// Plain text — a reader's bubble — highlighted.
    public static func highlighted(_ plain: String, with highlight: JunoFindHighlight?) -> AttributedString {
        highlighted(AttributedString(plain), with: highlight)
    }
}

// MARK: - Inline runs

/// The reading style's inline dressing, applied after the shared inline
/// Markdown and maths pass (``AttributedString/junoInline(_:)``).
enum JunoProseInline {
    /// U+202F: a narrow space that never breaks, standing in for inline code's
    /// `0.4em` side padding inside the run's own muted ground.
    static let codePad = "\u{202F}"
    /// U+2009 around a citation's number, for the chip's `px-[0.4em]`.
    static let citationPad = "\u{2009}"
    static let citationScheme = "juno-cite"

    /// `[n]` → a `juno-cite://n` link, for n in 1…`citations`. A bracket
    /// followed by `(` is a Markdown link's text, not a citation.
    static func rewritingCitations(_ source: String, citations: Int) -> String {
        guard citations > 0, source.contains("[") else { return source }
        let pattern = #"\[(\d{1,3})\](?!\()"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return source }
        let text = source as NSString
        var result = ""
        var cursor = 0
        for match in expression.matches(in: source, range: NSRange(location: 0, length: text.length)) {
            let number = Int(text.substring(with: match.range(at: 1))) ?? 0
            guard (1...citations).contains(number) else { continue }
            result += text.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += "[\(number)](\(citationScheme)://\(number))"
            cursor = match.range.location + match.range.length
        }
        guard cursor > 0 else { return source }
        result += text.substring(from: cursor)
        return result
    }

    /// The citation a `juno-cite://n` link names.
    static func citationNumber(_ url: URL) -> Int? {
        guard url.scheme == citationScheme else { return nil }
        return Int(url.host() ?? "")
    }

    /// Inline Markdown as the reading style draws it at `baseSize`.
    static func styled(
        _ source: String,
        baseSize: CGFloat,
        scale: CGFloat,
        citations: Int
    ) -> AttributedString {
        let parsed = AttributedString.junoInline(rewritingCitations(source, citations: citations))
        var result = AttributedString()
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            if let url = run.link, citationNumber(url) != nil {
                // The chip: the number in mono at 0.72em on the secondary
                // ground, in secondary ink — a citation is neither a body link
                // nor selected, so never the accent.
                var chip = AttributedString(citationPad + String(piece.characters) + citationPad)
                chip.link = url
                chip.font = JunoType.systemFont(
                    size: baseSize * JunoProseMetrics.citationScale * scale,
                    relativeTo: .caption,
                    weight: .medium,
                    design: .monospaced
                )
                chip.foregroundColor = Color.junoSecondaryInk
                chip.backgroundColor = Color.junoSecondary
                chip.baselineOffset = 1
                piece = chip
            } else if run.link != nil {
                // `.prose-juno a`: the accent's ink, underlined.
                piece.foregroundColor = Color.junoAccentInk
                piece.underlineStyle = .single
            } else if run.inlinePresentationIntent?.contains(.code) == true {
                var code = AttributedString(codePad + String(piece.characters) + codePad)
                code.inlinePresentationIntent = run.inlinePresentationIntent
                code.font = JunoType.systemFont(
                    size: baseSize * JunoProseMetrics.inlineCodeScale * scale,
                    relativeTo: .body,
                    weight: .regular,
                    design: .monospaced
                )
                code.backgroundColor = Color.junoMuted
                piece = code
            }
            result += piece
        }
        return result
    }
}

// MARK: - The streaming tail

public extension View {
    /// The web's `.stream-tail`: while a reply is being written, the last
    /// 1.35em of its prose fades to 30%, which is where the writing is — in
    /// place of a caret. Off under Reduce Motion, as the web's is, and until
    /// the reply is long enough to have a line of its own to fade.
    func junoStreamingTail(_ active: Bool) -> some View {
        modifier(JunoStreamingTail(active: active))
    }
}

private struct JunoStreamingTail: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoTextScale) private var textScale

    func body(content: Content) -> some View {
        if active, !reduceMotion {
            content.mask {
                VStack(spacing: 0) {
                    Color.black
                    LinearGradient(
                        colors: [.black, .black.opacity(JunoProseMetrics.tailFadeFloor)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: JunoProseMetrics.tailFadeHeight * textScale)
                }
            }
        } else {
            content
        }
    }
}
