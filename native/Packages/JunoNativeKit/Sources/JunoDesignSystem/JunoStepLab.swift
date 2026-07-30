import Foundation

/// A Step Lab — the guided, multi-step walkthrough the model writes as
/// `:::step-lab`. The Swift counterpart of the schema half of
/// `src/lib/step-lab.ts`.
///
/// A Step Lab is the one learning block with real internal structure: an ordered
/// set of steps, each with a title, a summary, optional detail, an optional
/// "notice" line telling the reader what to look at, a visual type, and a free
/// `data` payload the visual reads. A malformed one degrades to a single-step
/// fallback lab that says so, rather than vanishing — a lesson the model wrote
/// and the reader cannot see is worse than one that admits it broke.
public struct JunoStepLab: Equatable, Sendable {

    /// What a step is illustrating. The set is closed because each value names a
    /// visual that exists; an unknown one is inferred from the step's own words
    /// rather than being invented.
    public enum VisualType: String, Sendable, Hashable, CaseIterable {
        case tokenization
        case embedding
        case attention
        case transformerProcessing = "transformer-processing"
        case probabilityDistribution = "probability-distribution"
        case nextTokenSelection = "next-token-selection"
        case genericProcess = "generic-process"
    }

    public enum Density: String, Sendable, Hashable {
        case compact
        case comfortable
    }

