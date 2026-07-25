import Foundation

/// The client half of Juno's message wire format — the Swift counterpart of
/// `src/lib/message-content.ts`.
///
/// The model wraps two things in custom tags, and **neither is prose**:
///
///     <juno:memory>The user prefers concise answers.</juno:memory>
///     <juno:artifact identifier="todo" type="react" title="Todo App">…</juno:artifact>
///
/// The website splits a reply on those tags before it renders: memories are
/// dropped outright (they are a side effect the server already persisted — the
/// reader sees them in Settings › Memory, never mid-answer), and artifacts become
/// an inline card. Native rendered `message.content` straight into the Markdown
/// view, so both leaked into the transcript as literal `<juno:memory>…` and a
/// screenful of raw artifact source.
///
/// The parsing lives here, next to `NativeChatMessage`, because it is a property
/// of the wire format rather than of any one view — the transcript, the copy
/// action, VoiceOver and search all need the same answer.
public enum NativeMessageContent {
    /// One renderable run of a reply, in source order.
    public enum Part: Equatable, Sendable {
        case text(String)
        case artifact(ArtifactReference)
    }

    /// An artifact the reply referred to. Everything here comes from the tag's
    /// own attributes, so a card can be drawn while the body is still streaming
    /// and its closing tag has not arrived.
    public struct ArtifactReference: Equatable, Sendable, Identifiable {
        public let identifier: String
        public let title: String
        public let kind: String
        public let language: String?
        /// True while the opening tag has been seen but the closing one has not.
        public let streaming: Bool
        /// The artifact's own source, exactly as the tag carried it.
        ///
        /// Carried, not discarded, because it is the only copy that is
        /// **guaranteed to exist**. The stored artifact row is written
        /// server-side and reaches this device on the next sync, so for the
        /// whole window between "the reply finished" and "the row arrived" —
        /// and permanently, for any reply whose row never syncs — the tag body
        /// is all there is. Tapping the card used to do nothing at all in that
        /// window; now it opens this.
        public let content: String

        public var id: String { identifier.isEmpty ? "\(title)-\(kind)" : identifier }

        public init(
            identifier: String,
            title: String,
            kind: String,
            language: String?,
            streaming: Bool,
            content: String = ""
        ) {
            self.identifier = identifier
            self.title = title
            self.kind = kind
            self.language = language
            self.streaming = streaming
            self.content = content
        }
    }

    // MARK: - Public

    /// Splits a reply into ordered text and artifact parts, with memories and
    /// clarification wizards removed.
    ///
    /// Empty and whitespace-only text runs are dropped rather than emitted as
    /// blank paragraphs, which is what put a gap above every answer that opened
    /// with an artifact.
    public static func parts(of raw: String) -> [Part] {
        let text = stripped(raw)
        var parts: [Part] = []
        var cursor = text.startIndex

        for match in artifactMatches(in: text) {
            appendText(String(text[cursor..<match.range.lowerBound]), to: &parts)
            // A nil reference is an elision: the range is consumed so the tag
            // cannot reach the reader, but nothing is drawn in its place.
            if let reference = match.reference { parts.append(.artifact(reference)) }
            cursor = match.range.upperBound
        }

        appendText(String(text[cursor...]), to: &parts)
        return parts
    }

