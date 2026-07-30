import Foundation

/// Inline visual learning blocks — the Swift half of the `:::kind … :::` layer.
///
/// The model embeds compact lessons directly in a chat reply:
///
///     :::learning-card        one key idea, toned (insight/tip/warning/note)
///     :::step-lab             guided multi-step walkthrough
///     :::process-timeline     ordered stages of a process
///     :::comparison           side-by-side option/row comparison
///     :::quiz                 one-question local check (nothing is sent)
///     :::deep-dive            collapsed expandable detail section
///
/// Native rendered every one of these as literal `:::quiz` prose with the YAML
/// body underneath it, on the phone and on the Mac. This is the port of
/// `src/lib/learning-blocks.ts` and the parser half of `src/lib/step-lab.ts`,
/// kept deliberately line-for-line with them: the two clients disagreeing about
/// what a lesson *is* would be worse than neither rendering it, because the
/// reader would be taught two different things by the same reply.
///
/// **No parse cache.** The web memoises because React re-renders a message on
/// every keystroke elsewhere in the page. SwiftUI does not, and a global mutable
/// cache under Swift 6 concurrency would have to be actor-isolated — which the
/// view layer cannot await from `init`. ``JunoMarkdown`` already parses in `init`
/// for the same reason; this follows it rather than inventing a second policy.
public enum JunoLearningBlocks {

    // MARK: - Kinds

    public enum Kind: String, CaseIterable, Sendable, Hashable {
        case stepLab = "step-lab"
        case learningCard = "learning-card"
        case processTimeline = "process-timeline"
        case comparison
        case quiz
        case deepDive = "deep-dive"

        /// `LEARNING_BLOCK_LABELS` — the name shown while a block streams in and
        /// in the fallback sentence when one cannot be rendered.
        public var label: String {
            switch self {
            case .stepLab: "Step Lab"
            case .learningCard: "Key idea"
            case .processTimeline: "Process"
            case .comparison: "Comparison"
            case .quiz: "Quick check"
            case .deepDive: "Deep dive"
            }
        }
    }

    // MARK: - Payloads

    public enum CardTone: String, Sendable, Hashable {
        case insight, tip, warning, note
    }

    public struct Card: Equatable, Sendable {
        public let title: String
        /// A short emoji, rendered as plain text. Never an icon lookup: the
        /// model writes a character, and substituting a symbol for it would be
        /// this client answering a different question than the web did.
        public let icon: String?
        public let tone: CardTone
        public let content: String
    }

    public struct TimelineStep: Equatable, Sendable, Identifiable {
        public let id: Int
        public let label: String
        public let description: String?
    }

    public struct Timeline: Equatable, Sendable {
        public let title: String?
        public let steps: [TimelineStep]
    }

    public struct ComparisonRow: Equatable, Sendable, Identifiable {
        public let id: Int
        public let label: String
        public let values: [String]
    }

    public struct Comparison: Equatable, Sendable {
        public let title: String?
        public let columns: [String]
        public let rows: [ComparisonRow]
        public let verdict: String?
    }

    public struct QuizOption: Equatable, Sendable, Identifiable {
        public let id: Int
        public let label: String
        public let correct: Bool
        public let explanation: String?
    }

    public struct QuizQuestion: Equatable, Sendable, Identifiable {
        public let id: Int
        public let question: String
        public let options: [QuizOption]
        public let explanation: String?
        /// Revealed on demand, before answering.
        public let hint: String?
    }

    public struct Quiz: Equatable, Sendable {
        /// Only meaningful in multi-question mode; see ``parseQuiz``.
        public let title: String?
        public let questions: [QuizQuestion]
    }

    public struct DeepDive: Equatable, Sendable {
        public let title: String
        public let summary: String
        public let content: String
    }

    public enum Payload: Equatable, Sendable {
        case stepLab(JunoStepLab)
        case learningCard(Card)
        case processTimeline(Timeline)
        case comparison(Comparison)
        case quiz(Quiz)
        case deepDive(DeepDive)

