import Foundation

/// One numbered source a `[n]` marker is allowed to refer to.
///
/// A citation only ever comes into existence by registering something that was
/// actually retrieved. There is no initializer that takes a number, because a
/// number handed in from outside is exactly how a marker ends up pointing at a
/// source that was never read.
public struct Citation: Equatable, Sendable, Identifiable {
    /// 1-based, and identical to the digits inside the `[n]` marker.
    public let number: Int
    public let title: String
    /// nil for a local document. Not a synthesized `file://` URL: a citation
    /// that renders as a link the reader cannot open is worse than one that
    /// renders as plain text naming the file.
    public let url: URL?
    /// Where in the source, e.g. `Q3 Report.pdf, page 4 — Revenue`.
    public let locator: String
    public let snippet: String

    public var id: Int { number }
}

/// The only thing allowed to mint `[n]` markers.
///
/// The rule this type exists to enforce: **a marker may appear in output only
/// when it maps to a source that was really retrieved.** Models invent citations
/// — they will happily write `[7]` over a corpus of three documents, or cite
/// `[2]` for a claim that came from `[1]` — and a fabricated marker is more
/// damaging than no marker at all, because it renders as a verified link and
/// nothing about it looks wrong. `sanitized(_:)` is therefore not a formatting
/// nicety; it is the check that stands between a hallucinated number and a
/// reader who trusts it.
public struct CitationRegistry: Equatable, Sendable {
    public private(set) var citations: [Citation] = []
    /// Dedupe keys, so the same page cited from three passages is one number.
    private var numbersByKey: [String: Int] = [:]

    public init() {}

    public var isEmpty: Bool { citations.isEmpty }
    public var count: Int { citations.count }

    /// Registers a source and returns the number that refers to it, reusing the
    /// number if this source is already registered.
    @discardableResult
    public mutating func register(
        title: String,
        url: URL?,
        locator: String,
        snippet: String
    ) -> Int {
        let key = Self.dedupeKey(url: url, locator: locator, title: title)
        if let existing = numbersByKey[key] { return existing }
        let number = citations.count + 1
        citations.append(
            Citation(
                number: number,
                url: url,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                locator: locator,
                snippet: snippet
            )
        )
        numbersByKey[key] = number
        return number
    }

    @discardableResult
    public mutating func register(_ passage: RetrievedPassage) -> Int {
        register(
            title: passage.chunk.sourceName,
            url: nil,
            locator: passage.chunk.locator,
            snippet: Self.snippet(from: passage.chunk.text)
        )
    }

    public func citation(number: Int) -> Citation? {
        guard number >= 1, number <= citations.count else { return nil }
        return citations[number - 1]
    }

    /// Removes every `[n]` whose `n` maps to no registered source.
    ///
    /// Removed, not renumbered and not clamped to the nearest real source.
    /// Renumbering would silently attach the claim to a *different* document,
    /// which is a worse lie than dropping the marker: the sentence stays, it
    /// simply stops claiming a citation it never had.
    public func sanitized(_ markdown: String) -> String {
        transform(markdown) { number, marker in
            citation(number: number) == nil ? "" : marker
        }
    }

    /// Rewrites `[n]` into a clickable `[[n]](url)` for sources that have a URL.
    ///
    /// Markers for local documents are left as `[n]` — there is nothing to link
    /// to — and markers already followed by `(` are left alone so running this
    /// twice does not produce `[[[1]](u)](u)`.
    public func linked(_ markdown: String) -> String {
        transform(markdown) { number, marker in
            guard let url = citation(number: number)?.url else { return marker }
            return "[[\(number)](\(url.absoluteString))]"
        }
    }

    /// Sanitize, then link. The order matters: linking first would turn a
    /// fabricated `[9]` into a link before anything checked whether 9 exists.
    public func rendered(_ markdown: String) -> String {
        linked(sanitized(markdown))
    }

    /// The reference list to print under an answer, or nil when nothing was
    /// cited. Nil rather than an empty "Sources" heading, which reads as
    /// "sources were consulted and none are shown".
    public func referenceList() -> String? {
        guard !citations.isEmpty else { return nil }
        let lines = citations.map { citation -> String in
            if let url = citation.url {
                return "\(citation.number). [\(citation.title)](\(url.absoluteString))"
            }
            return "\(citation.number). \(citation.locator)"
        }
        return lines.joined(separator: "\n")
    }

    /// Which registered sources a piece of markdown actually cites.
    ///
    /// Used to drop sources that were retrieved but never referenced, so a
    /// reference list describes the answer instead of the search.
    public func citedNumbers(in markdown: String) -> Set<Int> {
        var found = Set<Int>()
        _ = transform(markdown) { number, marker in
            if citation(number: number) != nil { found.insert(number) }
            return marker
        }
        return found
    }

    // MARK: - Marker scanning

