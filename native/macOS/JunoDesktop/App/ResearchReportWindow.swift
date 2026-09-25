import AppKit
import JunoChatKit
import JunoDesignSystem
import SwiftUI
import UniformTypeIdentifiers

// MARK: - The document

/// A research report, ready to read in its own window (register #65): the
/// Markdown artifact's body split at its headings, so the Contents column can
/// follow the reading position, and the sources it read, numbered as its
/// `[n]` citations count them — positionally, from one.
struct ResearchReportDocument: Equatable {
    struct Section: Identifiable, Equatable {
        let id: String
        /// The heading's words; empty for what comes before the first one.
        let title: String
        /// 1 for `#`, 2 for `##`, 3 for `###`; 0 for the lead-in.
        let level: Int
        let markdown: String
    }

    let runID: String
    let title: String
    let body: String
    let sections: [Section]
    let sources: [NativeResearchRun.Source]
    let words: Int
    /// The answer the citation check was run on, when the report is one.
    let messageID: String?

    init?(run: NativeResearchRun) {
        guard let body = run.reportBody, !body.isEmpty else { return nil }
        runID = run.id
        title = run.displayTitle
        self.body = body
        sections = Self.sections(of: body)
        // `[n]` counts the sources read, in the order the run holds them.
        sources = run.sources.filter(\.read)
        words = body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
        messageID = run.assistantMessageID
    }

    /// The sections a reader can jump to.
    var headings: [Section] { sections.filter { $0.level > 0 } }

    /// The web's reading time: 220 words a minute, at least one.
    var minutes: Int { max(1, Int((Double(words) / 220).rounded(.up))) }

    /// "Research report · 2,140 words · ~10 min read · 18 sources read".
    var subtitle: String {
        "Research report \u{00B7} \(words.formatted()) words \u{00B7} ~\(minutes) min read \u{00B7} "
            + "\(sources.count) \(sources.count == 1 ? "source" : "sources") read"
    }

    /// The report as a Markdown file: its words, then a `## Sources` appendix
    /// numbered as the citations are.
    func markdown(accessed: Date) -> String {
        guard !sources.isEmpty else { return body + "\n" }
        let day = accessed.formatted(.iso8601.year().month().day())
        let list = sources.enumerated().map { index, source in
            "[\(index + 1)] \(source.title) \u{2014} \(source.url.absoluteString) (accessed \(day))"
        }
        return body + "\n\n## Sources\n\n" + list.joined(separator: "\n\n") + "\n"
    }

    /// `{slug(title)}.md`, or `research-{yyyy-mm-dd}.md` when the title leaves
    /// nothing: decomposed, marks stripped, lowercase, anything else a hyphen,
    /// at most 80 characters.
    func fileName(on date: Date) -> String {
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
        return slug + ".md"
    }

    /// The body split at its `#`, `##` and `###` headings, outside code.
    static func sections(of body: String) -> [Section] {
        var sections: [Section] = []
        var title = ""
        var level = 0
        var lines: [Substring] = []
        var inFence = false
        func close() {
            let markdown = lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
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
        return text.isEmpty ? nil : (text, hashes)
    }
}

// MARK: - The window

/// The report's own window (register #65; the web opens a dialog): the
/// window's title is the report's, its subtitle what it is — words, reading
/// time, sources read. Copy, Export Markdown… and Print… in the toolbar,
/// declared once. A plain `HStack` — one `NavigationSplitView` per window,
/// and this window has none.
struct ResearchReportWindow: View {
    let runID: String
    let configuration: JunoDesktopConfiguration?

    @State private var run: NativeResearchRun?
    @State private var audit: NativeResearchAudit?
    @State private var failed = false
    @State private var copied = false

    private var document: ResearchReportDocument? { run.flatMap(ResearchReportDocument.init(run:)) }