    public struct Step: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let summary: String
        public let detail: String?
        /// One sentence of what to look at in this step's visual.
        public let notice: String?
        public let visualType: VisualType
        /// The visual's own payload, carried verbatim. Interpreting it is the
        /// visual's job, not the parser's — each one wants a different shape.
        public let data: JunoYAML.Value?
    }

    public struct QuizOption: Identifiable, Equatable, Sendable {
        public let id: Int
        public let label: String
        public let correct: Bool
        public let explanation: String?
    }

    public struct QuizQuestion: Identifiable, Equatable, Sendable {
        public let id: Int
        public let question: String
        public let options: [QuizOption]
        public let explanation: String?
        public let hint: String?
    }

    public struct Quiz: Equatable, Sendable {
        public let questions: [QuizQuestion]
    }

    public let blockId: String
    public let title: String
    public let label: String?
    public let description: String?
    /// `compact` tightens the layout for a narrow transcript column.
    public let density: Density?
    public let steps: [Step]
    public let submitLabel: String?
    public let quiz: Quiz?
    /// One-sentence closing summary, shown in the completion state.
    public let takeaway: String?

    // MARK: - Parsing

    private static let maxSteps = 8
    private static let maxOptions = 8

    /// Parses a `:::step-lab` body. Never throws; an unusable body becomes
    /// ``fallback(source:error:seed:)``.
    ///
    /// - Parameter seed: the block's source range, mixed into `blockId` so two
    ///   labs in one reply cannot collide and the same lab in the same reply
    ///   keeps its identity across re-renders.
    public static func parse(_ source: String, seed: String = "") -> (lab: JunoStepLab, error: String?) {
        let raw = JunoYAMLSubset.parse(source)
        guard case .mapping(let map) = raw else {
            return (
                fallback(source: source, error: "The Step Lab block must be a mapping.", seed: seed),
                "Invalid Step Lab schema."
            )
        }

        // Model-authored ids key the step rail, so a duplicate would leak one
        // step's interaction state into another. Deduped with a suffix rather
        // than renumbered, so an id the model referred to in prose survives.
        var seen = Set<String>()
        let steps = JunoYAML.recordArray(map.pick("steps"))
            .enumerated()
            .compactMap { index, step -> Step? in
                let title = JunoYAML.cleanString(step.pick("title"), fallback: "Step \(index + 1)")
                let summary = JunoYAML.cleanString(step.pick("summary", "body", "description"))
                guard !title.isEmpty, !summary.isEmpty else { return nil }
                var id = String(
                    JunoYAML.cleanString(step.pick("id"), fallback: "step_\(index + 1)")
                        .map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? $0 : "_" }
                        .prefix(80)
                )
                while seen.contains(id) { id = "\(id)_\(index + 1)" }
                seen.insert(id)
                let detail = JunoYAML.cleanString(step.pick("detail", "details"))
                let notice = JunoYAML.cleanString(step.pick("notice", "note"))
                return Step(
                    id: id,
                    title: title,
                    summary: summary,
                    detail: detail.isEmpty ? nil : detail,
                    notice: notice.isEmpty ? nil : notice,
                    visualType: visualType(step.pick("visualType", "type"), in: step),
                    data: step["data"]
                )
            }
            .prefix(maxSteps)
            .map { $0 }

        guard !steps.isEmpty else {
            return (
                fallback(
                    source: source,
                    error: "Add at least one step with title, summary, visualType, and data.",
                    seed: seed
                ),
                "Step Lab has no valid steps."
            )
        }

        let density = JunoYAML.cleanString(map.pick("density")).lowercased()
        let label = JunoYAML.cleanString(map.pick("label"), fallback: "Step Lab")
        let description = JunoYAML.cleanString(map.pick("description"))
        let takeaway = JunoYAML.cleanString(map.pick("takeaway", "recap"))
        return (
            JunoStepLab(
                blockId: stableId("\(seed):\(source)"),
                title: JunoYAML.cleanString(map.pick("title"), fallback: "Interactive learning lab"),
                label: label.isEmpty ? nil : label,
                description: description.isEmpty ? nil : description,
                density: Density(rawValue: density),
                steps: steps,
                submitLabel: JunoYAML.cleanString(map.pick("submitLabel"), fallback: "Finish"),
                quiz: quiz(map.pick("quiz")),
                takeaway: takeaway.isEmpty ? nil : takeaway
            ),
            nil
        )
    }

    /// A step whose `visualType` is missing or unknown still has to draw
    /// something. The step's own words are the only evidence available, so they
    /// are read for the subject — which is a guess, and is why an unrecognised
    /// step lands on the neutral `generic-process` rather than on whichever
    /// visual happened to be first.
    private static func visualType(_ value: JunoYAML.Value?, in step: JunoYAML.Map) -> VisualType {
        let raw = JunoYAML.cleanString(value).lowercased()
        if let known = VisualType(rawValue: raw) { return known }
        let hint = [
            JunoYAML.cleanString(step.pick("id")),
            JunoYAML.cleanString(step.pick("title")),
            JunoYAML.cleanString(step.pick("summary")),
        ].joined(separator: " ").lowercased()
        if hint.contains("token") { return .tokenization }
        if hint.contains("embed") || hint.contains("vector") { return .embedding }
        if hint.contains("attention") || hint.contains("context") { return .attention }
        if hint.contains("transformer") || hint.contains("layer") { return .transformerProcessing }
        if hint.contains("probab") || hint.contains("distribution")
            || hint.contains("softmax") || hint.contains("candidate")
        { return .probabilityDistribution }
        if hint.contains("select") || hint.contains("output") || hint.contains("next") {
            return .nextTokenSelection
        }
        return .genericProcess
    }

    /// Mirrors the standalone `:::quiz` parser: correctness may be `correct:
    /// true` or the `answer:` key, and options may be plain strings. Returns nil
    /// unless the question has 2+ options and one of them is right.
    private static func quizQuestion(_ value: JunoYAML.Value?, index: Int) -> QuizQuestion? {
        guard case .mapping(let map) = value else { return nil }
        let question = JunoYAML.cleanString(map.pick("question", "title"))
        let answerText = JunoYAML.cleanString(map.pick("answer")).lowercased()
        let options = JunoYAML.array(map.pick("options"))
            .compactMap { option -> (String, Bool, String?)? in
                switch option {
                case .string, .number:
                    let label = JunoYAML.cleanString(option)
                    guard !label.isEmpty else { return nil }
                    return (label, !answerText.isEmpty && label.lowercased() == answerText, nil)
                case .mapping(let entry):
                    let label = JunoYAML.cleanString(entry.pick("label", "title", "text"))
                    guard !label.isEmpty else { return nil }
                    let correct = entry.pick("correct") == .bool(true)
                        || (!answerText.isEmpty && label.lowercased() == answerText)
                    let why = JunoYAML.cleanString(entry.pick("explanation"))
                    return (label, correct, why.isEmpty ? nil : why)
                default:
                    return nil
                }
            }
            .prefix(maxOptions)
            .enumerated()
            .map { QuizOption(id: $0.offset, label: $0.element.0, correct: $0.element.1, explanation: $0.element.2) }

        guard !question.isEmpty, options.count >= 2, options.contains(where: \.correct) else {
            return nil
        }
        let explanation = JunoYAML.cleanString(map.pick("explanation"))
        let hint = JunoYAML.cleanString(map.pick("hint"))
        return QuizQuestion(
            id: index,
            question: question,
            options: options,
            explanation: explanation.isEmpty ? nil : explanation,
            hint: hint.isEmpty ? nil : hint
        )
    }

    private static func quiz(_ value: JunoYAML.Value?) -> Quiz? {
        guard case .mapping(let map) = value else { return nil }
        // Multi-question (`questions:` list) or the legacy single-question shape.
        let list = JunoYAML.arrayOrNil(map.pick("questions"))
        let source = list ?? [.mapping(map)]
        let questions = source.enumerated()
            .compactMap { quizQuestion($0.element, index: $0.offset) }
            .prefix(maxSteps)
            .map { $0 }
        return questions.isEmpty ? nil : Quiz(questions: questions)
    }

    /// The lab shown when the body could not be read. It carries the reason so
    /// the failure is diagnosable from the transcript rather than only from a
    /// console nobody is looking at.
    static func fallback(source: String, error: String, seed: String) -> JunoStepLab {
        let title = titleLine(in: source) ?? "Visual explanation"
        return JunoStepLab(
            blockId: stableId("\(seed):fallback:\(source)"),
            title: title,
            label: "Step Lab",
            description: "This visual explanation was incomplete, so Juno is showing a safe fallback.",
            density: nil,
            steps: [
                Step(
                    id: "fallback",
                    title: "Visual explanation",
                    summary: "The Step Lab data was malformed or incomplete.",
                    detail: error,
                    notice: nil,
                    visualType: .genericProcess,
                    data: .mapping([
                        "input": .string(title),
                        "transform": .string("Validate the explanation data"),
                        "output": .string("Readable fallback instead of a broken block"),
                    ])
                )
            ],
            submitLabel: nil,
            quiz: nil,
            takeaway: nil
        )
    }

    /// `/^title:\s*(.+)$/m` — the one field worth rescuing from an unparseable
    /// body, because it is what lets the fallback name the lesson that broke.
    private static func titleLine(in source: String) -> String? {
        for line in source.components(separatedBy: "\n") {
            guard line.hasPrefix("title:") else { continue }
            let value = line.dropFirst("title:".count).drop(while: { $0.isWhitespace })
            let cleaned = JunoYAML.cleanString(.string(String(value)))
            if !cleaned.isEmpty { return cleaned }
        }
        return nil
    }
}
