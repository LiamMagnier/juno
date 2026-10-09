import AppKit
import JunoChatKit
import JunoDesignSystem
import SwiftUI
import UniformTypeIdentifiers
#if DEBUG
import JunoPreviewSupport
#endif

// MARK: - The window

/// A research report in its own window (register #65; the web opens a
/// full-screen reader). Opened by id: `message:<id>` for a report the chat
/// answer carries (today's path for an app), a run id for a web background
/// run's report.
///
/// The window's title is the report's, its subtitle what it is — words,
/// reading time, sources. Copy, Share, Export (Markdown or PDF) and Print in
/// the toolbar, declared once. A plain `HStack` — one `NavigationSplitView`
/// per window, and this window has none.
/// How the report is hosted: in the main window's trailing panel (the
/// default, as the website's research panel is), or — only when the reader
/// asks for it — in a window of its own.
struct ResearchReportPanelChrome {
    let close: () -> Void
    let openInWindow: () -> Void
    @Binding var isFullscreen: Bool
}

struct ResearchReportWindow: View {
    let runID: String
    let configuration: JunoDesktopConfiguration?
    /// Set when the report is the conversation's trailing panel: a header
    /// row of its own instead of the window's toolbar.
    var panel: ResearchReportPanelChrome? = nil

    @State private var loadedRun: NativeResearchRun?
    @State private var audit: NativeResearchAudit?
    @State private var failed = false
    @State private var copied = false
    @State private var favicons = NativeSourceFavicons()

    private var messageID: String? {
        runID.hasPrefix("message:") ? String(runID.dropFirst("message:".count)) : nil
    }

    /// The report, read live from the store for an answer (so a window
    /// restored before the conversation loads fills in when it does), or
    /// from the run read once.
    private var report: NativeResearchReport? {
        #if DEBUG
        // The capture harness's report (`--juno-preview-research-report`).
        if runID == Self.previewRunID, JunoPreviewEnvironment.isActive { return Self.previewReport }
        #endif
        if let messageID {
            guard let model = configuration?.conversationModel else { return nil }
            for messages in model.messagesByConversation.values {
                guard let index = messages.firstIndex(where: { $0.id == messageID }) else { continue }
                let question = messages[..<index].last { $0.role == .user }
                    .map { NativeMessageContent.plainText(of: $0.content) }
                return NativeResearchReport(message: messages[index], question: question)
            }
            return nil
        }
        return loadedRun.flatMap(NativeResearchReport.init(run:))
    }

    var body: some View {
        let report = report
        if let panel {
            article(report)
                .safeAreaInset(edge: .top, spacing: 0) { panelHeader(report, panel: panel) }
                .task(id: runID) { await load() }
                .accessibilityIdentifier("juno.research-report")
        } else {
            article(report)
                .frame(minWidth: 640, minHeight: 480)
                .navigationTitle(report?.title ?? "Research report")
                .navigationSubtitle(report.map(Self.subtitle) ?? "")
                .toolbar { toolbar(report) }
                .task(id: runID) { await load() }
                .accessibilityIdentifier("juno.research-report")
        }
    }

