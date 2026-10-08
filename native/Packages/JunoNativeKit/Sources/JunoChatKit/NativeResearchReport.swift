import Foundation

/// A finished research report, ready to read — one model for both ways a
/// report reaches a native app, so the Mac window and the phone's reader draw
/// the same document:
///
/// - **In the chat** (today's production path for an app): the answer's prose,
///   then one `<juno:artifact identifier="research-report" type="MARKDOWN">`
///   holding the whole report (`RESEARCH_OUTPUT_CONTRACT`). Its citations
///   number the answer's `sources` positionally, from one.
/// - **On a run** (a web background run): the run's `report`, whose citations
///   number the sources it read, in the order the run holds them (the web's
///   fallback numbering).
///
/// The body is split at its `#`, `##` and `###` headings, outside code, so a
/// reader can follow the reading position and jump between sections; a
/// leading `#` that only repeats the title is dropped (the cover sets it).
public struct NativeResearchReport: Equatable, Sendable, Identifiable {
    public struct Section: Identifiable, Equatable, Sendable {
        public let id: String
        /// The heading's words; empty for what comes before the first one.
        public let title: String
        /// 1 for `#`, 2 for `##`, 3 for `###`; 0 for the lead-in.
        public let level: Int
        /// The section's Markdown, its heading line removed.
        public let markdown: String

        public init(id: String, title: String, level: Int, markdown: String) {
            self.id = id
            self.title = title
            self.level = level
            self.markdown = markdown
        }
    }

    /// `run:<id>` or `message:<id>` — what a window or a sheet reopens.
    public let id: String
    public let title: String
    /// The reader's question, when it is known and is not the title.
    public let question: String?
    /// The chat answer's short prose, which stands in front of an in-chat
    /// report as its dek.
    public let lede: String?
    public let body: String
    public let sections: [Section]
    /// The sources, numbered as the report's `[n]` count them.
    public let sources: [NativeChatSource]
    /// How many sources the `[n]` marks may point at: zero leaves brackets as
    /// the text they are.
    public let citationCount: Int
    public let words: Int
    /// The answer the citation check was run on.
    public let messageID: String?
    public let auditSummary: NativeResearchRun.AuditSummary?
    /// Pages the run read, when known (a run's own count, or the in-chat rows').
    public let pagesRead: Int?
    public let finishedAt: Date?

    public init(
        id: String,
        title: String,
        question: String? = nil,
        lede: String? = nil,
        body: String,
        sources: [NativeChatSource],
        citationCount: Int? = nil,
        messageID: String? = nil,
        auditSummary: NativeResearchRun.AuditSummary? = nil,
        pagesRead: Int? = nil,
        finishedAt: Date? = nil
    ) {
        let split = Self.split(body: body, title: title)
        let asked = question?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        // A report with no title of its own goes by the reader's question.
        let resolved = split.title == "Research report" && asked != nil && asked!.count <= 140 ? asked! : split.title
        self.id = id
        self.title = resolved
        self.question = asked.flatMap { $0.caseInsensitiveCompare(resolved) == .orderedSame ? nil : $0 }
        let dek = lede?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.lede = dek.flatMap { $0.isEmpty ? nil : $0 }
        self.body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        self.sections = split.sections
        self.sources = sources
        self.citationCount = citationCount ?? sources.count
        self.words = self.body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
        self.messageID = messageID
        self.auditSummary = auditSummary
        self.pagesRead = pagesRead
        self.finishedAt = finishedAt
    }

    // MARK: From a run

    /// A run's report, or nil when it wrote none.
    public init?(run: NativeResearchRun) {
        guard let body = run.reportBody, !body.isEmpty else { return nil }
        let read = run.sources.filter(\.read)
        self.init(
            id: "run:\(run.id)",
            title: run.displayTitle,
            question: run.goal,
            body: body,
            sources: read.map { NativeChatSource(title: $0.title, url: $0.url, snippet: "", cited: true) },
            messageID: run.assistantMessageID,
            auditSummary: run.audit,
            pagesRead: max(run.counts.pages, run.readSourceCount),
            finishedAt: run.finishedAt
        )
    }

    // MARK: From a chat answer

    /// Whether an artifact is a research report: the in-chat writer names it
    /// `research-report`, a background run `research-report-<run id>`.
    public static func isReport(_ artifact: NativeMessageContent.ArtifactReference) -> Bool {
        artifact.identifier == "research-report" || artifact.identifier.hasPrefix("research-report-")
    }

