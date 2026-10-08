import Foundation
import JunoDesignSystem
import SwiftUI

// MARK: - The report card in the chat

/// The door into a research report, where the answer carries one (in place of
/// the generic artifact card) and where a finished run is recapped.
///
/// An opaque card under a hairline: what it is and how long it takes to read,
/// the report's title in Newsreader, the first of its sections as a small
/// table of contents, the sites it rests on, and "Read report" in the accent's
/// ink — the card's one accent. The whole card is the button.
///
/// While the report is still being written it says so in words — the section
/// being written and the words so far — and does not open.
public struct NativeResearchReportCard: View {
    public enum Content: Equatable {
        case report(NativeResearchReport)
        /// Still being written: the title so far, the words so far, and the
        /// heading being written.
        case writing(title: String, words: Int, section: String?)
    }

    let content: Content
    /// Above the title, when there is more to say than "Research report" —
    /// a recap's verdict ("Stopped early with what it had").
    var verdict: String?
    var verdictIsWarning: Bool
    var open: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    public init(content: Content, verdict: String? = nil, verdictIsWarning: Bool = false, open: (() -> Void)?) {
        self.content = content
        self.verdict = verdict
        self.verdictIsWarning = verdictIsWarning
        self.open = open
    }

    public var body: some View {
        Group {
            if let open, case .report = content {
                Button(action: open) { card }
                    .buttonStyle(.plain)
                    .contentShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
                    .onHover { hovered = $0 }
                    .accessibilityHint("Opens the report")
            } else {
                card
            }
        }
        .accessibilityIdentifier("juno.research.report-card")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            eyebrow
            switch content {
            case .report(let report):
                Text(report.title)
                    .font(JunoSerif.font(size: 24, relativeTo: .title2))
                    .foregroundStyle(Color.junoForeground)
                    .lineSpacing(1)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !report.headings.isEmpty {
                    contents(report)
                }
                footer(report)
            case .writing(let title, let words, let section):
                Text(title.isEmpty ? "Research report" : title)
                    .font(JunoSerif.font(size: 24, relativeTo: .title2))
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(section.map { "Writing \u{201C}\($0)\u{201D}" } ?? "Writing the report")
                        .lineLimit(1)
                        .id(section ?? "")
                        .transition(.opacity)
                    Spacer(minLength: JunoSpace.snug)
                    Text("\(words.formatted()) words")
                        .monospacedDigit()
                        .contentTransition(.numericText(value: Double(words)))
                        .fixedSize()
                }
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: section)
            }
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(hovered ? Color.junoHover : Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
    }

    private var eyebrow: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            if let verdict {
                if verdictIsWarning {
                    JunoIconView(.warning, size: 11)
                        .foregroundStyle(Color.junoWarningInk)
                        .accessibilityHidden(true)
                }
                Text(verdict)
                    .foregroundStyle(verdictIsWarning ? Color.junoWarningInk : Color.junoSecondaryInk)
            } else {
                Text("Research report")
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: JunoSpace.snug)
            if case .report(let report) = content {
                Text("\(report.minutes) min read")
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize()
            }
        }
        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
    }

    private func contents(_ report: NativeResearchReport) -> some View {
        let top = report.headings.filter { $0.level <= (report.headings.map(\.level).min() ?? 1) }
        let shown = (top.count >= 2 ? top : report.headings).prefix(4)
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, heading in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text((index + 1).formatted())
                        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: 14, alignment: .trailing)
                    Text(heading.title)
                        .junoFont(size: 14, relativeTo: .callout)
                        .foregroundStyle(Color.junoForeground.opacity(0.82))
                        .lineLimit(1)
                }
            }
            if report.headings.count > shown.count, top.count < 2 || top.count > shown.count {
                Text("and \((top.count >= 2 ? top.count : report.headings.count) - shown.count) more")
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.leading, 22)
            }
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Contents: " + shown.map(\.title).joined(separator: ", "))
    }

    private func footer(_ report: NativeResearchReport) -> some View {
        HStack(spacing: JunoSpace.snug) {
            if !report.sources.isEmpty {
                NativeSourceIconStack(sources: report.sources.map(\.url), size: 18)
                let sources = "\(report.sources.count) \(report.sources.count == 1 ? "source" : "sources")"
                ViewThatFits(in: .horizontal) {
                    Text("\(sources) \u{00B7} \(report.words.formatted()) words").fixedSize()
                    Text(sources).fixedSize()
                }
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: JunoSpace.snug)
            if open != nil {
                HStack(spacing: JunoSpace.tight) {
                    Text("Read report")
                    JunoIconView(.arrowRight, size: 12)
                }
                .junoFont(size: 14, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoAccentInk)
                .fixedSize()
            }
        }
        .padding(.top, JunoSpace.tight)
    }
}

