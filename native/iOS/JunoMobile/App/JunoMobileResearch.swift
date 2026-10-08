import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UIKit

// MARK: - The reader

/// A research report, opened from its card in the chat: the editorial reader
/// (`NativeResearchReportArticle`) in a full-height sheet.
///
/// The navigation bar is the system's: Done, the Contents menu that jumps to
/// a section (or the sources), and Share — the report as text, as a Markdown
/// file, or as a PDF made on the device. Citations open their source in a
/// small sheet with the passage the claim rests on, once the check has run.
/// Every size follows Dynamic Type.
struct JunoMobileResearchReportView: View {
    let report: NativeResearchReport
    /// Reads the citation check on the answer, when there is one.
    var loadAudit: ((String) async -> NativeResearchAudit?)?
    let close: () -> Void

    @State private var audit: NativeResearchAudit?
    @State private var reading: String?
    @State private var files: Files?
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct Files {
        let markdown: URL
        let pdf: URL?
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                NativeResearchReportArticle(report: report, audit: audit, compact: true, tracksScroll: true)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.top, JunoSpace.regular)
                    .padding(.bottom, JunoSpace.vast)
                    .frame(maxWidth: 680)
                    .frame(maxWidth: .infinity)
            }
            .scrollPosition(id: $reading, anchor: .top)
            .background(Color.junoCanvas)
            .navigationTitle(reading == nil ? "" : report.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: reading == nil)
        }
        .task {
            if let messageID = report.messageID, let loadAudit { audit = await loadAudit(messageID) }
        }
        .task(id: report.id) { files = await Self.files(for: report) }
        .accessibilityIdentifier("juno.mobile.research-report")
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Done", action: close)
                .accessibilityIdentifier("juno.mobile.research-report.done")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if report.headings.count >= 2 || !report.sources.isEmpty {
                Menu {
                    ForEach(report.headings) { heading in
                        Button(heading.level >= 3 ? "   " + heading.title : heading.title) { jump(to: heading.id) }
                    }
                    if !report.sources.isEmpty {
                        Divider()
                        Button("Sources") { jump(to: NativeResearchReportArticle.sourcesID) }
                    }
                } label: {
                    Label("Contents", image: JunoIcon.list.assetName(.regular))
                }
                .accessibilityIdentifier("juno.mobile.research-report.contents")
            }
            Menu {
                Button {
                    UIPasteboard.general.string = report.markdown(accessed: Date())
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy as Markdown", image: (copied ? JunoIcon.check : JunoIcon.copy).assetName(.regular))
                }
                ShareLink(item: report.markdown(accessed: Date()), subject: Text(report.title)) {
                    Label("Share as text", image: JunoIcon.writing.assetName(.regular))
                }
                if let files {
                    ShareLink(item: files.markdown) {
                        Label("Markdown file", image: JunoIcon.file.assetName(.regular))
                    }
                    if let pdf = files.pdf {
                        ShareLink(item: pdf) {
                            Label("PDF", image: JunoIcon.file.assetName(.regular))
                        }
                    }
                }
            } label: {
                Label("Share", image: JunoIcon.share.assetName(.regular))
            }
            .accessibilityIdentifier("juno.mobile.research-report.share")
        }
    }

    private func jump(to id: String) {
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            reading = id
        }
    }

    /// The report as files to hand to the share sheet: Markdown at once, the
    /// PDF drawn on the device, both in a temporary folder of their own.
    @MainActor
    static func files(for report: NativeResearchReport) async -> Files? {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("research-\(abs(report.id.hashValue))", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let markdown = folder.appendingPathComponent(report.fileName(on: Date()))
        guard (try? report.markdown(accessed: Date()).write(to: markdown, atomically: true, encoding: .utf8)) != nil
        else { return nil }
        // Let the sheet finish presenting before the PDF is laid out.
        try? await Task.sleep(for: .milliseconds(350))
        var pdf: URL?
        if let data = NativeResearchReportPDF.data(for: report) {
            let url = folder.appendingPathComponent(report.fileName(on: Date(), extension: "pdf"))
            if (try? data.write(to: url, options: .atomic)) != nil { pdf = url }
        }
        return Files(markdown: markdown, pdf: pdf)
    }
}

/// What the reader sheet is showing.
struct JunoMobileReportRoute: Identifiable {
    let report: NativeResearchReport
    var id: String { report.id }
}

// MARK: - A background run in the transcript

/// A research run the conversation holds that is not an answer in it — one
/// started on the web, or handed off — drawn where the Mac draws it: the
/// clarify gate or the plan while it waits on the reader, the Deep Field view
/// while it works, and the report's card once it has written one.
struct JunoMobileResearchRunBlock: View {
    let run: NativeResearchRun
    let model: NativeConversationModel<SQLiteAccountRepository>
    let conversationID: String
    let openReport: (NativeResearchReport) -> Void

    @State private var confirmingStop = false

