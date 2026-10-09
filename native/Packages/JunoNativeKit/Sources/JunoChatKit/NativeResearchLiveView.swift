import Foundation
import JunoDesignSystem
import SwiftUI

/// What a live research view can ask of whoever hosts it. Every control is
/// optional: a control the server does not take is not drawn.
public struct NativeResearchLiveActions {
    public var stop: (() -> Void)?
    public var pause: (() -> Void)?
    public var resume: (() -> Void)?
    /// "Write with what you have" — only on a server that takes `finish`.
    public var finish: (() -> Void)?
    /// Queues guidance for the next round; returns the server's refusal, if any.
    public var guide: ((String) async -> String?)?
    /// Reads the run again after the connection dropped.
    public var retry: (() -> Void)?
    /// Opens everything behind the view: every source, the activity, the plan.
    public var details: (() -> Void)?

    public init(
        stop: (() -> Void)? = nil,
        pause: (() -> Void)? = nil,
        resume: (() -> Void)? = nil,
        finish: (() -> Void)? = nil,
        guide: ((String) async -> String?)? = nil,
        retry: (() -> Void)? = nil,
        details: (() -> Void)? = nil
    ) {
        self.stop = stop
        self.pause = pause
        self.resume = resume
        self.finish = finish
        self.guide = guide
        self.retry = retry
        self.details = details
    }
}

/// A research run while it works — the native counterpart of the web's Deep
/// Field console (`research-console.tsx`), shared by the Mac transcript, the
/// Mac Research panel and the phone's transcript.
///
/// Laid out like the web's: a mono line saying what is happening and for how
/// long, the question in Newsreader, then the field (the run's real sources on
/// their orbits) beside the questions it is working, the figures, the newest
/// pages read in their own titles, guidance, and the controls. No box: it is a
/// section of the conversation between two hairlines. Status is words — the
/// phase sentence, "Investigating", "Little evidence" in the warning ink with
/// its glyph — never a pill or a coloured dot.
public struct NativeResearchLiveView: View {
    let run: NativeResearchRun
    /// The numbered list the answer's `[n]` count (in-chat), and the text
    /// being written, so sources move to the inner orbit as they are cited.
    var citations: [NativeChatSource]?
    var citingText: String?
    var actions: NativeResearchLiveActions
    var busy: Bool
    var error: String?
    /// The last read failed: what is shown is the last saved state.
    var unreachable: Bool
    /// The field and the questions side by side when there is room.
    var compact: Bool
    /// A fixed clock, for a snapshot.
    var frozenElapsed: TimeInterval?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var guiding = false
    @State private var guidance = ""
    @State private var guidanceNotice: String?
    @State private var guidanceQueued = false
    @FocusState private var guidanceFocused: Bool

    public init(
        run: NativeResearchRun,
        citations: [NativeChatSource]? = nil,
        citingText: String? = nil,
        actions: NativeResearchLiveActions = NativeResearchLiveActions(),
        busy: Bool = false,
        error: String? = nil,
        unreachable: Bool = false,
        compact: Bool = false,
        frozenElapsed: TimeInterval? = nil
    ) {
        self.run = run
        self.citations = citations
        self.citingText = citingText
        self.actions = actions
        self.busy = busy
        self.error = error
        self.unreachable = unreachable
        self.compact = compact
        self.frozenElapsed = frozenElapsed
    }

    private var working: Bool { run.phase.isWorking && !unreachable }

    private var field: NativeResearchFieldModel {
        NativeResearchFieldModel(
            sources: run.fieldInputs(citations: citations, text: citingText),
            currentHost: run.phase == .reading ? run.phaseDomain : nil,
            maxLabels: compact ? 1 : 4
        )
    }

    private var phaseSentence: String {
        if run.finishRequested, run.phase.isWorking, run.phase != .writing, run.phase != .checking {
            return "Finishing with the evidence gathered so far"
        }
        return run.phaseLine.text
    }

