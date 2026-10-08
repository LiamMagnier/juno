import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - The transcript row

/// A research run in the transcript: while it works, the Deep Field working
/// view (`NativeResearchLiveView`) — the phase in words, the clock, the
/// question, the field of real sources beside the questions, the figures, the
/// newest pages, and the controls the server takes. Once it has finished and
/// stays as a row (a run seen working whose report is its completion message),
/// one settled line with the way into the report.
struct DesktopResearchRow: View {
    let run: NativeResearchRun
    var ownsLoop = true
    /// The answer's numbered sources and the text being written (in-chat), so
    /// sources move inward as the report cites them.
    var citations: [NativeChatSource]? = nil
    var citingText: String? = nil
    var actions = NativeResearchLiveActions()
    var busy = false
    var error: String? = nil
    var unreachable = false
    let open: () -> Void

    @Environment(\.junoSnapshotRunElapsed) private var snapshotElapsed

    var body: some View {
        Group {
            if run.phase.isTerminal {
                settled
            } else {
                NativeResearchLiveView(
                    run: run,
                    citations: citations,
                    citingText: citingText,
                    actions: withDetails,
                    busy: busy,
                    error: error,
                    unreachable: unreachable,
                    frozenElapsed: snapshotElapsed
                )
            }
        }
        .accessibilityIdentifier("juno.chat.research-cover")
    }

    private var withDetails: NativeResearchLiveActions {
        var actions = actions
        if actions.details == nil { actions.details = open }
        return actions
    }

    /// A finished run that stays as a row: how it ended, in words, and the
    /// door into what it wrote.
    private var settled: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.snug) {
                if run.phase == .failed {
                    JunoIconView(.warning, size: 12)
                        .foregroundStyle(Color.junoWarningInk)
                        .accessibilityHidden(true)
                }
                Text(run.phase == .done ? "Research finished" : run.phaseLine.text)
                    .foregroundStyle(run.phase == .failed ? Color.junoWarningInk : Color.junoSecondaryInk)
                Text(run.displayTitle)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: JunoSpace.snug)
                if run.phase == .done {
                    Text("Read report")
                        .foregroundStyle(Color.junoAccentInk)
                        .fixedSize()
                    JunoIconView(.arrowRight, size: 11)
                        .foregroundStyle(Color.junoAccentInk)
                }
            }
            .junoFont(size: 13, relativeTo: .callout)
            .frame(minHeight: DesktopRunLine.height)
            .contentShape(.rect)
        }
        .buttonStyle(DesktopRunLineButtonStyle())
        .accessibilityHint("Opens the research")
    }
}

/// Only counts supplied by the run or observed source records. An old server
/// without cited counts never gets a fabricated citation total.
struct ResearchEvidenceLedger: View {
    let run: NativeResearchRun

    var body: some View {
        HStack(spacing: JunoSpace.roomy) {
            figure("Found", max(run.counts.found, run.sources.count))
            figure("Read", max(run.counts.read, run.readSourceCount))
            if run.derivesPhase || run.counts.cited > 0 { figure("Cited", run.counts.cited) }
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.cozy)
        .overlay(alignment: .top) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    private func figure(_ label: String, _ count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            Text(count.formatted()).monospacedDigit().foregroundStyle(Color.junoForeground)
            Text(label).foregroundStyle(Color.junoSecondaryInk)
        }
        .junoFont(size: 12, relativeTo: .footnote)
    }
}

/// The research phase's signature (SPEC §9.11.1's mapping table).
enum DesktopResearchPhase {
    static func glyph(_ phase: NativeResearchRun.Phase) -> JunoRunGlyphPhase {
        switch phase {
        case .planning, .reviewing: .thinking
        case .awaitingStart, .awaitingClarification: .waiting
        case .searching: .searching
        case .reading: .reading
        case .writing, .checking: .writing
        case .paused: .paused
        case .done, .stopped: .settled
        case .failed: .failed
        }
    }
}

// MARK: - The plan