    var body: some View {
        Group {
            if let document {
                ResearchReportReader(document: document, audit: audit)
            } else if failed || (run != nil && document == nil) {
                JunoEmptyState(
                    title: "Couldn\u{2019}t open this report",
                    message: "Check your connection and try again.",
                    icon: .error,
                    actionLabel: "Try Again",
                    action: { Task { await load() } },
                    size: .panel,
                    tone: .error
                )
                .padding(JunoSpace.section)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ResearchReportSkeleton()
            }
        }
        // The accent reaches the report's links and buttons, not the
        // toolbar declared below it.
        .junoAccentTint()
        .frame(minWidth: 640, minHeight: 480)
        .background(Color.junoCanvas)
        .navigationTitle(document?.title ?? "Research report")
        .navigationSubtitle(document?.subtitle ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    copy()
                } label: {
                    Label {
                        Text(copied ? "Copied" : "Copy")
                    } icon: {
                        JunoIconView(copied ? .check : .copy, size: 16)
                    }
                }
                .help("Copy")
                .disabled(document == nil)
                Button {
                    export()
                } label: {
                    Label {
                        Text("Export Markdown\u{2026}")
                    } icon: {
                        JunoIconView(.download, size: 16)
                    }
                }
                .help("Export Markdown\u{2026}")
                .disabled(document == nil)
                Button {
                    printReport()
                } label: {
                    Label {
                        Text("Print\u{2026}")
                    } icon: {
                        JunoIconView(.printer, size: 16)
                    }
                }
                .keyboardShortcut("p", modifiers: .command)
                .help("Print\u{2026}")
                .disabled(document == nil)
            }
        }
        .task(id: runID) { await load() }
        .accessibilityIdentifier("juno.research-report")
    }

    private func load() async {
        failed = false
        guard let model = configuration?.conversationModel else {
            failed = true
            return
        }
        guard let loaded = await model.loadResearchRun(id: runID) else {
            failed = true
            return
        }
        run = loaded
        if let messageID = loaded.assistantMessageID {
            audit = await model.researchAudit(messageID: messageID)
        }
    }

    // MARK: Toolbar

    private func copy() {
        guard let document else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(document.body, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func export() {
        guard let document else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = document.fileName(on: Date())
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.canCreateDirectories = true
        let text = document.markdown(accessed: Date())
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// The report laid out on paper: its words and sources at the page's
    /// width, in the light appearance, paginated by AppKit.
    private func printReport() {
        guard let document else { return }
        let info = NSPrintInfo.shared.copy() as? NSPrintInfo ?? NSPrintInfo()
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isVerticallyCentered = false
        let width = info.paperSize.width - info.leftMargin - info.rightMargin
        let host = NSHostingView(rootView: ResearchReportPrintout(document: document).frame(width: width))
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: max(1, host.fittingSize.height)))
        let operation = NSPrintOperation(view: host, printInfo: info)
        operation.jobTitle = document.title
        operation.run()
    }
}

// MARK: - The reader

/// The report at the reading measure beside its Contents, then the sources it
/// read.
///
/// **Signature detail:** the Contents column follows the reading position —
/// the section being read is in the ink, the rest in the secondary ink — and
/// a click there moves the report, not the column.
struct ResearchReportReader: View {
    let document: ResearchReportDocument
    var audit: NativeResearchAudit?

    /// The section at the top of the column, as the reader scrolls.
    @State private var reading: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameter initialSection: the section to open at — how a fixture
    ///   draws the report mid-read.
    init(document: ResearchReportDocument, audit: NativeResearchAudit? = nil, initialSection: String? = nil) {
        self.document = document
        self.audit = audit
        _reading = State(initialValue: initialSection)
    }

    private static let sourcesID = "sources"

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if document.headings.count >= 2 {
                contents
                    .frame(width: 220, alignment: .topLeading)
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
                    .accessibilityHidden(true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    ForEach(document.sections) { section in
                        // As a reply's prose: citations open on a click, so
                        // no selection here; Copy takes the whole report.
                        JunoMarkdownText(section.markdown)
                            .environment(\.junoProseStyle, .reading)
                            .foregroundStyle(Color.junoForeground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(section.id)
                    }
                    if !document.sources.isEmpty {
                        sources
                            .id(Self.sourcesID)
                    }
                }
                .scrollTargetLayout()
                .environment(\.junoCitationCount, document.sources.count)
                .environment(\.junoCitationPopover, citationPopover)
                .frame(maxWidth: DesktopChatMeasure.reading, alignment: .leading)
                .padding(.horizontal, JunoSpace.section)
                .padding(.vertical, JunoSpace.roomy)
                .frame(maxWidth: .infinity)
            }
            .scrollPosition(id: $reading, anchor: .top)
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
    }

    /// The section being read: the one at the top of the column, or the
    /// first until the reader moves.
    private var current: String? {
        guard let reading else { return document.headings.first?.id }
        if reading == Self.sourcesID { return document.headings.last?.id }
        // A lead-in before the first heading counts as the first heading.
        let index = document.sections.firstIndex { $0.id == reading } ?? 0
        return document.sections[...index].last { $0.level > 0 }?.id ?? document.headings.first?.id
    }

    private var contents: some View {
        let minLevel = document.headings.map(\.level).min() ?? 1
        return ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text("Contents")
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.bottom, JunoSpace.snug)
                ForEach(document.headings) { heading in
                    let isCurrent = heading.id == current
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                            reading = heading.id
                        }
                    } label: {
                        Text(heading.title)
                            .junoFont(size: 13, relativeTo: .callout, weight: isCurrent ? .medium : .regular)
                            .foregroundStyle(isCurrent ? Color.junoForeground : Color.junoSecondaryInk)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                            .padding(.leading, CGFloat(heading.level - minLevel) * 12)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isCurrent ? .isSelected : [])
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.roomy)
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: current)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report contents")
        .accessibilityIdentifier("juno.research-report.contents")
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Rectangle()
                .fill(Color.junoHairline)
                .frame(height: 1)
                .padding(.bottom, JunoSpace.regular)
                .accessibilityHidden(true)
            Text("Sources read \u{00B7} \(document.sources.count)")
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoForeground)
                .monospacedDigit()
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(document.sources.enumerated()), id: \.element.id) { index, source in
                SourceRow(source: NativeChatSource(title: source.title, url: source.url, snippet: ""), number: index + 1)
            }
        }
        .padding(.top, JunoSpace.section)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report sources")
    }

    /// A citation's source, and what the check found it used for.
    private var citationPopover: JunoCitationPopover {
        let sources = document.sources
        let audit = audit
        return JunoCitationPopover { number in
            guard sources.indices.contains(number - 1) else { return AnyView(EmptyView()) }
            let source = sources[number - 1]
            return AnyView(ResearchCitationPopover(
                source: NativeChatSource(title: source.title, url: source.url, snippet: ""),
                number: number,
                evidence: audit?.evidence(forSource: number) ?? []
            ))
        }
    }
}