    /// The panel's header (the web's research panel): the report's title and
    /// facts, then Copy, Share, Export, Print, Full screen, Open in a new
    /// window and Close — the website's glyphs, 28pt targets.
    private func panelHeader(_ report: NativeResearchReport?, panel: ResearchReportPanelChrome) -> some View {
        HStack(spacing: JunoSpace.tight) {
            VStack(alignment: .leading, spacing: 1) {
                Text(report?.title ?? "Research report")
                    .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                if let report {
                    Text(Self.subtitle(report))
                        .junoFont(size: 11, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: JunoSpace.snug)
            DesktopPanelIconButton(icon: copied ? .check : .copy, help: "Copy the report as Markdown") { copy(report) }
                .disabled(report == nil)
            if let report {
                ShareLink(item: report.markdown(accessed: Date()), subject: Text(report.title)) {
                    DesktopPanelIconFace(icon: .share)
                }
                .buttonStyle(.plain)
                .help("Share the report")
            }
            Menu {
                Button("Markdown\u{2026}") { exportMarkdown(report) }
                Button("PDF\u{2026}") { exportPDF(report) }
                Button("Print\u{2026}") { printReport(report) }
            } label: {
                DesktopPanelIconFace(icon: .download)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Export the report")
            .disabled(report == nil)
            DesktopPanelIconButton(
                icon: panel.isFullscreen ? .columns : .maximize,
                help: panel.isFullscreen ? "Show the conversation" : "Read full screen"
            ) {
                panel.isFullscreen.toggle()
            }
            DesktopPanelIconButton(icon: .appWindow, help: "Open in a new window", action: panel.openInWindow)
            DesktopPanelIconButton(icon: .close, help: "Close", action: panel.close)
                .keyboardShortcut(.cancelAction)
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.tight)
        .frame(height: 52)
        .background(.bar)
    }

    @ViewBuilder
    private func article(_ report: NativeResearchReport?) -> some View {
        Group {
            if let report {
                #if DEBUG
                ResearchReportReader(
                    report: report, audit: audit, initialSection: Self.previewSection,
                    showsContents: panel == nil || panel?.isFullscreen == true
                )
                #else
                ResearchReportReader(report: report, audit: audit, showsContents: panel == nil || panel?.isFullscreen == true)
                #endif
            } else if failed || (loadedRun != nil && report == nil) {
                JunoEmptyState(
                    title: "Couldn\u{2019}t open this report",
                    message: messageID == nil
                        ? "Check your connection and try again."
                        : "Open the conversation it belongs to, then try again.",
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
        .environment(\.nativeSourceFavicons, favicons)
        .background(Color.junoCanvas)
    }

    /// "Research report · 2,140 words · 10 min read · 18 sources".
    static func subtitle(_ report: NativeResearchReport) -> String {
        "Research report \u{00B7} " + report.metaLine
    }

    @ToolbarContentBuilder
    private func toolbar(_ report: NativeResearchReport?) -> some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                copy(report)
            } label: {
                Label {
                    Text(copied ? "Copied" : "Copy")
                } icon: {
                    JunoIconView(copied ? .check : .copy, size: 16)
                }
            }
            .help("Copy the report as Markdown")
            .disabled(report == nil)
            if let report {
                ShareLink(item: report.markdown(accessed: Date()), subject: Text(report.title)) {
                    Label {
                        Text("Share")
                    } icon: {
                        JunoIconView(.share, size: 16)
                    }
                }
                .help("Share the report")
            }
            Menu {
                Button("Markdown\u{2026}") { exportMarkdown(report) }
                Button("PDF\u{2026}") { exportPDF(report) }
            } label: {
                Label {
                    Text("Export")
                } icon: {
                    JunoIconView(.download, size: 16)
                }
            }
            .help("Export the report")
            .disabled(report == nil)
            Button {
                printReport(report)
            } label: {
                Label {
                    Text("Print\u{2026}")
                } icon: {
                    JunoIconView(.printer, size: 16)
                }
            }
            .keyboardShortcut("p", modifiers: .command)
            .help("Print\u{2026}")
            .disabled(report == nil)
        }
    }

    #if DEBUG
    static let previewRunID = "preview-report"

    /// The harness's report, with the reader's own sources beside the web's:
    /// a file from the chat, a library document and a calendar event, on the
    /// reserved `private.invalid` host the report lists as private.
    static var previewReport: NativeResearchReport {
        var message = PreviewResearch.reportMessage()
        message.sources += [
            NativeChatSource(title: "Leeds house survey.pdf", url: URL(string: "https://private.invalid/file/survey")!, snippet: "", cited: true, origin: "research"),
            NativeChatSource(title: "Energy bills 2025.xlsx", url: URL(string: "https://private.invalid/library/bills")!, snippet: "", cited: true, origin: "research"),
            NativeChatSource(title: "Installer visit, 14 October", url: URL(string: "https://private.invalid/calendar/visit")!, snippet: "", cited: true, origin: "research"),
        ]
        return NativeResearchReport(message: message, question: PreviewResearch.question) ?? PreviewResearch.report
    }

    private static var previewSection: String? {
        CommandLine.arguments.contains("--juno-preview-report-sources") ? NativeResearchReportArticle.sourcesID : nil
    }
    #endif

    private func load() async {
        failed = false
        #if DEBUG
        if runID == Self.previewRunID, JunoPreviewEnvironment.isActive {
            audit = PreviewResearch.audit
            return
        }
        #endif
        guard let model = configuration?.conversationModel else {
            failed = true
            return
        }
        if let messageID {
            audit = await model.researchAudit(messageID: messageID)
            return
        }
        guard let loaded = await model.loadResearchRun(id: runID) else {
            failed = true
            return
        }
        loadedRun = loaded
        if let messageID = loaded.assistantMessageID {
            audit = await model.researchAudit(messageID: messageID)
        }
    }

    // MARK: Toolbar

    private func copy(_ report: NativeResearchReport?) {
        guard let report else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(report.markdown(accessed: Date()), forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func exportMarkdown(_ report: NativeResearchReport?) {
        guard let report else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = report.fileName(on: Date())
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.canCreateDirectories = true
        let text = report.markdown(accessed: Date())
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func exportPDF(_ report: NativeResearchReport?) {
        guard let report, let data = NativeResearchReportPDF.data(for: report) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = report.fileName(on: Date(), extension: "pdf")
        panel.allowedContentTypes = [.pdf]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    /// The report laid out on paper: its words and sources at the page's
    /// width, in the light appearance, paginated by AppKit.
    private func printReport(_ report: NativeResearchReport?) {
        guard let report else { return }
        let info = NSPrintInfo.shared.copy() as? NSPrintInfo ?? NSPrintInfo()
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isVerticallyCentered = false
        let width = info.paperSize.width - info.leftMargin - info.rightMargin
        let host = NSHostingView(rootView: ResearchReportPrintout(report: report).frame(width: width))
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: max(1, host.fittingSize.height)))
        let operation = NSPrintOperation(view: host, printInfo: info)
        operation.jobTitle = report.title
        operation.run()
    }
}

// MARK: - The reader

/// The report at the reading measure beside its Contents.
///
/// **Signature detail:** the Contents column follows the reading position —
/// the section being read is in the ink with a hairline beside it, the rest in
/// the secondary ink — and a click there moves the report, not the column.
struct ResearchReportReader: View {
    let report: NativeResearchReport
    var audit: NativeResearchAudit?

    /// The section at the top of the column, as the reader scrolls.
    @State private var reading: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameter initialSection: the section to open at — how a fixture
    ///   draws the report mid-read.
    init(
        report: NativeResearchReport,
        audit: NativeResearchAudit? = nil,
        initialSection: String? = nil,
        showsContents: Bool = true
    ) {
        self.report = report
        self.audit = audit
        self.initialSection = initialSection
        self.showsContents = showsContents
        _reading = State(initialValue: initialSection)
    }

    private let initialSection: String?
    /// The contents column: in a window and full screen, not in a side panel
    /// too narrow to share with it.
    private let showsContents: Bool

    /// The article's measure: the reading column, a touch narrower than the
    /// transcript so a line of Newsreader-led prose stays comfortable.
    static let measure: CGFloat = 700

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if showsContents, report.headings.count >= 2 {
                contents
                    .frame(width: 232, alignment: .topLeading)
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
                    .accessibilityHidden(true)
            }
            ScrollView {
                NativeResearchReportArticle(report: report, audit: audit, tracksScroll: true)
                    .frame(maxWidth: Self.measure, alignment: .leading)
                    .padding(.horizontal, JunoSpace.region)
                    .padding(.top, JunoSpace.region)
                    .padding(.bottom, JunoSpace.vast)
                    .frame(maxWidth: .infinity)
            }
            .scrollPosition(id: $reading, anchor: .top)
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
        // A position asked for before the article had laid out is not
        // honoured; ask again once it has.
        .task {
            guard let initialSection else { return }
            try? await Task.sleep(for: .milliseconds(800))
            reading = nil
            await Task.yield()
            reading = initialSection
        }
    }

    /// The section being read: the one at the top of the column, or the
    /// first until the reader moves.
    private var current: String? {
        guard let reading else { return report.headings.first?.id }
        if reading == NativeResearchReportArticle.sourcesID { return NativeResearchReportArticle.sourcesID }
        let index = report.sections.firstIndex { $0.id == reading } ?? 0
        return report.sections[...index].last { $0.level > 0 }?.id ?? report.headings.first?.id
    }

    private var contents: some View {
        let minLevel = report.headings.map(\.level).min() ?? 1
        return ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text("Contents")
                    .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.bottom, JunoSpace.snug)
                ForEach(report.headings) { heading in
                    entry(heading.title, id: heading.id, indent: CGFloat(heading.level - minLevel) * 12)
                }
                if !report.sources.isEmpty {
                    entry("Sources", id: NativeResearchReportArticle.sourcesID, indent: 0)
                        .padding(.top, JunoSpace.snug)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.region)
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: current)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report contents")
        .accessibilityIdentifier("juno.research-report.contents")
    }

    private func entry(_ title: String, id: String, indent: CGFloat) -> some View {
        let isCurrent = id == current
        return Button {
            withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                reading = id
            }
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Rectangle()
                    .fill(isCurrent ? Color.junoForeground : Color.clear)
                    .frame(width: 1.5, height: 16)
                Text(title)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(isCurrent ? Color.junoForeground : Color.junoSecondaryInk)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .padding(.leading, indent)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}

/// The report on paper: the article at the page's width, without its
/// interactive citations.
private struct ResearchReportPrintout: View {
    let report: NativeResearchReport

    var body: some View {
        NativeResearchReportArticle(report: report, compact: true, printing: true)
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
        .frame(maxWidth: ResearchReportReader.measure, alignment: .leading)
        .padding(JunoSpace.section)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityLabel("Loading this report")
    }
}

// MARK: - Panel controls

/// A trailing panel's icon control: a website glyph in a 28pt target, muted
/// at rest, the foreground under the pointer over the neutral hover fill.
struct DesktopPanelIconButton: View {
    let icon: JunoIcon
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            DesktopPanelIconFace(icon: icon)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct DesktopPanelIconFace: View {
    let icon: JunoIcon
    @State private var hovered = false

    var body: some View {
        JunoIconView(icon, size: 16)
            .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hovered ? Color.junoHover : .clear))
            .contentShape(.rect)
            .onHover { hovered = $0 }
            .animation(JunoMotion.fast, value: hovered)
    }
}