/// A run's plan, waiting for the reader (SPEC §9.11.2) — the questions it
/// will answer, the sources it favours, and the estimate — with Start, the
/// one prominent button, and Cancel. Full size only at the transcript's end;
/// anywhere else it is the one-line "Plan ready · Review ›" row, which opens
/// on click.
///
/// Editing the questions and "Update plan" are the web's; this card starts or
/// cancels the plan as it stands.
struct DesktopResearchPlanCard: View {
    let run: NativeResearchRun
    /// At the transcript's end: the card at full size.
    let atTail: Bool
    let busy: Bool
    let error: String?
    let start: () -> Void
    let cancel: () -> Void

    @State private var opened = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if atTail || opened {
            card
        } else {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) { opened = true }
            } label: {
                HStack(spacing: 10) {
                    JunoRunSignature(phase: .waiting)
                    Text(NativeRunPhraseLine([NativeRunPhrase("Plan ready"), NativeRunPhrase("Review")]).text)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(Color.junoForeground.opacity(0.8))
                    JunoIconView(.chevronRight, size: 10, weight: .bold)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: DesktopRunLine.height)
            }
            .buttonStyle(DesktopRunLineButtonStyle())
            .contentShape(.rect)
            .accessibilityLabel("Research plan ready. Review")
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Your research plan")
                .font(JunoSerif.font(size: 24, relativeTo: .title2))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if let approach = run.approach {
                Text(approach)
                    .junoFont(size: 14, relativeTo: .body)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !run.questions.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("Questions")
                        .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(run.questions.enumerated()), id: \.element.id) { index, question in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            Text((index + 1).formatted())
                                .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .frame(minWidth: 14, alignment: .trailing)
                            Text(question.question)
                                .junoFont(size: 14, relativeTo: .body)
                                .foregroundStyle(Color.junoForeground)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            if let estimate = run.estimateLine {
                Text(estimate.text)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            if let error {
                Text(error)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoWarningInk)
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Cancel", action: cancel)
                    .buttonStyle(MessageGhostButtonStyle())
                    .contentShape(.rect)
                Button(action: start) {
                    Text("Start research").frame(minHeight: 32)
                }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
                .accessibilityLabel("Start research")
            }
            .disabled(busy || run.revising)
        }
        .padding(JunoSpace.roomy)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
        .opacity(run.revising ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Research plan")
    }
}

// MARK: - The clarify gate

/// What the goal left open, asked before the research starts (the web's
/// `ClarifyGate`, Phase 5 B6): in the plan card's shape, each question with
/// whether it is optional or needed, suggestion chips that fill the field,
/// and two answers — "Start researching" with what was filled in, or "Skip
/// and research as written". Neither is ever disabled for being empty:
/// skipping everything is a valid answer. Return in any field starts.
/// Full size only at the transcript's end; anywhere else it is one line that
/// opens on click.
struct DesktopResearchClarifyCard: View {
    let run: NativeResearchRun
    let atTail: Bool
    let busy: Bool
    let error: String?
    /// The answers, by question id; empty is "skip".
    let submit: ([String: String]) -> Void

    @State private var answers: [String: String] = [:]
    @State private var opened = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let lede = "A few details would sharpen this. Answer what you can \u{2014} anything you skip, Alevr decides for itself."

