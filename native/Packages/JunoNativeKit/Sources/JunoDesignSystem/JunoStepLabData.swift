import Foundation

/// What each Step Lab visual reads out of its step's free-form `data` payload —
/// the Swift half of the reader functions at the top of
/// `src/components/chat/step-lab-block.tsx`.
///
/// **On the fallbacks.** Every reader here has one, and that is a deliberate
/// exception to Juno's usual rule that a client never draws what the data cannot
/// support. It holds because a Step Lab's subject is fixed: these visuals
/// illustrate how a language model works, not the reader's own data. A default
/// five-candidate distribution is a *diagram of sampling*, the same way a
/// textbook's example numbers are — it claims nothing about this conversation.
/// The alternative is a lesson with a hole in the middle whenever the model
/// writes the prose and forgets the payload, which is common.
///
/// Where a fallback would make a claim about the reader's content, there isn't
/// one: the tokenisation input, the process stations and the selected token all
/// fall back to the step's OWN title and summary rather than to invented text.
enum JunoStepLabData {

    struct Token: Equatable {
        let text: String
        /// A stable pseudo vocabulary id. Not a real one — no tokenizer ships
        /// here — but stable per string, which is what makes "the same word gets
        /// the same id" demonstrable.
        let id: Int
    }

    struct VectorExample: Equatable {
        let token: String
        let vector: [Double]
    }

    struct Attention: Equatable {
        let tokens: [String]
        let matrix: [[Double]]
    }

    struct Candidate: Equatable {
        let token: String
        let probability: Double
        let note: String?
    }

    struct Station: Equatable {
        let cap: String
        let value: String
    }

    struct NextToken: Equatable {
        let prompt: String
        let token: String
    }

    // MARK: - Readers

    static func tokens(_ step: JunoStepLab.Step) -> (input: String, tokens: [Token]) {
        let data = mapping(step.data)
        let input = string(data["input"]) ?? "\(step.title): \(step.summary)"
        let parsed = JunoYAML.array(data["tokens"]).compactMap { item -> Token? in
            switch item {
            case .string, .number:
                guard let text = string(item) else { return nil }
                return Token(text: text, id: hashNumber(text))
            case .mapping(let entry):
                guard let text = string(entry.pick("text", "token")) else { return nil }
                return Token(text: text, id: number(entry["id"]).map { Int($0) } ?? hashNumber(text))
            default:
                return nil
            }
        }
        return (input, parsed.isEmpty ? fallbackTokens(step) : parsed)
    }

    static func vectors(_ step: JunoStepLab.Step) -> [VectorExample] {
        let data = mapping(step.data)
        let parsed = JunoYAML.array(data["examples"]).compactMap { item -> VectorExample? in
            guard case .mapping(let entry) = item,
                let token = string(entry.pick("token", "text"))
            else { return nil }
            let vector = JunoYAML.array(entry["vector"]).compactMap { number($0) }.prefix(6).map { $0 }
            guard !vector.isEmpty else { return nil }
            return VectorExample(token: token, vector: vector)
        }
        if !parsed.isEmpty { return parsed }
        return fallbackTokens(step).prefix(3).enumerated().map { index, token in
            VectorExample(
                token: token.text,
                vector: [
                    0.12 + Double(index) * 0.14,
                    -0.44 + Double(index) * 0.09,
                    0.87 - Double(index) * 0.11,
                    0.31 + Double(index) * 0.05,
                ]
            )
        }
    }

    static func attention(_ step: JunoStepLab.Step) -> Attention {
        let data = mapping(step.data)
        // Fall back whenever the list cannot draw a RELATION (fewer than two
        // tokens). Gating only on "is it a list" let a one-token payload through
        // and produced a matrix with no second axis.
        let parsed = JunoYAML.array(data["tokens"]).compactMap { string($0) }.prefix(7).map { $0 }
        let fallback = fallbackTokens(step).map(\.text).prefix(6).map { $0 }
        let tokens = parsed.count >= 2
            ? parsed
            : (fallback.count >= 2 ? fallback : ["input", "process", "output"])

        let matrix = JunoYAML.array(data["matrix"])
            .map { row in
                JunoYAML.array(row).compactMap { number($0) }.prefix(tokens.count).map { $0 }
            }
            .filter { !$0.isEmpty }
            .prefix(tokens.count)
            .map { $0 }
        if matrix.count == tokens.count { return Attention(tokens: tokens, matrix: matrix) }

        // A locality prior: every token attends a little to itself and more to
        // its neighbours. It is not this model's attention — it is the SHAPE of
        // attention, which is what a reader with no payload still needs to see.
        let synthesized = tokens.indices.map { row in
            tokens.indices.map { column in
                row == column ? 0.16 : max(0.08, 0.42 - Double(abs(row - column)) * 0.08)
            }
        }
        return Attention(tokens: tokens, matrix: synthesized)
    }