// MARK: - The article

/// A research report set for reading — shared by the Mac's report window, the
/// phone's reader and the PDF.
///
/// The cover: a mono line (what, when), the title in Newsreader at display
/// size, the question when it differs, the meta line, the answer's own short
/// prose as the dek, and the citation check in words. Then every section under
/// a Newsreader heading, the body in the reading style (16pt on 1.7, a 75ch
/// measure, tables and code as cards), citations that open their source, and
/// the numbered sources.
public struct NativeResearchReportArticle: View {
    public static let sourcesID = "sources"

    let report: NativeResearchReport
    var audit: NativeResearchAudit?
    var compact: Bool
    /// For paper: no interactive citations, every link plain.
    var printing: Bool
    /// The sections are the enclosing scroll view's targets, so its
    /// `scrollPosition(id:)` follows the section being read.
    var tracksScroll: Bool

    public init(
        report: NativeResearchReport,
        audit: NativeResearchAudit? = nil,
        compact: Bool = false,
        printing: Bool = false,
        tracksScroll: Bool = false
    ) {
        self.report = report
        self.audit = audit
        self.compact = compact
        self.printing = printing
        self.tracksScroll = tracksScroll
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NativeResearchReportCover(report: report, audit: audit, compact: compact)
            ForEach(Array(report.sections.enumerated()), id: \.element.id) { index, section in
                NativeResearchReportSectionView(section: section, compact: compact, first: index == 0)
                    .id(section.id)
            }
            if !report.sources.isEmpty {
                NativeResearchReportSources(sources: report.sources, compact: compact, printing: printing)
                    .id(Self.sourcesID)
            }
        }
        .modifier(ScrollTargets(enabled: tracksScroll))
        .environment(\.junoProseStyle, .reading)
        .environment(\.junoCitationCount, report.citationCount)
        .environment(\.junoCitationPopover, printing || report.citationCount == 0 ? nil : citationPopover)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var citationPopover: JunoCitationPopover {
        let sources = report.sources
        let audit = audit
        return JunoCitationPopover { number in
            guard sources.indices.contains(number - 1) else { return AnyView(EmptyView()) }
            return AnyView(NativeResearchCitationCard(
                source: sources[number - 1],
                number: number,
                evidence: audit?.evidence(forSource: number) ?? []
            ))
        }
    }
}

private struct ScrollTargets: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled { content.scrollTargetLayout() } else { content }
    }
}

public struct NativeResearchReportCover: View {
    let report: NativeResearchReport
    var audit: NativeResearchAudit?
    var compact: Bool