    var body: some View {
        if atTail || opened {
            card
        } else {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) { opened = true }
            } label: {
                HStack(spacing: 10) {
                    JunoRunSignature(phase: .waiting)
                    Text(run.phaseLine.text)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(Color.junoForeground.opacity(0.8))
                    JunoIconView(.chevronRight, size: 10, weight: .bold)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: DesktopRunLine.height)
            }
            .buttonStyle(DesktopRunLineButtonStyle())
            .contentShape(.rect)
            .accessibilityLabel("Research: \(run.phaseLine.text). Answer")
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The web's heading for a run at its gate.
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.research, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
                Text("Before Juno starts")
                    .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
            }
            Text(Self.lede)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.snug)
            if !run.goal.isEmpty {
                Text(run.goal)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoForeground.opacity(0.85))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.snug)
            }
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                ForEach(run.clarifications) { question in
                    field(question)
                }
            }
            .padding(.top, JunoSpace.regular)
            if let error {
                Text(error)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoWarningInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.cozy)
            }
            HStack(spacing: JunoSpace.snug) {
                Button {
                    submit(trimmedAnswers)
                } label: {
                    Text("Start researching").frame(minHeight: 28)
                }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.chat.research-clarify.start")
                Button("Skip and research as written") { submit([:]) }
                    .buttonStyle(MessageGhostButtonStyle())
                    .contentShape(.rect)
                    .accessibilityIdentifier("juno.chat.research-clarify.skip")
                Spacer(minLength: 0)
            }
            .padding(.top, JunoSpace.section)
            .disabled(busy)
        }
        .padding(JunoSpace.roomy)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Before Juno starts")
        .accessibilityIdentifier("juno.chat.research-clarify")
    }

    private var trimmedAnswers: [String: String] {
        answers.compactMapValues { value in
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.isEmpty ? nil : clean
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0 })
    }

    private func field(_ question: NativeResearchRun.Clarification) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(question.question)
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(question.skippable ? "Optional" : "Needed")
                    .junoFont(size: 11, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize()
            }
            if let why = question.why {
                Text(why)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, JunoSpace.micro)
            }
            TextField(
                question.question,
                text: binding(question.id),
                prompt: Text(question.suggestions.first.map { "e.g. \($0)" } ?? "Your answer")
            )
            .junoFieldChrome()
            .labelsHidden()
            .onSubmit { if !busy { submit(trimmedAnswers) } }
            .accessibilityLabel(question.question)
            .padding(.top, JunoSpace.snug)
            if !question.suggestions.isEmpty {
                JunoChipFlow(spacing: JunoChipMetrics.spacing) {
                    ForEach(question.suggestions, id: \.self) { suggestion in
                        let chosen = answers[question.id] == suggestion
                        Button(suggestion) {
                            // Fills the field: the answer is free text, and
                            // this is an example of its shape to edit.
                            answers[question.id] = chosen ? "" : suggestion
                        }
                        .buttonStyle(JunoChipStyle())
                        .background(Capsule().fill(Color.junoSecondary).opacity(chosen ? 1 : 0))
                        .contentShape(Capsule())
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                    }
                }
                .padding(.top, JunoSpace.snug)
            }
        }
    }
}

// MARK: - The panel

/// A research run's live progress and its report — the **Research** panel in
/// the trailing dock (SPEC §9.11.4), in the same shell as Activity.
///
/// While it works: **Progress** (the questions with their status, the stream
/// of what it did, what it has found so far), **Sources** (Read, then Found)
/// and **Plan**. Done: **Report**, Sources, Plan and **Details**. The header
/// holds the static phase word and clock, and the controls: Pause or Resume,
/// Finish now, and Cancel (confirmed). A run answered inside the chat (a
/// profile-1 server) has no controls and no plan; its report is the answer.
struct DesktopResearchPanel: View {
    let run: NativeResearchRun
    /// A run answered inside the chat, read from its rows.
    var inChat = false
    var busy = false
    var error: String? = nil
    /// The last read failed: what is shown is the last saved state.
    var unreachable = false
    var control: ((NativeResearchControl) -> Void)? = nil
    /// Queues guidance for the next round; the server's refusal, if any.
    var steer: ((String) async -> String?)? = nil
    /// Reads the run again after the connection dropped.
    var retry: (() -> Void)? = nil
    /// Whether this server takes "Finish now": a server that derives the
    /// phase does; today's answers 400, so it is hidden there.
    var canFinish = true
    /// The view it opens on — Sources, from a recap's "Inspect methodology
    /// & sources".
    var initialTab: Tab? = nil
    /// Opens the report in its own window (register #65).
    var openInWindow: (() -> Void)? = nil
    let close: () -> Void

    enum Tab: String, Hashable { case progress, report, sources, plan, details }

    @State private var chosen: Tab?
    @State private var confirmingCancel = false
    @Environment(\.junoSnapshotActivityTab) private var snapshotTab
    @Environment(\.junoSnapshotRunElapsed) private var snapshotElapsed