    /// The reply as the reader sees it, flattened back to plain text: memories and
    /// clarification wizards gone, artifacts reduced to their title.
    ///
    /// This is what Copy puts on the pasteboard and what VoiceOver reads. Copying
    /// the raw string handed people a `<juno:memory>` tag they never saw on screen.
    public static func plainText(of raw: String) -> String {
        parts(of: raw)
            .map { part in
                switch part {
                case .text(let text): text
                case .artifact(let artifact): artifact.title
                }
            }
            .joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Drops a trailing `## Sources` list, which the transcript already shows as
    /// source chips.
    ///
    /// Only worth calling when the message *has* chips — otherwise the section is
    /// the only citation the reader gets. Conservative on the same three counts as
    /// the web (`stripTrailingSourcesSection` in `message-item.tsx`): only the last
    /// such heading, only when every line under it is a `[1]`-style entry — a
    /// Sources section the model wrote prose into is the model saying something —
    /// and never a heading inside a code fence.
    public static func strippingTrailingSourcesSection(_ content: String) -> String {
        let lines = content.components(separatedBy: "\n")
        var start: Int?
        var fenced = false

        for (index, line) in lines.enumerated() {
            if isFence(line) {
                fenced.toggle()
            } else if !fenced, isSourcesHeading(line) {
                start = index
            }
        }

        guard let start else { return content }
        guard lines[(start + 1)...].allSatisfy(isCitationEntry) else { return content }
        return lines[..<start].joined(separator: "\n").trimmingTrailingWhitespace
    }

    /// The durable facts the model asked to remember, in source order.
    ///
    /// The server persists these; the client parses them only to *avoid*
    /// rendering them, and to let a caller show what was learned somewhere the
    /// reader expects it.
    public static func memories(in raw: String) -> [String] {
        ranges(of: memoryOpen, close: memoryClose, in: raw)
            .map { raw[$0.body].trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    // MARK: - Sources section

    /// ``` or ~~~ with up to three leading spaces.
    private static func isFence(_ line: String) -> Bool {
        let body = line.drop(while: { $0 == " " })
        guard line.count - body.count <= 3 else { return false }
        return body.prefix(3) == "```" || body.prefix(3) == "~~~"
    }

    /// `#`…`######` then whitespace then exactly `sources`.
    private static func isSourcesHeading(_ line: String) -> Bool {
        var rest = Substring(line)
        let hashes = rest.prefix(while: { $0 == "#" })
        guard (1...6).contains(hashes.count) else { return false }
        rest = rest.dropFirst(hashes.count)
        guard rest.first?.isWhitespace == true else { return false }
        return rest.trimmingCharacters(in: .whitespaces).lowercased() == "sources"
    }

    /// Blank, or a `[12]` / `- [12]` / `* [12]` citation entry.
    private static func isCitationEntry(_ line: String) -> Bool {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        var rest = Substring(line).drop(while: { $0.isWhitespace })
        if rest.first == "-" || rest.first == "*" {
            let afterMarker = rest.dropFirst()
            // Whitespace after the bullet is required, so `-[1]` is prose.
            guard afterMarker.first?.isWhitespace == true else { return false }
            rest = afterMarker.drop(while: { $0.isWhitespace })
        }
        guard rest.first == "[" else { return false }
        let digits = rest.dropFirst().prefix(while: { $0.isNumber })
        guard (1...3).contains(digits.count) else { return false }
        return rest.dropFirst(1 + digits.count).first == "]"
    }

    // MARK: - Tags

    private static let memoryOpen = "<juno:memory>"
    private static let memoryClose = "</juno:memory>"
    private static let artifactOpen = "<juno:artifact"
    private static let artifactClose = "</juno:artifact>"
    private static let wizardFence = ":::clarification-wizard"
    private static let fenceClose = ":::"

    // MARK: - Stripping

    /// Removes everything the reader must never see: memories, and the
    /// clarification wizard the composer renders as its own control.
    private static func stripped(_ raw: String) -> String {
        var text = removingBlocks(open: memoryOpen, close: memoryClose, in: raw)
        text = removingWizards(in: text)
        return text
    }

    private static func removingBlocks(
        open: String,
        close: String,
        in text: String
    ) -> String {
        let blocks = ranges(of: open, close: close, in: text)
        guard !blocks.isEmpty else { return text }
        var result = ""
        var cursor = text.startIndex
        for block in blocks {
            result += text[cursor..<block.whole.lowerBound]
            cursor = block.whole.upperBound
        }
        result += text[cursor...]
        return result
    }

    /// `:::clarification-wizard … :::` — a fenced block, so it is matched by its
    /// opening marker and the next bare fence rather than by a tag pair. An
    /// unterminated one (still streaming) is dropped to the end of the string,
    /// exactly as the web's non-greedy regex does when it fails to match.
    private static func removingWizards(in text: String) -> String {
        guard text.range(of: wizardFence, options: .caseInsensitive) != nil else { return text }
        var result = ""
        var cursor = text.startIndex
        while let start = text.range(
            of: wizardFence, options: .caseInsensitive, range: cursor..<text.endIndex
        ) {
            result += text[cursor..<start.lowerBound]
            if let end = text.range(of: fenceClose, range: start.upperBound..<text.endIndex) {
                cursor = end.upperBound
            } else {
                cursor = text.endIndex
            }
        }
        result += text[cursor...]
        return result
    }

    // MARK: - Artifacts

    private struct ArtifactMatch {
        let range: Range<String.Index>
        /// Nil when the tag should be removed without drawing anything.
        let reference: ArtifactReference?
    }

    /// Every artifact in the text, closed or not.
    ///
    /// A trailing *unclosed* artifact is matched deliberately: a reply that is
    /// still streaming has an opening tag and no closing one for as long as the
    /// body takes to arrive, and leaving it unmatched showed the source instead
    /// of a card for that whole time.
    private static func artifactMatches(in text: String) -> [ArtifactMatch] {
        var matches: [ArtifactMatch] = []
        var cursor = text.startIndex

        while let open = text.range(of: artifactOpen, range: cursor..<text.endIndex) {
            // No `>` yet: the attribute list itself is mid-flight. There is
            // nothing to name the card with, so emit a placeholder and stop.
            guard let tagEnd = text.range(of: ">", range: open.upperBound..<text.endIndex) else {
                matches.append(
                    ArtifactMatch(
                        range: open.lowerBound..<text.endIndex,
                        reference: ArtifactReference(
                            identifier: "",
                            title: "Untitled artifact",
                            kind: "CODE",
                            language: nil,
                            streaming: true
                        )
                    )
                )
                return matches
            }

            let attributes = parseAttributes(String(text[open.upperBound..<tagEnd.lowerBound]))
            let close = text.range(of: artifactClose, range: tagEnd.upperBound..<text.endIndex)
            let body = String(text[tagEnd.upperBound..<(close?.lowerBound ?? text.endIndex)])
            let streaming = close == nil

            // A closed artifact with an empty body earns no card — the model
            // opened and closed the tag without writing anything, and a card for
            // nothing is worse than no card. The *range* is still consumed:
            // returning no match at all left the literal tag in the prose, which
            // is the one outcome this type exists to prevent.
            let isEmpty = !streaming
                && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            matches.append(
                ArtifactMatch(
                    range: open.lowerBound..<(close?.upperBound ?? text.endIndex),
                    reference: isEmpty
                        ? nil
                        : ArtifactReference(
                            identifier: identifier(attributes, body: body),
                            title: attributes["title"]?.nilIfEmpty
                                ?? (streaming ? "Untitled artifact" : "Untitled"),
                            kind: normalizedKind(attributes["type"]),
                            language: attributes["language"]?.nilIfEmpty,
                            streaming: streaming,
                            content: body.trimmingCharacters(in: .whitespacesAndNewlines)
                        )
                )
            )

            guard let close else { return matches }
            cursor = close.upperBound
        }

        return matches
    }

    /// Accepts double-quoted, single-quoted and unquoted values, as the web's
    /// attribute regex does — the model writes all three.
    private static func parseAttributes(_ raw: String) -> [String: String] {
        var attributes: [String: String] = [:]
        var scanner = Substring(raw)

        while let nameStart = scanner.firstIndex(where: { $0.isLetter || $0 == "_" }) {
            scanner = scanner[nameStart...]
            guard let nameEnd = scanner.firstIndex(where: { !($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
            else { break }
            let name = String(scanner[..<nameEnd]).lowercased()
            scanner = scanner[nameEnd...]

            // Skip whitespace before `=`; a bare attribute has no value.
            guard let equals = scanner.firstIndex(where: { !$0.isWhitespace }), scanner[equals] == "=" else {
                continue
            }
            scanner = scanner[scanner.index(after: equals)...]
            guard let valueStart = scanner.firstIndex(where: { !$0.isWhitespace }) else { break }
            scanner = scanner[valueStart...]

            let quote = scanner.first
            if quote == "\"" || quote == "'" {
                let afterQuote = scanner.index(after: scanner.startIndex)
                guard let closing = scanner[afterQuote...].firstIndex(of: quote!) else { break }
                attributes[name] = String(scanner[afterQuote..<closing])
                scanner = scanner[scanner.index(after: closing)...]
            } else {
                let end = scanner.firstIndex(where: { $0.isWhitespace || $0 == ">" }) ?? scanner.endIndex
                attributes[name] = String(scanner[..<end])
                scanner = scanner[end...]
            }
        }

        return attributes
    }

    private static let knownKinds: Set<String> = [
        "HTML", "REACT", "CODE", "MARKDOWN", "SVG", "MERMAID",
    ]

    private static func normalizedKind(_ raw: String?) -> String {
        let upper = (raw ?? "").uppercased()
        return knownKinds.contains(upper) ? upper : "CODE"
    }

    /// The model omits `identifier` often enough that the web derives a stable one
    /// from the body. Same djb2 hash and same `art-` prefix, so a card keyed here
    /// matches the one the website drew for the same reply.
    private static func identifier(_ attributes: [String: String], body: String) -> String {
        if let given = attributes["identifier"]?.trimmingCharacters(in: .whitespaces).nilIfEmpty {
            return given
        }
        return "art-" + djb2(String(body.prefix(500)))
    }

    private static func djb2(_ value: String) -> String {
        var hash: UInt32 = 5381
        for unit in value.utf16 {
            // `<< 5 &+ hash &+ unit` in 32-bit wrapping arithmetic, matching
            // JavaScript's `((h << 5) + h + c) >>> 0`.
            hash = (hash << 5) &+ hash &+ UInt32(unit)
        }
        return String(hash, radix: 36)
    }

    // MARK: - Helpers

    private struct TagRange {
        /// The whole tag, opening marker through closing marker.
        let whole: Range<String.Index>
        /// Just the content between the markers.
        let body: Range<String.Index>
    }

    /// Every `open … close` pair, plus a trailing unterminated one so a tag that
    /// is still streaming is still recognised.
    private static func ranges(
        of open: String,
        close: String,
        in text: String
    ) -> [TagRange] {
        var found: [TagRange] = []
        var cursor = text.startIndex

        while let start = text.range(of: open, range: cursor..<text.endIndex) {
            guard let end = text.range(of: close, range: start.upperBound..<text.endIndex) else {
                found.append(
                    TagRange(
                        whole: start.lowerBound..<text.endIndex,
                        body: start.upperBound..<text.endIndex
                    )
                )
                return found
            }
            found.append(
                TagRange(
                    whole: start.lowerBound..<end.upperBound,
                    body: start.upperBound..<end.lowerBound
                )
            )
            cursor = end.upperBound
        }

        return found
    }

    private static func appendText(_ run: String, to parts: inout [Part]) {
        guard !run.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        parts.append(.text(run))
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }

    /// JavaScript's `trimEnd()`: trailing whitespace only, leading kept.
    var trimmingTrailingWhitespace: String {
        String(reversed().drop(while: { $0.isWhitespace || $0.isNewline }).reversed())
    }
}