    public init(report: NativeResearchReport, audit: NativeResearchAudit? = nil, compact: Bool = false) {
        self.report = report
        self.audit = audit
        self.compact = compact
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: compact ? JunoSpace.cozy : JunoSpace.regular) {
            Text(eyebrow)
                .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(report.title)
                .font(JunoSerif.font(size: compact ? 32 : 42, relativeTo: .largeTitle))
                .foregroundStyle(Color.junoForeground)
                .lineSpacing(compact ? 1 : 2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let question = report.question {
                Text(question)
                    .font(JunoSerif.font(size: compact ? 17 : 19, relativeTo: .title3, face: .italic))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(report.metaLine)
                .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
                .monospacedDigit()
            if let lede = report.lede {
                JunoMarkdownText(lede)
                    .foregroundStyle(Color.junoForeground)
                    .padding(.top, JunoSpace.snug)
            }
            if let line = auditLine {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    JunoIconView(line.clean ? .shield : .warning, size: 12)
                        .foregroundStyle(line.clean ? Color.junoSecondaryInk : Color.junoWarningInk)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.headline)
                            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                            .foregroundStyle(Color.junoForeground)
                            .monospacedDigit()
                        Text("Checked against the passages each claim cites; completeness is not verified.")
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, JunoSpace.snug)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.bottom, compact ? JunoSpace.roomy : JunoSpace.region)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .padding(.bottom, JunoSpace.snug)
        .accessibilityIdentifier("juno.research-report.cover")
    }