    /// The research report a finished answer carries, or nil when it carries
    /// none (or it is still being written).
    public init?(message: NativeChatMessage, question: String? = nil) {
        let parts = NativeMessageContent.parts(of: message.content)
        guard let artifact = parts.lazy.compactMap({ part -> NativeMessageContent.ArtifactReference? in
            if case .artifact(let artifact) = part, Self.isReport(artifact), !artifact.streaming { return artifact }
            return nil
        }).first else { return nil }
        let body = artifact.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return nil }
        let prose = parts.compactMap { part -> String? in
            if case .text(let text) = part { return text }
            return nil
        }
        .joined(separator: "\n\n")
        let lede = NativeMessageContent.strippingTrailingSourcesSection(prose)
        let research = NativeResearchRun.inChat(message: message, live: false)
        self.init(
            id: "message:\(message.id)",
            title: artifact.title,
            question: question,
            lede: lede,
            body: body,
            sources: message.sources,
            citationCount: message.sources.contains(where: \.cited) ? message.sources.count : 0,
            messageID: message.id,
            pagesRead: research.counts.read > 0 ? research.counts.read : nil,
            finishedAt: message.createdAt
        )
    }

    // MARK: Reading

    /// The sections a reader can jump to.
    public var headings: [Section] { sections.filter { $0.level > 0 } }

    /// The web's reading time: 220 words a minute, at least one.
    public var minutes: Int { max(1, Int((Double(words) / 220).rounded(.up))) }

    /// "2,140 words · 10 min read · 18 sources".
    public var metaLine: String {
        var parts = ["\(words.formatted()) words", "\(minutes) min read"]
        if !sources.isEmpty {
            parts.append("\(sources.count) \(sources.count == 1 ? "source" : "sources")")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The report as a Markdown file: its title, its words, then a
    /// `## Sources` appendix numbered as the citations are.
    public func markdown(accessed: Date) -> String {
        var text = body
        if !body.hasPrefix("# ") { text = "# \(title)\n\n" + body }
        guard !sources.isEmpty else { return text + "\n" }
        let day = accessed.formatted(.iso8601.year().month().day())
        let list = sources.enumerated().map { index, source in
            "[\(index + 1)] \(Self.displayTitle(source)) \u{2014} \(source.url.absoluteString) (accessed \(day))"
        }
        return text + "\n\n## Sources\n\n" + list.joined(separator: "\n\n") + "\n"
    }

    /// `{slug(title)}.{ext}`, or `research-{yyyy-mm-dd}` when the title leaves
    /// nothing: decomposed, marks stripped, lowercase, anything else a hyphen,
    /// at most 80 characters.
    public func fileName(on date: Date, extension ext: String = "md") -> String {
        let folded = title.decomposedStringWithCompatibilityMapping
            .unicodeScalars
            .filter { !CharacterSet.nonBaseCharacters.contains($0) }
        var slug = ""
        var pendingHyphen = false
        for scalar in String(String.UnicodeScalarView(folded)).lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar), scalar.isASCII {
                if pendingHyphen, !slug.isEmpty { slug.append("-") }
                pendingHyphen = false
                slug.unicodeScalars.append(scalar)
            } else {
                pendingHyphen = true
            }
        }
        slug = String(slug.prefix(80))
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.isEmpty { slug = "research-\(date.formatted(.iso8601.year().month().day()))" }
        return slug + "." + ext
    }

    /// The bare host, without the `www.` that carries no information.
    public static func host(_ url: URL) -> String {
        guard let host = url.host() else { return url.absoluteString }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// A human title, or the host when the model handed a URL as the title.
    public static func displayTitle(_ source: NativeChatSource) -> String {
        let title = source.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty || title == source.url.absoluteString || title.lowercased().hasPrefix("http") {
            return host(source.url)
        }
        return title
    }

    // MARK: Splitting

    /// The body's sections, and the title — the artifact's, unless it is the
    /// generic "research report" and the body opens with a `#` of its own.
    static func split(body: String, title: String) -> (title: String, sections: [Section]) {
        var sections = sections(of: body)
        var resolved = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let generic = resolved.isEmpty || resolved.lowercased() == "research report"
        // A report that opens on a `#` names itself: that heading is the cover's
        // title, not a section, when it is the first thing in the body.
        if let first = sections.first, first.level == 1,
            generic || first.title.caseInsensitiveCompare(resolved) == .orderedSame
                || sections.filter({ $0.level == 1 }).count == 1
        {
            if generic { resolved = first.title }
            sections.removeFirst()
            if !first.markdown.isEmpty {
                sections.insert(Section(id: first.id, title: "", level: 0, markdown: first.markdown), at: 0)
            }
        }
        if resolved.isEmpty || resolved.lowercased() == "research report" { resolved = "Research report" }
        return (resolved, sections)
    }

    /// The body split at its `#`, `##` and `###` headings, outside code.
    public static func sections(of body: String) -> [Section] {
        var sections: [Section] = []
        var title = ""
        var level = 0
        var lines: [Substring] = []
        var inFence = false
        func close() {
            let markdown = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !markdown.isEmpty || level > 0 {
                sections.append(Section(id: "section-\(sections.count)", title: title, level: level, markdown: markdown))
            }
            lines = []
        }
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle() }
            if !inFence, let heading = heading(in: trimmed) {
                close()
                title = heading.title
                level = heading.level
                continue
            }
            lines.append(line)
        }
        close()
        return sections
    }

    private static func heading(in line: String) -> (title: String, level: Int)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...3).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        let text = line.dropFirst(hashes).trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (text.replacingOccurrences(of: "**", with: ""), hashes)
    }

    /// The section's Markdown cut into blocks a page can break between:
    /// paragraphs, lists, tables and code fences, never inside one.
    public static func blocks(of markdown: String) -> [String] {
        var blocks: [String] = []
        var current: [Substring] = []
        var inFence = false
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle() }
            if !inFence, trimmed.isEmpty {
                if !current.isEmpty { blocks.append(current.joined(separator: "\n")) }
                current = []
            } else {
                current.append(line)
            }
        }
        if !current.isEmpty { blocks.append(current.joined(separator: "\n")) }
        return blocks
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