    private var title: String {
        let goal = run.goal.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = run.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !shown.isEmpty { return shown }
        return goal.isEmpty ? "Deep research" : goal
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: compact ? JunoSpace.regular : JunoSpace.roomy) {
            header
            stage
            figures
            latest
            guidanceBlock
            notices
            controls
        }
        .padding(.vertical, compact ? JunoSpace.regular : JunoSpace.roomy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: run.sources.count)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: phaseSentence)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: guiding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.research.live")
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: compact ? JunoSpace.snug : JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Deep research")
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize()
                Text("\u{00B7}").foregroundStyle(Color.junoSecondaryInk)
                Text(phaseSentence)
                    .foregroundStyle(run.phase == .failed ? Color.junoWarningInk : Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .id(phaseSentence)
                    .transition(.opacity)
                    .accessibilityLabel("Research: \(phaseSentence)")
                Spacer(minLength: JunoSpace.snug)
                clock
            }
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            Text(title)
                .font(JunoSerif.font(size: compact ? 23 : 27, relativeTo: .title2))
                .foregroundStyle(Color.junoForeground)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let approach = run.approach, !compact || run.questions.isEmpty {
                Text(approach)
                    .junoFont(size: 14, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var clock: some View {
        if let frozenElapsed {
            clockText(frozenElapsed)
        } else if working {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if let time = run.workingTime(at: context.date) { clockText(time) }
            }
        } else if let time = run.workingTime(at: run.fetchedAt), time >= 1 {
            clockText(time)
        }
    }

    private func clockText(_ time: TimeInterval) -> some View {
        Text(NativeToolPresentation.clock(seconds: Int(time)))
            .monospacedDigit()
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize()
            .accessibilityLabel("Working time \(NativeToolPresentation.clock(seconds: Int(time)))")
    }

    // MARK: The field and the questions

    @ViewBuilder
    private var stage: some View {
        let model = field
        let showsField = !model.nodes.isEmpty || run.phase.isWorking
        if compact {
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                if showsField {
                    NativeResearchField(model: model, working: working, eventKey: "\(run.phase.rawValue):\(run.lastSeq)")
                        .frame(maxWidth: 420)
                        .frame(maxWidth: .infinity)
                }
                questions
            }
        } else {
            HStack(alignment: .center, spacing: JunoSpace.region) {
                if showsField {
                    NativeResearchField(model: model, working: working, eventKey: "\(run.phase.rawValue):\(run.lastSeq)")
                        .frame(minWidth: 260, maxWidth: 380)
                }
                questions
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var questions: some View {
        if !run.questions.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text("Questions")
                    .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityAddTraits(.isHeader)
                ForEach(run.questions.prefix(6)) { question in
                    NativeResearchQuestionRow(question: question)
                        .transition(.opacity)
                }
                if run.questions.count > 6 {
                    Text("+\(run.questions.count - 6) more")
                        .junoFont(size: 12, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
    }

    // MARK: Figures

    private var figures: some View {
        HStack(alignment: .firstTextBaseline, spacing: compact ? JunoSpace.section : JunoSpace.region) {
            figure("Found", max(run.counts.found, run.sources.count))
            figure("Read", max(run.counts.read, run.readSourceCount))
            if cited > 0 || run.derivesPhase { figure("Cited", cited) }
            if run.counts.searches > 0 { figure("Searches", run.counts.searches) }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    /// Cited so far: the report's marks once there are any, else the run's own
    /// count.
    private var cited: Int {
        let marked = field.nodes.filter { $0.state == .cited }.count
        return max(marked, run.phase.isTerminal ? run.counts.cited : 0)
    }

    private func figure(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value.formatted())
                .font(JunoSerif.font(size: compact ? 24 : 28, relativeTo: .title2))
                .monospacedDigit()
                .foregroundStyle(Color.junoForeground)
                .contentTransition(.numericText(value: Double(value)))
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion, tier: .tint), value: value)
            Text(label)
                .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoSecondaryInk)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Latest

    /// The newest evidence: the findings in the sources' own words when the
    /// run reports them with their page, else the newest pages read, in their
    /// own titles. Each arrives with a fade.
    @ViewBuilder
    private var latest: some View {
        let findings = run.findings.filter { $0.url != nil }.prefix(2)
        let pages = Array(run.sources.filter(\.read).suffix(3).reversed())
        if !findings.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                sectionLabel("Latest evidence")
                ForEach(Array(findings)) { finding in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text(finding.claim)
                            .font(JunoSerif.font(size: compact ? 16 : 17, relativeTo: .body))
                            .foregroundStyle(Color.junoForeground)
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                        if let url = finding.url {
                            Link(destination: url) {
                                HStack(spacing: JunoSpace.tight) {
                                    NativeSourceIcon(url: url, size: 13)
                                    Text(NativeResearchReport.host(url))
                                        .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                                        .foregroundStyle(Color.junoSecondaryInk)
                                }
                                .frame(minHeight: 28)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: -JunoMotion.riseDistance)), removal: .opacity))
                }
            }
        } else if !pages.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                sectionLabel("Latest pages")
                ForEach(pages) { source in
                    Link(destination: source.url) {
                        HStack(alignment: compact ? .firstTextBaseline : .center, spacing: JunoSpace.snug) {
                            NativeSourceIcon(url: source.url, size: 16)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                            let host = Text(NativeResearchReport.host(source.url))
                                .junoFont(size: 12, relativeTo: .caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(1)
                            let title = Text(source.title)
                                .junoFont(size: 14, relativeTo: .callout)
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            if compact {
                                VStack(alignment: .leading, spacing: 1) { title; host }
                            } else {
                                title.layoutPriority(1)
                                host.truncationMode(.middle)
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: compact ? 36 : 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(source.title), \(NativeResearchReport.host(source.url))")
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: -JunoMotion.riseDistance)), removal: .opacity))
                }
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Guidance

    @ViewBuilder
    private var guidanceBlock: some View {
        let latestSteer = run.steering.last
        if guiding || latestSteer != nil {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                if let latestSteer {
                    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                        Text(latestSteer.appliedAtRound == nil ? "Queued guidance" : "Applied guidance")
                            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize()
                        Text(latestSteer.text)
                            .junoFont(size: 14, relativeTo: .callout)
                            .foregroundStyle(Color.junoForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if guiding, let guide = actions.guide {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        TextField(
                            "What should the research focus on?",
                            text: $guidance,
                            prompt: Text("Change the scope, suggest an angle, or paste a source\u{2026}"),
                            axis: .vertical
                        )
                        .lineLimit(1...4)
                        .textFieldStyle(.plain)
                        .junoFont(size: 14, relativeTo: .callout)
                        .padding(JunoSpace.cozy)
                        .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                        .focused($guidanceFocused)
                        .onSubmit { submitGuidance(guide) }
                        .accessibilityLabel("Guidance for the research")
                        HStack(spacing: JunoSpace.snug) {
                            Button("Add guidance") { submitGuidance(guide) }
                                .buttonStyle(.junoProminent)
                                .controlSize(.small)
                                .disabled(busy || guidance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .contentShape(.rect)
                            Text(guidanceQueued ? "Added. It applies at the next research round." : "Applies at the next round.")
                                .junoFont(size: 12, relativeTo: .caption)
                                .foregroundStyle(guidanceQueued ? Color.junoForeground : Color.junoSecondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let guidanceNotice {
                            Label {
                                Text(guidanceNotice)
                            } icon: {
                                JunoIconView(.warning, size: 12)
                            }
                            .junoFont(size: 12, relativeTo: .caption)
                            .foregroundStyle(Color.junoWarningInk)
                        }
                    }
                    .transition(.opacity)
                }
            }
        }
    }

    private func submitGuidance(_ guide: @escaping (String) async -> String?) {
        let text = guidance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        Task { @MainActor in
            let refusal = await guide(text)
            guidanceNotice = refusal
            if refusal == nil {
                guidance = ""
                guidanceQueued = true
            }
        }
    }

    // MARK: Notices

    @ViewBuilder
    private var notices: some View {
        let warnings = run.steps.filter(\.isWarning).prefix(2)
        if unreachable || error != nil || !warnings.isEmpty || run.error != nil {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                if unreachable {
                    HStack(spacing: JunoSpace.snug) {
                        notice("Connection lost. Showing the last saved research.")
                        if let retry = actions.retry {
                            Button("Retry", action: retry)
                                .buttonStyle(.borderless)
                                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(.rect)
                        }
                    }
                }
                if let error { notice(error) }
                if let failure = run.error, run.phase == .failed { notice(failure) }
                ForEach(Array(warnings)) { step in notice(step.line.text) }
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            JunoIconView(.warning, size: 12)
        }
        .junoFont(size: 13, relativeTo: .callout)
        .foregroundStyle(Color.junoWarningInk)
        .textSelection(.enabled)
    }

    // MARK: Controls

    @ViewBuilder
    private var controls: some View {
        let live = !run.phase.isTerminal
        let gate = run.phase == .awaitingStart || run.phase == .awaitingClarification
        let showsGuide = actions.guide != nil && live && !gate && run.phase != .writing && run.phase != .checking
        let showsFinish = actions.finish != nil && run.phase.isWorking && run.phase != .writing && run.phase != .checking
        if live && (showsGuide || actions.pause != nil || actions.resume != nil || showsFinish || actions.stop != nil)
            || actions.details != nil
        {
            HStack(spacing: JunoSpace.snug) {
                if showsGuide {
                    controlButton(guiding ? "Hide guidance" : "Guide", icon: .compass) {
                        guiding.toggle()
                        guidanceFocused = guiding
                    }
                }
                if live, run.phase == .paused, let resume = actions.resume {
                    controlButton("Resume", icon: .play, action: resume)
                } else if live, run.phase.isWorking, let pause = actions.pause {
                    controlButton("Pause", icon: .pause, action: pause)
                }
                if showsFinish, let finish = actions.finish {
                    // The phone's row has room for four short verbs, not a
                    // sentence that wraps inside its capsule.
                    controlButton(compact ? "Write now" : "Write with what you have", icon: nil, action: finish)
                        .disabled(run.finishRequested)
                }
                Spacer(minLength: 0)
                if let details = actions.details {
                    controlButton("Details", icon: nil, action: details)
                }
                if live, let stop = actions.stop {
                    controlButton("Stop", icon: .stop, action: stop)
                        .help("Stop the research; keep what it found")
                }
            }
            .disabled(busy)
        }
    }

    private func controlButton(_ title: String, icon: JunoIcon?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.tight) {
                if let icon { JunoIconView(icon, size: 12) }
                Text(title)
                    .lineLimit(1)
            }
            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
            .frame(minHeight: compact ? 32 : 24)
            .contentShape(.rect)
        }
        .buttonStyle(.junoGlass)
        #if os(macOS)
        .controlSize(.small)
        #endif
        .tint(nil)
    }
}

/// One question the research is working: its glyph, its words, and how it is
/// going in words. The glyph carries meaning on its own (VoiceOver reads the
/// status), so colour is never the only signal.
public struct NativeResearchQuestionRow: View {
    let question: NativeResearchRun.Question

    public init(question: NativeResearchRun.Question) {
        self.question = question
    }

    private var icon: JunoIcon {
        switch question.status {
        case "covered": .circleCheck
        case "partial": .circleDot
        case "thin": .error
        case "searching": .circleDashed
        case "investigated": .check
        default: .circle
        }
    }

    private var active: Bool { question.status == "searching" }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 13)
                .foregroundStyle(question.status == "thin" ? Color.junoWarningInk
                    : active || question.status == "covered" ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(question.question)
                    .junoFont(size: 14, relativeTo: .callout)
                    .foregroundStyle(active || question.status == "covered" ? Color.junoForeground : Color.junoForeground.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
                Text(NativeResearchRun.questionStatus(question.status))
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(question.status == "thin" ? Color.junoWarningInk : Color.junoSecondaryInk)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
