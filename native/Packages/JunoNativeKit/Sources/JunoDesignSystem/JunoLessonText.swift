import SwiftUI

/// A reply's text run, with its inline learning blocks drawn as blocks.
///
/// This is ``JunoMarkdownText`` plus one step: before rendering, the run is split
/// on `:::learning-card`, `:::quiz`, `:::step-lab` and their siblings, and each
/// one becomes a figure instead of four lines of literal YAML. Everything
/// between them is still ordinary Markdown, rendered by the same view as before,
/// so nothing about a reply *without* a lesson changes.
///
/// It is a separate view rather than a flag on ``JunoMarkdownText`` because only
/// the chat transcript should do this. An artifact's Markdown preview, a Code
/// session's transcript and the memory screen all render model text too, and a
/// `:::quiz` appearing in a source file is source, not a lesson.
public struct JunoLessonText: View {
    /// A run of the reply: either prose or one lesson.
    enum Segment: Sendable {
        case markdown(String)
        case block(JunoLearningBlocks.Parsed)
    }

    private let segments: [Segment]
    private let streaming: Bool

    /// - Parameter streaming: whether tokens are still arriving. Carried through
    ///   to the Markdown view for its caret, and to the blocks so a trailing
    ///   unclosed one knows to stay a placeholder rather than salvage-parse
    ///   itself while its body is still being written.
    public init(_ source: String, streaming: Bool = false) {
        self.segments = Self.split(source)
        self.streaming = streaming
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoMarkdownText.blockSpacing) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                switch segment {
                case .markdown(let text):
                    // The caret rides the LAST prose run only. Handing
                    // `streaming` to every run would put a cursor above a
                    // finished lesson, which says the wrong thing about where
                    // the writing is happening.
                    JunoMarkdownText(text, streaming: streaming && index == lastMarkdownIndex)
                case .block(let parsed):
                    JunoLearningBlockView(parsed: parsed, messageStreaming: streaming)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var lastMarkdownIndex: Int? {
        segments.lastIndex { if case .markdown = $0 { return true } else { return false } }
    }

    /// Splits a run into prose and lessons, in source order.
    ///
    /// `nonisolated` because it is pure string processing and has no business
    /// needing the main actor. Conforming to `View` infers main-actor isolation
    /// onto every member, including the static ones — which made this callable
    /// only from the main actor, and made `NativeMessageContent.spoken` and the
    /// tests reach across an isolation boundary for a function that touches
    /// nothing but its argument. The compiler this was written against only
    /// warned; CI's does not.
    ///
    /// Whitespace-only prose between two blocks is dropped rather than emitted:
    /// a blank Markdown view still occupies a stack slot, and two adjacent
    /// lessons would have been pushed apart by a gap that came from nothing.
    nonisolated static func split(_ source: String) -> [Segment] {
        let blocks = JunoLearningBlocks.blocks(in: source)
        guard !blocks.isEmpty else {
            return source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? []
                : [.markdown(source)]
        }

        var segments: [Segment] = []
        var cursor = 0
        for block in blocks {
            append(JunoLineScanner.substring(of: source, fromUTF16: cursor, toUTF16: block.start), to: &segments)
            segments.append(.block(block))
            cursor = block.end
        }
        append(
            JunoLineScanner.substring(of: source, fromUTF16: cursor, toUTF16: (source as NSString).length),
            to: &segments
        )
        return segments
    }

    nonisolated private static func append(_ run: String, to segments: inout [Segment]) {
        guard !run.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        segments.append(.markdown(run))
    }
}