        public var kind: Kind {
            switch self {
            case .stepLab: .stepLab
            case .learningCard: .learningCard
            case .processTimeline: .processTimeline
            case .comparison: .comparison
            case .quiz: .quiz
            case .deepDive: .deepDive
            }
        }
    }

    /// One block found in a reply, with the source range it occupied.
    public struct Parsed: Equatable, Sendable, Identifiable {
        public let blockId: String
        public let kind: Kind
        /// nil while streaming (unclosed) or when the block is beyond salvage.
        public let payload: Payload?
        /// What was wrong, when the block was malformed but salvaged.
        public let error: String?
        /// The closing `:::` has not arrived — show a placeholder, do not parse.
        public let streaming: Bool
        /// UTF-16 offsets, matching the web's string indices, so a blockId
        /// computed here equals the one the website computed for the same reply.
        public let start: Int
        public let end: Int
        public let raw: String

        public var id: String { blockId }
    }

    // MARK: - Scanning

    /// Every learning block in `text`, in source order. Fenced code is skipped.
    ///
    /// A trailing block whose `:::` close has not arrived is returned with
    /// ``Parsed/streaming`` set and is NOT parsed — its body is still being
    /// generated, and parsing half-written YAML produces a confidently wrong
    /// lesson rather than an obviously incomplete one.
    public static func blocks(in text: String) -> [Parsed] {
        var found: [Parsed] = []
        var inCodeFence = false
        var fenceMarker = ""
        var pending: (kind: Kind, start: Int, innerStart: Int)?

        for line in JunoLineScanner.lines(of: text) {
            let trimmed = line.text.trimmingCharacters(in: .whitespacesAndNewlines)

            if pending == nil, trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let marker = String(trimmed.prefix(3))
                if !inCodeFence {
                    inCodeFence = true
                    fenceMarker = marker
                } else if marker == fenceMarker {
                    inCodeFence = false
                    fenceMarker = ""
                }
            }

            if inCodeFence { continue }

            if pending == nil, trimmed.hasPrefix(openPrefix) {
                // `:::quiz{...}` and `:::quiz extra` both name the kind; the
                // token ends at the first space or brace.
                let token = trimmed.dropFirst(openPrefix.count)
                    .prefix(while: { $0 != " " && $0 != "{" && !$0.isWhitespace })
                    .lowercased()
                if let kind = Kind(rawValue: token) {
                    pending = (kind, line.start, line.end)
                    continue
                }
            }

            if let open = pending, trimmed == close {
                let end = line.end
                let inner = JunoLineScanner.substring(of: text, fromUTF16: open.innerStart, toUTF16: line.start)
                let seed = "\(open.start):\(end)"
                let parsed = parse(kind: open.kind, source: inner, seed: seed)
                found.append(
                    Parsed(
                        blockId: stableId("\(seed):\(open.kind.rawValue):\(inner)", prefix: "learn"),
                        kind: open.kind,
                        payload: parsed.payload,
                        error: parsed.error,
                        streaming: false,
                        start: open.start,
                        end: end,
                        raw: JunoLineScanner.substring(of: text, fromUTF16: open.start, toUTF16: end)
                    )
                )
                pending = nil
            }
        }

        if let open = pending {
            let end = (text as NSString).length
            found.append(
                Parsed(
                    blockId: stableId("\(open.start):streaming:\(open.kind.rawValue)", prefix: "learn"),
                    kind: open.kind,
                    payload: nil,
                    error: nil,
                    streaming: true,
                    start: open.start,
                    end: end,
                    raw: JunoLineScanner.substring(of: text, fromUTF16: open.start, toUTF16: end)
                )
            )
        }