    static func candidates(_ step: JunoStepLab.Step) -> [Candidate] {
        let data = mapping(step.data)
        let parsed = JunoYAML.array(data["candidates"]).compactMap { item -> Candidate? in
            guard case .mapping(let entry) = item,
                let token = string(entry.pick("token", "text")),
                let probability = number(entry.pick("probability", "p"))
            else { return nil }
            // Percentages and fractions both appear; anything above 1 is read as
            // a percentage, because a probability cannot be.
            return Candidate(
                token: token,
                probability: probability > 1 ? probability / 100 : probability,
                note: string(entry.pick("note", "explanation"))
            )
        }
        if !parsed.isEmpty { return Array(parsed.prefix(6)) }
        return [
            Candidate(token: "word", probability: 0.42, note: nil),
            Candidate(token: "token", probability: 0.27, note: nil),
            Candidate(token: "step", probability: 0.16, note: nil),
            Candidate(token: "output", probability: 0.1, note: nil),
            Candidate(token: ".", probability: 0.05, note: nil),
        ]
    }

    static func transformerTokens(_ step: JunoStepLab.Step) -> [String] {
        let data = mapping(step.data)
        let parsed = JunoYAML.array(data["tokens"]).compactMap { string($0) }.prefix(5).map { $0 }
        return parsed.isEmpty ? fallbackTokens(step).map(\.text).prefix(5).map { $0 } : parsed
    }

    static func layers(_ step: JunoStepLab.Step) -> Int {
        if case .number(let value) = mapping(step.data)["layers"] { return Int(value) }
        return 12
    }

    static func nextToken(_ step: JunoStepLab.Step) -> NextToken {
        let data = mapping(step.data)
        return NextToken(
            prompt: string(data["prompt"]) ?? "The model predicts the next",
            token: string(data.pick("selectedToken", "token", "output"))
                ?? candidates(step).first?.token
                ?? "word"
        )
    }

    static func stations(_ step: JunoStepLab.Step) -> [Station] {
        let data = mapping(step.data)
        return [
            Station(cap: "input", value: string(data["input"]) ?? step.title),
            Station(cap: "transform", value: string(data.pick("transform", "process")) ?? step.summary),
            Station(cap: "output", value: string(data["output"]) ?? "Clearer understanding"),
        ]
    }

    // MARK: - Primitives

    private static func mapping(_ value: JunoYAML.Value?) -> JunoYAML.Map {
        if case .mapping(let map) = value { return map }
        return [:]
    }

    /// `asString` — a trimmed string, or the JavaScript print of a number or
    /// boolean. An empty string is nil, so `?? fallback` works the way the web's
    /// `asString(...) ?? default` does.
    private static func string(_ value: JunoYAML.Value?) -> String? {
        switch value {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .number(let number): return JunoYAML.jsNumber(number)
        case .bool(let flag): return flag ? "true" : "false"
        default: return nil
        }
    }

    private static func number(_ value: JunoYAML.Value?) -> Double? {
        switch value {
        case .number(let number): return number.isFinite ? number : nil
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, let parsed = Double(trimmed), parsed.isFinite else { return nil }
            return parsed
        default: return nil
        }
    }

    /// Words from the step's own `data.input`, or from its title and summary.
    /// Never from a canned sentence: the tokens on screen have to be words the
    /// reader just read, or the visual is illustrating someone else's example.
    private static func fallbackTokens(_ step: JunoStepLab.Step) -> [Token] {
        let source = string(mapping(step.data)["input"]) ?? "\(step.title) \(step.summary)"
        let scrubbed: [Character] = source.map { character in
            // JavaScript's `[^\w\s'-]` — ASCII word characters only, so an
            // accented word splits here exactly as it does on the web.
            let keep = (character.isASCII && (character.isLetter || character.isNumber))
                || character == "_" || character.isWhitespace
                || character == "'" || character == "-"
            return keep ? character : " "
        }
        let pieces: [ArraySlice<Character>] = scrubbed.split(whereSeparator: \.isWhitespace)
        let words: [String] = pieces.prefix(7).map { String($0) }
        let base = words.isEmpty ? ["input", "transform", "output"] : words
        return base.map { Token(text: $0, id: hashNumber($0)) }
    }

    /// FNV-1a over UTF-16 units, folded into a plausible vocabulary range. The
    /// point is only that the same string always yields the same number.
    static func hashNumber(_ value: String, min: Int = 200, max: Int = 50_000) -> Int {
        var hash = Int32(bitPattern: 2_166_136_261)
        for unit in value.utf16 {
            hash = (hash ^ Int32(unit)) &* 16_777_619
        }
        return min + abs(Int(hash)) % (max - min)
    }

    /// The web's `mulberry32`, one draw. The PRNG is here rather than
    /// `SystemRandomNumberGenerator` because the sample has to REPLAY: the same
    /// press count must draw the same token, so the visual can be pointed at.
    static func mulberry32(seed: UInt32) -> Double {
        let a = seed &+ 0x6d2b_79f5
        var t = (a ^ (a >> 15)) &* (1 | a)
        t = ((t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t)
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }
}