    /// Walks `[n]` markers outside fenced code, handing each to `body`.
    ///
    /// Fenced code is skipped because `array[0]` and `sed -n [1]p` are not
    /// citations, and rewriting them corrupts a code sample the reader is meant
    /// to copy. This is a scanner rather than a regular expression so the fence
    /// state and the "already a link" lookahead are visible in one place.
    private func transform(
        _ markdown: String,
        body: (Int, String) -> String
    ) -> String {
        var output = ""
        output.reserveCapacity(markdown.count)
        var inFence = false
        var isFirstLine = true

        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            if !isFirstLine { output.append("\n") }
            isFirstLine = false

            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                output += line
                continue
            }
            guard !inFence else {
                output += line
                continue
            }

            let characters = Array(line)
            var index = 0
            while index < characters.count {
                guard characters[index] == "[" else {
                    output.append(characters[index])
                    index += 1
                    continue
                }
                var cursor = index + 1
                var digits = ""
                while cursor < characters.count, characters[cursor].isNumber {
                    digits.append(characters[cursor])
                    cursor += 1
                }
                guard !digits.isEmpty,
                    cursor < characters.count,
                    characters[cursor] == "]",
                    let number = Int(digits)
                else {
                    output.append(characters[index])
                    index += 1
                    continue
                }
                // `[1](https://…)` is already a link, and `[1]:` is a reference
                // definition. Rewriting either breaks the document.
                let next = cursor + 1
                if next < characters.count, characters[next] == "(" || characters[next] == ":" {
                    output += String(characters[index ... cursor])
                    index = cursor + 1
                    continue
                }
                output += body(number, "[\(digits)]")
                index = cursor + 1
            }
        }
        return output
    }

    private static func dedupeKey(url: URL?, locator: String, title: String) -> String {
        if let url {
            // Fragment-only differences are the same page; case and a trailing
            // slash on the host are the same host.
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.fragment = nil
            let normalized = components?.url?.absoluteString ?? url.absoluteString
            return "url:" + normalized.lowercased()
        }
        return "doc:" + locator.lowercased() + "|" + title.lowercased()
    }

    /// A one-line preview of a source, condensed and bounded.
    ///
    /// Public because both the local research loop and the retrieved-context
    /// builder need the *same* preview: two different truncations of the same
    /// source render as two different sources to a reader comparing them.
    public static func snippet(from text: String, limit: Int = 280) -> String {
        let condensed = text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard condensed.count > limit else { return condensed }
        return String(condensed.prefix(limit)) + "…"
    }
}

private extension Citation {
    init(number: Int, url: URL?, title: String, locator: String, snippet: String) {
        self.number = number
        self.url = url
        // A source with no usable title is named by its locator rather than by
        // "Untitled", which tells the reader nothing about what they are
        // looking at.
        self.title = title.isEmpty ? locator : title
        self.locator = locator
        self.snippet = snippet
    }
}

/// Builds the retrieved-context block that goes into a prompt.
///
/// The block is numbered with the *same* numbers the registry hands out, which
/// is the whole mechanism: the model is shown `[1] Report.pdf, page 4` next to
/// the text it may cite as `[1]`, and anything it writes outside that range is
/// removed on the way out by `CitationRegistry.sanitized(_:)`.
public enum RetrievedContextPrompt {
    public struct Block: Equatable, Sendable {
        /// The text to prepend to the prompt, empty when nothing was retrieved.
        public let text: String
        /// The registry the answer must be sanitized against afterwards.
        public let registry: CitationRegistry
        /// Passages that did not fit in the budget. Reported rather than
        /// dropped silently, so a caller can say the context was truncated.
        public let omittedPassageCount: Int
    }

    /// - Parameter characterBudget: a ceiling on the passage text, not on the
    ///   whole block. Exceeding the model's context window turns a good answer
    ///   into a hard failure, so passages are dropped from the bottom — lowest
    ///   score first — rather than the block being truncated mid-sentence.
    public static func block(
        for passages: [RetrievedPassage],
        characterBudget: Int = 12_000,
        heading: String = "Retrieved context"
    ) -> Block {
        guard !passages.isEmpty, characterBudget > 0 else {
            return Block(text: "", registry: CitationRegistry(), omittedPassageCount: 0)
        }

        var registry = CitationRegistry()
        var lines: [String] = [
            "\(heading) — cite these with [n]. Do not cite anything not listed here.",
        ]
        var used = 0
        var omitted = 0

        for passage in passages {
            let remaining = characterBudget - used
            guard remaining > 0 else {
                omitted += 1
                continue
            }
            // Truncate the passage rather than dropping it when only part fits:
            // a partial passage still supports a citation, and the marker points
            // at the same real source either way.
            let text = passage.chunk.text.count > remaining
                ? String(passage.chunk.text.prefix(remaining)) + "…"
                : passage.chunk.text
            let number = registry.register(
                title: passage.chunk.sourceName,
                url: nil,
                locator: passage.chunk.locator,
                snippet: CitationRegistry.snippet(from: passage.chunk.text)
            )
            lines.append("[\(number)] \(passage.chunk.locator)\n\(text)")
            used += text.count
        }

        return Block(
            text: lines.joined(separator: "\n\n"),
            registry: registry,
            omittedPassageCount: omitted
        )
    }
}