    private var tabs: [Tab] {
        var tabs: [Tab] = []
        if run.phase == .done, run.report != nil { tabs.append(.report) } else { tabs.append(.progress) }
        if !run.sources.isEmpty { tabs.append(.sources) }
        if !inChat, run.approach != nil || !run.questions.isEmpty { tabs.append(.plan) }
        if run.phase.isTerminal, !inChat { tabs.append(.details) }
        return tabs
    }

    var body: some View {
        let tabs = tabs
        let wanted = snapshotTab.flatMap(Tab.init(rawValue:)) ?? chosen ?? initialTab ?? tabs.first ?? .progress
        let shown = tabs.contains(wanted) ? wanted : (tabs.first ?? .progress)
        DesktopPanelShell(
            label: "Research",
            status: { now in status(at: now) },
            ticks: run.phase.isWorking,
            statusIsWarning: run.phase == .failed,
            tabs: tabs.map { tab in
                switch tab {
                case .progress: JunoSegmented<Tab>.Option(.progress, "Progress")
                case .report: JunoSegmented<Tab>.Option(.report, "Report")
                case .sources: JunoSegmented<Tab>.Option(.sources, "Sources \(run.sources.count)")
                case .plan: JunoSegmented<Tab>.Option(.plan, "Plan")
                case .details: JunoSegmented<Tab>.Option(.details, "Details")
                }
            },
            tab: Binding(get: { shown }, set: { chosen = $0 }),
            close: close,
            actions: { EmptyView() },
            content: {
                ScrollView {
                    VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                        if shown == .progress {
                            NativeResearchLiveView(
                                run: run,
                                actions: liveActions,
                                busy: busy,
                                error: error,
                                unreachable: unreachable,
                                compact: true,
                                frozenElapsed: snapshotElapsed
                            )
                            activity
                        } else {
                            Text(run.displayTitle.isEmpty ? "Deep research" : run.displayTitle)
                                .font(JunoSerif.font(size: 24, relativeTo: .title2))
                                .foregroundStyle(Color.junoForeground)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                            ResearchEvidenceLedger(run: run)
                            switch shown {
                            case .progress: EmptyView()
                            case .report: report
                            case .sources: sources
                            case .plan: plan
                            case .details: details
                            }
                        }
                    }
                    .padding(JunoSpace.regular)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        )
        .confirmationDialog("Stop this research?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Stop research", role: .destructive) { control?(.cancel) }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("It stops now and nothing more is spent. Sources found so far stay in the panel.")
        }
        .accessibilityIdentifier("juno.desktop.chat.research-panel")
    }

    /// The controls the live view draws: pause or resume, "Write with what
    /// you have" where the server takes it, guidance, and Stop (confirmed).
    private var liveActions: NativeResearchLiveActions {
        guard !inChat, let control else { return NativeResearchLiveActions(retry: retry) }
        return NativeResearchLiveActions(
            stop: { confirmingCancel = true },
            pause: { control(.pause) },
            resume: { control(.resume) },
            finish: canFinish ? { control(.finish) } : nil,
            guide: steer,
            retry: retry
        )
    }

    /// The static phase word and the working time; never a loop (SPEC §9.11.4).
    private func status(at now: Date) -> String {
        if run.finishRequested, run.phase.isWorking, run.phase != .writing, run.phase != .checking {
            return "Finishing with what it has"
        }
        guard let working = run.workingTime(at: now), working >= 1 else { return run.phaseWord }
        return "\(run.phaseWord) · \(NativeToolPresentation.clock(seconds: Int(working)))"
    }

    // MARK: Progress