        return found
    }

    /// `text` with every learning block cut out, leaving the prose around them.
    ///
    /// For consumers that need words rather than figures — speech being the one
    /// that matters. Read aloud, a `:::quiz` is twenty seconds of "options open
    /// bracket", which is why the web has a matcher for exactly this.
    public static func stripping(from text: String) -> String {
        let found = blocks(in: text)
        guard !found.isEmpty else { return text }
        var runs: [String] = []
        var cursor = 0
        for block in found {
            runs.append(JunoLineScanner.substring(of: text, fromUTF16: cursor, toUTF16: block.start))
            cursor = block.end
        }
        runs.append(
            JunoLineScanner.substring(of: text, fromUTF16: cursor, toUTF16: (text as NSString).length)
        )
        return runs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    /// Parses a block that never received its closing `:::` — the reply finished
    /// or was truncated mid-block.
    ///
    /// Called once the message stops streaming, so a cut-off lesson renders
    /// instead of a placeholder that waits forever for a delimiter that is not
    /// coming.
    public static func salvage(_ block: Parsed) -> Parsed {
        guard block.streaming else { return block }
        let newline = block.raw.firstIndex(of: "\n")
        let inner = newline.map { String(block.raw[block.raw.index(after: $0)...]) } ?? ""
        let parsed = parse(kind: block.kind, source: inner, seed: "salvage:\(block.start)")
        return Parsed(
            blockId: block.blockId,
            kind: block.kind,
            payload: parsed.payload,
            error: parsed.error ?? "This block was cut off mid-stream.",
            streaming: false,
            start: block.start,
            end: block.end,
            raw: block.raw
        )
    }

    // MARK: - Per-kind parsing

    /// Parses one closed block body. Never throws: a malformed block degrades to
    /// a labelled fallback, because a lesson that fails loudly in the middle of
    /// an answer is worse than one that says it could not be drawn.
    public static func parse(
        kind: Kind,
        source: String,
        seed: String = ""
    ) -> (payload: Payload?, error: String?) {
        if kind == .stepLab {
            let parsed = JunoStepLab.parse(source, seed: seed)
            return (.stepLab(parsed.lab), parsed.error)
        }

        let raw = JunoYAMLSubset.parse(source)
        guard case .mapping(let map) = raw else {
            return (nil, "Block body must be key: value data.")
        }

        switch kind {
        case .learningCard: return parseCard(map)
        case .processTimeline: return parseTimeline(map)
        case .comparison: return parseComparison(map)
        case .quiz: return parseQuiz(map)
        case .deepDive: return parseDeepDive(map)
        case .stepLab: return (nil, nil) // handled above
        }
    }

    private static func parseCard(_ raw: JunoYAML.Map) -> (Payload?, String?) {
        let content = JunoYAML.cleanText(raw.pick("content", "body", "text"), max: 2_000)
        guard !content.isEmpty else { return (nil, "Learning card needs `content`.") }
        // Only the three named alternatives are honoured; anything else — an
        // unknown word, or `insight` itself — lands on insight.
        let toneRaw = JunoYAML.cleanString(raw.pick("tone")).lowercased()
        let tone: CardTone = switch toneRaw {
        case "tip": .tip
        case "warning": .warning
        case "note": .note
        default: .insight
        }
        let icon = String(JunoYAML.cleanString(raw.pick("icon")).prefix(8))
        return (
            .learningCard(
                Card(
                    title: JunoYAML.cleanString(raw.pick("title"), fallback: "Core idea"),
                    icon: icon.isEmpty ? nil : icon,
                    tone: tone,
                    content: content
                )
            ),
            nil
        )
    }

    private static func parseTimeline(_ raw: JunoYAML.Map) -> (Payload?, String?) {
        let steps = JunoYAML.recordArray(raw.pick("steps", "items"))
            .compactMap { step -> (label: String, description: String?)? in
                let label = JunoYAML.cleanString(step.pick("label", "title", "name"))
                guard !label.isEmpty else { return nil }
                let detail = JunoYAML.cleanText(
                    step.pick("description", "body", "detail"), max: 500
                )
                return (label, detail.isEmpty ? nil : detail)
            }
            .prefix(maxTimelineSteps)
            .enumerated()
            .map { TimelineStep(id: $0.offset, label: $0.element.label, description: $0.element.description) }

        guard steps.count >= 2 else {
            return (nil, "Process timeline needs at least two steps with labels.")
        }
        let title = JunoYAML.cleanString(raw.pick("title"))
        return (.processTimeline(Timeline(title: title.isEmpty ? nil : title, steps: steps)), nil)
    }

    private static func parseComparison(_ raw: JunoYAML.Map) -> (Payload?, String?) {
        let columns = JunoYAML.array(raw.pick("columns"))
            .map { JunoYAML.cleanString($0) }
            .filter { !$0.isEmpty }
            .prefix(maxComparisonColumns)
            .map { $0 }

        let rows = JunoYAML.recordArray(raw.pick("rows", "items"))
            .compactMap { row -> (label: String, values: [String])? in
                let label = JunoYAML.cleanString(row.pick("label", "title", "name", "focus"))
                let values = JunoYAML.array(row.pick("values", "cells"))
                    .map { JunoYAML.cleanText($0, max: 400) }
                    .prefix(max(columns.count, 1))
                    .map { $0 }
                guard !label.isEmpty, !values.isEmpty else { return nil }
                return (label, values)
            }
            .prefix(maxComparisonRows)
            .enumerated()
            .map { ComparisonRow(id: $0.offset, label: $0.element.label, values: $0.element.values) }

        guard columns.count >= 2, !rows.isEmpty else {
            return (nil, "Comparison needs 2+ columns and at least one row with values.")
        }
        let title = JunoYAML.cleanString(raw.pick("title"))
        let verdict = JunoYAML.cleanText(raw.pick("verdict", "takeaway"), max: 400)
        return (
            .comparison(
                Comparison(
                    title: title.isEmpty ? nil : title,
                    columns: columns,
                    rows: rows,
                    verdict: verdict.isEmpty ? nil : verdict
                )
            ),
            nil
        )
    }

    /// One question. Correctness may come from `correct: true` on an option OR
    /// from a top-level `answer:` naming the right label, and options may be
    /// plain strings — the model writes all three shapes.
    ///
    /// Returns nil unless it has a question, 2+ options, and a correct answer.
    /// A quiz with no right answer is not a hard quiz; it is a broken one, and
    /// showing it would let the reader fail a question that cannot be passed.
    private static func parseQuizQuestion(_ raw: JunoYAML.Map, index: Int) -> QuizQuestion? {
        let question = JunoYAML.cleanText(raw.pick("question", "title", "q"), max: 500)
        let answerText = JunoYAML.cleanString(raw.pick("answer")).lowercased()
        let options = JunoYAML.array(raw.pick("options"))
            .compactMap { option -> (String, Bool, String?)? in
                switch option {
                case .string, .number:
                    let label = JunoYAML.cleanString(option)
                    guard !label.isEmpty else { return nil }
                    return (label, !answerText.isEmpty && label.lowercased() == answerText, nil)
                case .mapping(let map):
                    let label = JunoYAML.cleanString(map.pick("label", "text", "title"))
                    guard !label.isEmpty else { return nil }
                    let correct = map.pick("correct") == .bool(true)
                        || (!answerText.isEmpty && label.lowercased() == answerText)
                    let why = JunoYAML.cleanText(map.pick("explanation", "why"), max: 500)
                    return (label, correct, why.isEmpty ? nil : why)
                default:
                    return nil
                }
            }
            .prefix(maxQuizOptions)
            .enumerated()
            .map { QuizOption(id: $0.offset, label: $0.element.0, correct: $0.element.1, explanation: $0.element.2) }

        guard !question.isEmpty, options.count >= 2, options.contains(where: \.correct) else {
            return nil
        }
        let explanation = JunoYAML.cleanText(raw.pick("explanation"), max: 800)
        let hint = JunoYAML.cleanText(raw.pick("hint"), max: 400)
        return QuizQuestion(
            id: index,
            question: question,
            options: options,
            explanation: explanation.isEmpty ? nil : explanation,
            hint: hint.isEmpty ? nil : hint
        )
    }

    private static func parseQuiz(_ raw: JunoYAML.Map) -> (Payload?, String?) {
        // Multi-question (`questions:` list) OR the legacy single-question shape
        // (question/options at the top level). Both normalise to a list.
        let list = JunoYAML.arrayOrNil(raw.pick("questions"))
        let source = list.map { $0.compactMap { value -> JunoYAML.Map? in
            if case .mapping(let map) = value { return map }
            return nil
        } } ?? [raw]
        let questions = source.enumerated()
            .compactMap { parseQuizQuestion($0.element, index: $0.offset) }
            .prefix(maxQuizQuestions)
            .map { $0 }

        guard !questions.isEmpty else {
            return (nil, "Quiz needs a question with 2+ options and a correct answer.")
        }
        // A quiz-level title only makes sense in multi-question mode; in the
        // legacy single shape `title` was an alias for the question itself, and
        // repeating it above the question would read as two questions.
        let title = list == nil ? "" : JunoYAML.cleanString(raw.pick("title"))
        return (.quiz(Quiz(title: title.isEmpty ? nil : title, questions: questions)), nil)
    }

    private static func parseDeepDive(_ raw: JunoYAML.Map) -> (Payload?, String?) {
        let title = JunoYAML.cleanString(raw.pick("title"))
        let content = JunoYAML.cleanText(raw.pick("content", "body", "detail"), max: 4_000)
        guard !title.isEmpty, !content.isEmpty else {
            return (nil, "Deep dive needs `title` and `content`.")
        }
        let summary = JunoYAML.cleanText(raw.pick("summary"), max: 500)
        return (
            .deepDive(DeepDive(title: title, summary: summary.isEmpty ? title : summary, content: content)),
            nil
        )
    }

    // MARK: - Constants

    private static let openPrefix = ":::"
    private static let close = ":::"
    private static let maxTimelineSteps = 10
    private static let maxComparisonRows = 8
    private static let maxComparisonColumns = 4
    private static let maxQuizOptions = 6
    private static let maxQuizQuestions = 8
}