    private var eyebrow: String {
        var parts = ["Deep research"]
        if let finished = report.finishedAt {
            parts.append(finished.formatted(.dateTime.month(.abbreviated).day().year()))
        }
        if let pages = report.pagesRead, pages > 0 {
            parts.append("\(pages) \(pages == 1 ? "page" : "pages") read")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The check's verdict in words, from the per-claim audit when it was
    /// read, else the run's totals; nil when there is neither.
    private var auditLine: (headline: String, clean: Bool)? {
        if let audit, !audit.claims.isEmpty {
            let count = { (label: String) in audit.claims.filter { $0.label == label }.count }
            let summary = NativeResearchRun.AuditSummary(
                claims: audit.claims.count, supported: count("supported"),
                partiallySupported: count("partially supported"), unsupported: count("unsupported"),
                contradicted: count("contradicted"), unverified: count("unverified")
            )
            return (summary.headline, summary.isClean)
        }
        if let summary = report.auditSummary, summary.claims > 0 { return (summary.headline, summary.isClean) }
        return nil
    }
}

/// One section: its heading in Newsreader, its body in the reading style.
public struct NativeResearchReportSectionView: View {
    let section: NativeResearchReport.Section
    var compact: Bool
    var first: Bool

    public init(section: NativeResearchReport.Section, compact: Bool = false, first: Bool = false) {
        self.section = section
        self.compact = compact
        self.first = first
    }

    private var headingSize: CGFloat {
        switch section.level {
        case 1: compact ? 26 : 30
        case 2: compact ? 24 : 27
        default: compact ? 20 : 21
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: section.level >= 3 ? JunoSpace.snug : JunoSpace.cozy) {
            if section.level > 0 {
                Text(section.title)
                    .font(JunoSerif.font(size: headingSize, relativeTo: section.level >= 3 ? .title3 : .title2))
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            if !section.markdown.isEmpty {
                JunoMarkdownText(section.markdown)
                    .foregroundStyle(Color.junoForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.top, first && section.level == 0 ? JunoSpace.roomy
            : section.level >= 3 ? JunoSpace.roomy : (compact ? JunoSpace.region : JunoSpace.vast))
    }
}

/// The numbered sources, as the report's `[n]` count them.
public struct NativeResearchReportSources: View {
    let sources: [NativeChatSource]
    var compact: Bool
    var printing: Bool

    @Environment(\.openURL) private var openURL

    public init(sources: [NativeChatSource], compact: Bool = false, printing: Bool = false) {
        self.sources = sources
        self.compact = compact
        self.printing = printing
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Sources")
                    .font(JunoSerif.font(size: compact ? 24 : 27, relativeTo: .title2))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(sources.count.formatted())
                    .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.bottom, JunoSpace.cozy)
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                row(source, number: index + 1)
                    .overlay(alignment: .top) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
            }
        }
        .padding(.top, compact ? JunoSpace.region : JunoSpace.vast)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report sources")
    }

    @ViewBuilder
    private func row(_ source: NativeChatSource, number: Int) -> some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
            Text(number.formatted())
                .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 22, alignment: .trailing)
            NativeSourceIcon(url: source.url, size: 16)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            VStack(alignment: .leading, spacing: 2) {
                Text(NativeResearchReport.displayTitle(source))
                    .junoFont(size: 15, relativeTo: .body)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(printing ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(printing && NativePrivateSourceKind.of(source.url) == nil ? source.url.absoluteString : NativeResearchReport.host(source.url))
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(printing ? nil : 1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.cozy)
        .frame(minHeight: 44)
        .contentShape(.rect)
        if printing {
            label
        } else if NativePrivateSourceKind.of(source.url) != nil {
            // One of the person's own sources: nothing to open.
            label
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Source \(number): \(NativeResearchReport.displayTitle(source)), \(NativeResearchReport.host(source.url))")
        } else {
            Button { openURL(source.url) } label: { label }
                .buttonStyle(.plain)
                .contentShape(.rect)
                .help(source.url.absoluteString)
                .accessibilityLabel("Source \(number): \(NativeResearchReport.displayTitle(source)), \(NativeResearchReport.host(source.url))")
        }
    }
}

// MARK: - A citation

/// What a citation opens in a report: the source, and when the citation check
/// has run, the verdict in words and the passage verbatim, with "Open at
/// passage" (a text fragment of its first eight words). With no check, the
/// source and "Open page".
public struct NativeResearchCitationCard: View {
    let source: NativeChatSource
    let number: Int
    let evidence: [(claim: NativeResearchAudit.Claim, link: NativeResearchAudit.Link)]
    @Environment(\.openURL) private var openURL

    public init(source: NativeChatSource, number: Int, evidence: [(claim: NativeResearchAudit.Claim, link: NativeResearchAudit.Link)]) {
        self.source = source
        self.number = number
        self.evidence = evidence
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.snug) {
                NativeSourceIcon(url: source.url, size: 16)
                Text(NativeResearchReport.host(source.url))
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                Text(number.formatted())
                    .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Text(NativeResearchReport.displayTitle(source))
                .font(JunoSerif.font(size: 18, relativeTo: .headline))
                .foregroundStyle(Color.junoForeground)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            if let first = evidence.first {
                Text(NativeResearchAudit.verdict(first.claim.label))
                    .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(Self.tone(first.claim.label))
                if !first.link.passage.isEmpty {
                    Text("\u{201C}\(first.link.passage)\u{201D}")
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoForeground.opacity(0.85))
                        .lineLimit(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            } else if !source.snippet.isEmpty {
                Text(source.snippet)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                if let first = evidence.first, let url = Self.passageURL(source.url, passage: first.link.passage) {
                    openURL(url)
                } else {
                    openURL(source.url)
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    Text(evidence.first.map { _ in "Open at passage" } ?? "Open page")
                    JunoIconView(.external, size: 11)
                }
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoAccentInk)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.top, JunoSpace.micro)
        }
        .padding(JunoSpace.regular)
        #if os(macOS)
        .frame(width: 340, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .presentationDetents([.height(evidence.isEmpty ? 220 : 320), .medium])
        .presentationDragIndicator(.visible)
        #endif
    }

    /// The verdict's ink: supported in the success ink, partly or not
    /// supported in the warning ink, contradicted in the destructive ink, not
    /// checked in the secondary ink — always beside the verdict's words.
    public static func tone(_ label: String) -> Color {
        switch label {
        case "supported": .junoSuccessInk
        case "partially supported", "unsupported": .junoWarningInk
        case "contradicted": .junoDestructiveInk
        default: .junoSecondaryInk
        }
    }

    /// The page, scrolled to the passage: `#:~:text=` and its first eight
    /// words, percent-encoded.
    public static func passageURL(_ url: URL, passage: String) -> URL? {
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