    var body: some View {
        Group {
            switch run.phase {
            case .awaitingClarification:
                JunoMobileResearchGate(
                    run: run, busy: model.researchBusyRunIDs.contains(run.id), error: model.researchErrors[run.id],
                    clarify: { answers in Task { await model.clarifyResearch(runID: run.id, answers: answers, conversationID: conversationID) } },
                    decide: nil
                )
            case .awaitingStart:
                JunoMobileResearchGate(
                    run: run, busy: model.researchBusyRunIDs.contains(run.id), error: model.researchErrors[run.id],
                    clarify: nil,
                    decide: { start in Task { await model.decideResearchPlan(runID: run.id, start: start, conversationID: conversationID) } }
                )
            case _ where run.phase.isTerminal:
                if let report = NativeResearchReport(run: run) {
                    NativeResearchReportCard(
                        content: .report(report),
                        verdict: run.state == "completed" ? nil : NativeResearchRun.stateSentence(run.state),
                        verdictIsWarning: run.state != "completed" && run.state != "cancelled",
                        open: { openReport(report) }
                    )
                } else {
                    stoppedLine
                }
            default:
                NativeResearchLiveView(
                    run: run,
                    actions: actions,
                    busy: model.researchBusyRunIDs.contains(run.id),
                    error: model.researchErrors[run.id],
                    unreachable: model.researchUnreachableRunIDs.contains(run.id),
                    compact: true
                )
            }
        }
        .confirmationDialog("Stop this research?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop research", role: .destructive) { control(.cancel) }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("It stops now and nothing more is spent. What it found so far stays.")
        }
    }

    private var actions: NativeResearchLiveActions {
        NativeResearchLiveActions(
            stop: { confirmingStop = true },
            pause: { control(.pause) },
            resume: { control(.resume) },
            finish: run.derivesPhase && !model.researchFinishUnsupported ? { control(.finish) } : nil,
            guide: { text in
                let result = await model.steerResearch(runID: run.id, input: text, conversationID: conversationID)
                return result.accepted ? nil : (result.notice ?? "That guidance could not be added. Try again.")
            },
            retry: { Task { await model.refreshResearchRun(id: run.id, conversationID: conversationID) } }
        )
    }

    private func control(_ action: NativeResearchControl) {
        Task { await model.controlResearch(runID: run.id, action: action, conversationID: conversationID) }
    }

    private var stoppedLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            if run.phase == .failed {
                JunoIconView(.warning, size: 12)
                    .foregroundStyle(Color.junoWarningInk)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(run.phase == .failed ? (run.error ?? "Research couldn\u{2019}t finish") : "Research stopped before it wrote a report")
                    .foregroundStyle(run.phase == .failed ? Color.junoWarningInk : Color.junoSecondaryInk)
                Text(run.displayTitle)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(2)
            }
            .junoFont(size: 14, relativeTo: .callout)
        }
        .padding(.vertical, JunoSpace.snug)
        .accessibilityElement(children: .combine)
    }
}

/// A run waiting on the reader before it starts: what the question left open
/// (answer any, or skip and research as written), or the plan (start it, or
/// cancel). Neither answer is ever disabled for being empty.
private struct JunoMobileResearchGate: View {
    let run: NativeResearchRun
    let busy: Bool
    let error: String?
    var clarify: (([String: String]) -> Void)?
    var decide: ((Bool) -> Void)?

    @State private var answers: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text(clarify != nil ? "Before research starts" : "Research plan")
                .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(run.displayTitle.isEmpty ? "Deep research" : run.displayTitle)
                .font(JunoSerif.font(size: 23, relativeTo: .title2))
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if clarify != nil {
                Text("A few details would sharpen this. Answer what you can \u{2014} anything you skip, Alevr decides for itself.")
                    .junoFont(size: 14, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(run.clarifications) { question in
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        Text(question.question)
                            .junoFont(size: 15, relativeTo: .body, weight: .medium)
                            .foregroundStyle(Color.junoForeground)
                        if let why = question.why {
                            Text(why)
                                .junoFont(size: 13, relativeTo: .footnote)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        TextField(
                            question.question,
                            text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }),
                            prompt: Text(question.suggestions.first.map { "e.g. \($0)" } ?? (question.skippable ? "Optional" : "Needed"))
                        )
                        .textFieldStyle(.plain)
                        .junoFont(size: 15, relativeTo: .body)
                        .padding(JunoSpace.cozy)
                        .frame(minHeight: 44)
                        .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                    }
                }
            } else {
                if let approach = run.approach {
                    Text(approach)
                        .junoFont(size: 15, relativeTo: .body)
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(run.questions) { question in
                    NativeResearchQuestionRow(question: .init(id: question.id, question: question.question, status: "pending"))
                }
                if let estimate = run.estimateLine {
                    Text(estimate.text)
                        .junoFont(size: 13, relativeTo: .footnote)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            if let error {
                Label {
                    Text(error)
                } icon: {
                    JunoIconView(.warning, size: 12)
                }
                .junoFont(size: 13, relativeTo: .footnote)
                .foregroundStyle(Color.junoWarningInk)
            }
            HStack(spacing: JunoSpace.snug) {
                if let clarify {
                    Button("Start researching") {
                        clarify(answers.compactMapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 })
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Color.junoAccent)
                    .contentShape(.rect)
                    Button("Skip") { clarify([:]) }
                        .buttonStyle(.glass)
                        .contentShape(.rect)
                } else if let decide {
                    Button("Start research") { decide(true) }
                        .buttonStyle(.glassProminent)
                        .tint(Color.junoAccent)
                        .contentShape(.rect)
                    Button("Cancel") { decide(false) }
                        .buttonStyle(.glass)
                        .contentShape(.rect)
                }
            }
            .controlSize(.large)
            .disabled(busy || run.revising)
        }
        .padding(.vertical, JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }
}