// MARK: - Stable ids

/// djb2 over UTF-16 code units, wrapped to 32 bits, base-36 — JavaScript's
/// `((h << 5) + h + c) >>> 0` then `toString(36)`.
///
/// Shared with ``NativeMessageContent``'s artifact ids for the same reason: an
/// id computed here has to equal the one the website computed for the same
/// reply, or the same lesson would carry two identities across the two clients.
func stableId(_ source: String, prefix: String = "step-lab") -> String {
    var hash: UInt32 = 5381
    for unit in source.utf16 {
        hash = (hash << 5) &+ hash &+ UInt32(unit)
    }
    return prefix + "-" + String(hash, radix: 36)
}

// MARK: - Line scanning

/// Splits text into lines that keep their terminator, with UTF-16 offsets.
///
/// The offsets exist so ``JunoLearningBlocks/Parsed/blockId`` can be seeded with
/// the same `start:end` pair the web seeds with — its indices are UTF-16, and a
/// Swift `Character` count would silently disagree the first time a lesson
/// contained an emoji.
enum JunoLineScanner {
    struct Line {
        /// UTF-16 offset of the line's first unit.
        let start: Int
        /// UTF-16 offset one past the line's terminator.
        let end: Int
        /// The line INCLUDING its terminator, as the web's `.*(?:\r?\n|$)` gives.
        let text: String
    }

    static func lines(of text: String) -> [Line] {
        let ns = text as NSString
        var lines: [Line] = []
        var start = 0
        while start < ns.length {
            let range = ns.range(of: "\n", range: NSRange(location: start, length: ns.length - start))
            let end = range.location == NSNotFound ? ns.length : range.location + range.length
            lines.append(Line(start: start, end: end, text: ns.substring(with: NSRange(location: start, length: end - start))))
            start = end
        }
        return lines
    }

    static func substring(of text: String, fromUTF16 start: Int, toUTF16 end: Int) -> String {
        let ns = text as NSString
        let lower = max(0, min(start, ns.length))
        let upper = max(lower, min(end, ns.length))
        return ns.substring(with: NSRange(location: lower, length: upper - lower))
    }
}