/// A citation's popover in a report: the source, and when the citation check
/// has run, the verdict and the passage verbatim with "Open at passage",
/// which opens the page scrolled to it (a text fragment of its first eight
/// words). With no check, it is the source and "Open Page".
struct ResearchCitationPopover: View {
    let source: NativeChatSource
    let number: Int
    let evidence: [(claim: NativeResearchAudit.Claim, link: NativeResearchAudit.Link)]
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                SourceFavicon(url: source.url, size: 16, circular: false)
                Text(SourceHost.name(source.url))
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                Text(number.formatted())
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Text(SourceHost.title(source))
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .lineLimit(2)
            if let first = evidence.first {
                Text(NativeResearchAudit.verdict(first.claim.label))
                    .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(Self.tone(first.claim.label))
                    .padding(.top, JunoSpace.micro)
                if !first.link.passage.isEmpty {
                    Text("\u{201C}\(first.link.passage)\u{201D}")
                        .junoFont(size: 12, relativeTo: .footnote)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
            if let first = evidence.first, let url = Self.passageURL(source.url, passage: first.link.passage) {
                Button("Open at passage") { openURL(url) }
                    .buttonStyle(.link)
                    .contentShape(.rect)
            } else {
                Button("Open Page") { openURL(source.url) }
                    .buttonStyle(.link)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.cozy)
        .frame(width: 340, height: evidence.isEmpty ? 140 : 236, alignment: .topLeading)
    }

    /// The verdict's ink: supported in the success ink, partly or not
    /// supported in the warning ink, contradicted in the destructive ink,
    /// not checked in the secondary ink.
    static func tone(_ label: String) -> Color {
        switch label {
        case "supported": .junoSuccessInk
        case "partially supported", "unsupported": .junoWarningInk
        case "contradicted": .junoDestructiveInk
        default: .junoSecondaryInk
        }
    }

    /// The page, scrolled to the passage: `#:~:text=` and its first eight
    /// words, percent-encoded.
    static func passageURL(_ url: URL, passage: String) -> URL? {
        let words = passage.split(whereSeparator: { $0.isWhitespace }).prefix(8).joined(separator: " ")
        guard !words.isEmpty else { return nil }
        var allowed = CharacterSet.urlFragmentAllowed
        allowed.remove(charactersIn: "-,&#")
        guard let encoded = words.addingPercentEncoding(withAllowedCharacters: allowed),
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        components.fragment = nil
        guard let base = components.url?.absoluteString else { return nil }
        return URL(string: base + "#:~:text=" + encoded)
    }
}

/// The report on paper: its words and its sources, at the page's width.
private struct ResearchReportPrintout: View {
    let document: ResearchReportDocument

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoMarkdownText(document.body)
                .environment(\.junoProseStyle, .reading)
                .foregroundStyle(Color.junoForeground)
            if !document.sources.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("Sources read \u{00B7} \(document.sources.count)")
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    ForEach(Array(document.sources.enumerated()), id: \.element.id) { index, source in
                        Text("[\(index + 1)] \(source.title) \u{2014} \(source.url.absoluteString)")
                            .junoFont(size: 11, relativeTo: .caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .foregroundStyle(Color.junoForeground)
            }
        }
        .padding(.vertical, JunoSpace.regular)
        .environment(\.colorScheme, .light)
    }
}

/// The report's shape while it is read: a title bar of text and paragraphs
/// of lines, never a spinner.
private struct ResearchReportSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            RoundedRectangle(cornerRadius: JunoRadius.micro, style: .continuous)
                .fill(Color.junoMuted)
                .frame(width: 320, height: 18)
            ForEach(0..<3, id: \.self) { paragraph in
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(0..<4, id: \.self) { line in
                        RoundedRectangle(cornerRadius: JunoRadius.micro, style: .continuous)
                            .fill(Color.junoMuted)
                            .frame(maxWidth: line == 3 ? 360 : .infinity)
                            .frame(height: 10)
                    }
                }
                .padding(.top, paragraph == 0 ? JunoSpace.snug : 0)
            }
        }
        .frame(maxWidth: DesktopChatMeasure.reading, alignment: .leading)
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityLabel("Loading this report")
    }
}