    /// Everything it did, newest first, one disclosure down.
    private var activity: some View {
        DisclosureGroup(run.phase.isTerminal ? "Research activity" : "Live activity") {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                if run.steps.isEmpty {
                    Text(run.phaseLine.text)
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color.junoSecondaryInk)
                } else {
                    ForEach(run.steps.prefix(40)) { step in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            if step.isWarning {
                                JunoIconView(.warning, size: 12)
                                    .accessibilityHidden(true)
                            }
                            Text(step.line.text)
                                .junoFont(size: 13, relativeTo: .callout)
                                .lineLimit(2)
                            Spacer(minLength: JunoSpace.snug)
                            if let at = step.at {
                                Text(at.formatted(date: .omitted, time: .shortened))
                                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                                    .foregroundStyle(Color.junoSecondaryInk)
                            }
                        }
                        .foregroundStyle(step.isWarning ? Color.junoWarningInk : Color.junoForeground.opacity(0.85))
                    }
                }
            }
            .padding(.top, JunoSpace.snug)
        }
        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
        .foregroundStyle(Color.junoSecondaryInk)
    }

    // MARK: Report

    /// The report's door — its card opens the reading window — then the
    /// report itself at the panel's width.
    @ViewBuilder
    private var report: some View {
        if let report = NativeResearchReport(run: run) {
            VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                NativeResearchReportCard(content: .report(report), open: openInWindow)
                    .accessibilityIdentifier("juno.desktop.chat.research-panel.open-window")
                ForEach(report.sections) { section in
                    NativeResearchReportSectionView(section: section, compact: true)
                }
            }
            .environment(\.junoProseStyle, .reading)
            .environment(\.junoCitationCount, report.citationCount)
        }
    }

    // MARK: Sources

    private var sources: some View {
        let read = run.sources.filter(\.read)
        let found = run.sources.filter { !$0.read }
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !read.isEmpty {
                section("Read", count: read.count) {
                    ForEach(Array(read.enumerated()), id: \.element.id) { index, source in
                        SourceRow(source: NativeChatSource(title: source.title, url: source.url, snippet: ""), number: index + 1)
                    }
                }
            }
            if !found.isEmpty {
                section("Found", count: found.count) {
                    ForEach(Array(found.enumerated()), id: \.element.id) { index, source in
                        SourceRow(source: NativeChatSource(title: source.title, url: source.url, snippet: ""), number: read.count + index + 1)
                    }
                }
            }
            if read.isEmpty, found.isEmpty {
                Text(run.phase.isTerminal ? "No sources were read" : "No sources yet")
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }

    // MARK: Plan

    private var plan: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let approach = run.approach {
                Text(approach)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !run.questions.isEmpty {
                section("Questions") {
                    ForEach(Array(run.questions.enumerated()), id: \.element.id) { index, question in
                        Text("\((index + 1).formatted()). \(question.question)")
                            .junoFont(size: 13, relativeTo: .callout)
                            .foregroundStyle(Color.junoForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let estimate = run.estimateLine {
                Text(estimate.text)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }

    // MARK: Details

    private var details: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let lead = run.leadModel { fact("Written by", lead) }
            if run.counts.pages > 0 {
                fact("Pages read", NativeRunPhrase([.count(run.counts.pages, one: "page", other: "pages", approx: false)]).text)
            }
            if run.counts.searches > 0 {
                fact("Searches", NativeRunPhrase([.count(run.counts.searches, one: "search", other: "searches", approx: false)]).text)
            }
            if let working = run.workingMs {
                fact("Working time", NativeToolPresentation.duration(ms: working))
            }
        }
    }

    private func fact(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(value)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
        }
    }

    private func section<Content: View>(_ title: String, count: Int? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                Text(title)
                    .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
                    .foregroundStyle(Color.junoSecondaryInk)
                if let count {
                    Text(count.formatted())
                        .junoFont(size: 12, relativeTo: .footnote)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

// MARK: - "Research this"

/// The chip `suggest_research` leaves under an answer (SPEC §3.8.9): nothing
/// runs until it is pressed, and pressing it sends the question as a Research
/// request. Under the answer, never in the run block.
struct DesktopResearchThisChip: View {
    let question: String
    let research: () -> Void

    var body: some View {
        Button(action: research) {
            Label {
                Text("Research this")
            } icon: {
                JunoIconView(.research, size: 14)
            }
        }
        .buttonStyle(JunoChipStyle())
        .contentShape(Capsule())
        .help(question)
        .accessibilityLabel("Research this")
        .accessibilityHint("Starts Research on: \(question)")
    }
}
