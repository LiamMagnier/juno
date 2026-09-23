import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The run above an answer, from send to done — the rework's run block (Tool
/// calls & research SPEC §7; DECISIONS U1–U2).
///
/// **Live**, one 36pt line: the run signature in the phase's pattern, the
/// phase in words with the one shimmer — "Thinking", "Searching the web for
/// “…”", "Reading nature.com", "Waiting for your approval" — the sources so
/// far, and the clock from three seconds. Under it, once a step exists, a
/// fixed two-slot **peek** of the newest steps: tool rows with their own state
/// and a still running ring, or the newest sentence of the reasoning. The
/// line's words are paced (§7.3): nothing for 150ms, no words for 400ms, a
/// label stays 600ms, changes are 700ms apart and the newest phase wins.
///
/// **At the first answer text** the peek folds away, the dots gather into one,
/// and the line settles into its summary — "Thought for 12s · 5 sources ·
/// ran code ›" — with no layout jump: the line keeps its height. A turn with
/// nothing to show (no reasoning, tools, sources or notices) draws nothing.
///
/// **One click** on the line opens the whole timeline inline, in the order it
/// happened; a tool row there, or the panel button, opens the Activity panel
/// on that call.
struct DesktopRunBlock: View {
    let message: NativeChatMessage
    /// The turn is still streaming.
    let live: Bool
    /// The stream dropped and the store is reconnecting to it.
    var recovering = false
    /// An approval card is open on this turn.
    var awaitingApproval = false
    /// Whether this line owns the one run loop on screen (SPEC §7.9.1): false
    /// while the Activity panel is open on this reply (its live row owns it).
    var ownsLoop = true
    /// Opens the Activity panel, on a call when one is given.
    var openPanel: ((String?) -> Void)? = nil
    /// Opens the Research panel on a run: a research completion message's
    /// line ("Researched for 8m 32s · 9 sources ›") opens its report
    /// rather than a timeline (SPEC §9.11.3).
    var openResearch: ((String) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotRunExpanded) private var snapshotExpanded
    @State private var expanded = false
    /// The pacer's first two gates: the glyph at 150ms, words at 400ms.
    @State private var showsGlyph = false
    @State private var showsLabel = false

    private var view: NativeRunView {
        NativeRunView.build(
            activity: message.activity,
            reasoning: message.reasoning,
            reasoningParts: message.reasoningParts,
            sources: message.sources
        )
    }

    private var isExpanded: Bool { expanded || snapshotExpanded }

    /// Answer text has been released to the answer area (the reducer holds
    /// back provisional text, SPEC §7.3).
    private var answerStarted: Bool {
        message.answerStartedAt != nil || (!message.content.isEmpty && !live)
    }

    var body: some View {
        let view = view
        let phase = NativeRunPhase.derive(
            view: view,
            live: live,
            failed: message.errorDescription != nil,
            finishReason: message.finishReason,
            answerStarted: answerStarted,
            awaitingApproval: awaitingApproval
        )
        let hasContent = view.hasContent(sourceCount: message.sources.count)
        let commentary = commentaryParagraphs(view)
        // Live: from 150ms of work (a trivial answer that lands first draws
        // nothing); at rest: only what has something to show.
        let shows = message.mediaProgress == nil
            && (live ? (phase.isSettled ? hasContent : (showsGlyph || snapshotExpanded || !phase.isWorking)) : hasContent)
        if shows {
            VStack(alignment: .leading, spacing: 0) {
                line(view: view, phase: phase)
                // Once answer text has begun the peek never reopens: a tool that
                // re-enters work moves the line alone (SPEC §7.3, re-entry).
                if live, !phase.isSettled, !answerStarted, !isExpanded, !peekSteps(view).isEmpty {
                    DesktopRunPeek(steps: peekSteps(view), loops: false)
                        .transition(.opacity)
                }
                if isExpanded {
                    DesktopRunTimeline(view: view, message: message, live: live, openPanel: openPanel)
                        .padding(.top, JunoSpace.tight)
                        .padding(.leading, DesktopRunLine.textInset)
                        .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(-4, reduceMotion: reduceMotion))))
                } else if !commentary.isEmpty {
                    DesktopRunCommentary(paragraphs: commentary)
                        .padding(.top, JunoSpace.tight)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: phase.isSettled)
            .task(id: message.runStartedAt) { await pace() }
            .accessibilityElement(children: .contain)
        } else if live, !showsGlyph {
            // The first 150ms: nothing drawn, but the pacer's clock runs.
            Color.clear
                .frame(width: 0, height: 0)
                .task(id: message.runStartedAt) { await pace() }
                .accessibilityHidden(true)
        }
    }

    /// Nothing for 150ms, no words for 400ms, measured from the send.
    private func pace() async {
        guard live, let started = message.runStartedAt else {
            showsGlyph = true
            showsLabel = true
            return
        }
        let glyphWait = NativeRunPacing.glyphDelay - Date().timeIntervalSince(started)
        if glyphWait > 0 { try? await Task.sleep(for: .seconds(glyphWait)) }
        showsGlyph = true
        let labelWait = NativeRunPacing.showDelay - Date().timeIntervalSince(started)
        if labelWait > 0 { try? await Task.sleep(for: .seconds(labelWait)) }
        showsLabel = true
    }

    /// The two newest steps: tool rows, the newest reasoning, a declared
    /// commentary excerpt.
    private func peekSteps(_ view: NativeRunView) -> [NativeRunView.Item] {
        var latest: [NativeRunView.Item] = []
        var items = view.items
        for live in message.liveCommentary where !live.inline {
            items.append(.commentary(id: "live-\(live.round)", text: live.text, inline: false))
        }
        for item in items.reversed() {
            switch item {
            case .reasoning:
                if !latest.contains(where: \.isReasoning) { latest.append(item) }
            case .commentary(_, _, let inline):
                if !inline { latest.append(item) }
            case .tool, .notice:
                latest.append(item)
            }
            if latest.count == 2 { break }
        }
        return latest.reversed()
    }

    /// Inline commentary, above the answer: the rows the server marked, and
    /// text the reducer already knows is commentary.
    private func commentaryParagraphs(_ view: NativeRunView) -> [String] {
        view.inlineCommentary + message.liveCommentary.filter(\.inline).map(\.text)
    }

    // MARK: The line

    private func line(view: NativeRunView, phase: NativeRunPhase) -> some View {
        Button {
            if let research = view.facts.research, let openResearch {
                openResearch(research.runID)
                return
            }
            withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                expanded.toggle()
            }
        } label: {
            DesktopRunLine(
                view: view,
                message: message,
                phase: phase,
                live: live,
                recovering: recovering,
                showsLabel: showsLabel || !live,
                expanded: isExpanded,
                ownsLoop: ownsLoop
            )
        }
        .buttonStyle(DesktopRunLineButtonStyle())
        .overlay(alignment: .trailing) {
            if isExpanded, let openPanel {
                Button {
                    openPanel(nil)
                } label: {
                    JunoIconView(.panelRight, size: 14)
                }
                .buttonStyle(JunoProseIconButtonStyle())
                .contentShape(.rect)
                .help("Open in panel")
                .accessibilityLabel("Open in panel")
                .transition(.opacity)
            }
        }
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(isExpanded ? "Hides the steps" : "Shows the steps")
    }
}

/// The run line's press: the whole row is the target, hover lifts its ink.
struct DesktopRunLineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(.rect)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension EnvironmentValues {
    /// The reply the Activity panel is open on: its live row owns the run
    /// loop, so that reply's line shows its phase's still frame (SPEC §7.9.1).
    @Entry var junoActivityPanelMessageID: String? = nil
    /// Opens every run block's inline timeline — the snapshot harness's
    /// stand-in for a click it cannot make. Production never sets it.
    @Entry var junoSnapshotRunExpanded = false
    /// Freezes every run line's clock at this many seconds — the harness's
    /// stand-in for a clock it cannot wait on.
    @Entry var junoSnapshotRunElapsed: TimeInterval? = nil
}

/// The run's one line: signature, words, facts, logos, and the clock or the
/// chevron (SPEC §7.5).
struct DesktopRunLine: View {
    let view: NativeRunView
    let message: NativeChatMessage
    let phase: NativeRunPhase
    let live: Bool
    let recovering: Bool
    let showsLabel: Bool
    let expanded: Bool
    var ownsLoop = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotRunElapsed) private var snapshotElapsed
    @State private var hovered = false
    @State private var pacer = NativeRunLabelPacer()
    @State private var shownLine = NativeRunPhraseLine([])
    @State private var shownKey = ""

    /// Where the words start: the 18pt signature and its 10pt gap. The peek
    /// and the timeline hang from the same edge.
    static let textInset: CGFloat = JunoRunSignature.side + 10
    static let height: CGFloat = 36

    private var settled: Bool { phase.isSettled && !recovering }

    var body: some View {
        Group {
            if settled {
                // Nothing on a settled line ticks.
                content(now: .now)
            } else {
                // The one thing that changes each second — the clock, and the
                // captions it crosses — so the line is the only view that
                // redraws.
                TimelineView(.periodic(from: message.runStartedAt ?? .now, by: 1)) { context in
                    content(now: context.date)
                }
            }
        }
        .onHover { hovered = $0 }
        .onAppear { offer(now: Date()) }
        .onChange(of: labelKey) { _, _ in offer(now: Date()) }
        .onChange(of: liveLine) { _, line in
            // Same phase and subject: the words update in place.
            if liveKey == shownKey { shownLine = line }
        }
        .task(id: labelKey) {
            // A change the pacer held lands when its gap has passed.
            guard let next = pacer.nextCheck(phase: phase, subject: subject) else { return }
            let wait = next.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled else { return }
            offer(now: Date())
        }
    }

    private var subject: String {
        recovering ? "recovering" : NativeToolPresentation.subjectKey(phase: phase, view: view)
    }

    private var liveKey: String { "\(phase)|\(subject)" }
    private var labelKey: String { liveKey }

    private var liveLine: NativeRunPhraseLine {
        NativeToolPresentation.liveLine(phase: phase, view: view, recovering: recovering)
    }

    private func offer(now: Date) {
        if pacer.offer(phase: phase, subject: subject, now: now) || shownLine.isEmpty {
            shownLine = liveLine
            shownKey = liveKey
        }
    }

    private func content(now: Date) -> some View {
        let elapsed = snapshotElapsed ?? message.runStartedAt.map { now.timeIntervalSince($0) } ?? 0
        let stalled = live && NativeRunPacing.stalled(phase: phase, view: view, lastEventAt: message.lastEventAt, now: now)
        let calm = NativeRunPacing.calm(working: elapsed, stalled: stalled)
        let caption = settled ? nil : NativeToolPresentation.caption(
            stalledFor: stalled ? message.lastEventAt.map { now.timeIntervalSince($0) } : nil,
            escalation: phase.isWorking ? NativeRunPacing.escalation(working: elapsed) : 0
        )
        let summary = summaryLine
        // Settled, the summary's first phrase leads and the rest are its facts.
        let facts = settled ? Array(summary.phrases.dropFirst()) : liveFacts
        let label = settled ? (summary.phrases.first?.text ?? "Done") : (shownLine.isEmpty ? liveLine.text : shownLine.text)
        let warnings = view.counts.failedTools + view.counts.warnings
        return HStack(spacing: 10) {
            JunoRunSignature(phase: glyphPhase, calm: calm, loops: ownsLoop && !settled)
            HStack(spacing: JunoSpace.tight) {
                if settled {
                    Text(label)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(
                            phase == .failed
                                ? Color.junoWarningInk
                                : (hovered ? Color.junoForeground : Color.junoForeground.opacity(0.8))
                        )
                        .lineLimit(1)
                        .layoutPriority(2)
                        .transition(.opacity)
                } else if showsLabel {
                    JunoRunLabel(label, shimmers: ownsLoop && !calm && !recovering && phase != .waiting)
                        .junoType(.reading)
                        .foregroundStyle(phase == .failed ? Color.junoWarningInk : Color.junoSecondaryInk)
                        .id(shownKey)
                        .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(3, reduceMotion: reduceMotion))))
                        .layoutPriority(2)
                }
                if let caption {
                    Text(caption.text)
                        .junoFont(size: 12, relativeTo: .footnote)
                        .foregroundStyle(stalled ? Color.junoWarningInk : Color.junoSecondaryInk)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                if !facts.isEmpty, caption == nil {
                    // The design separator between complete phrases (SPEC
                    // §7.6.2): "Thought for 12s · 5 sources · ran code".
                    Text("· " + facts.map(\.text).joined(separator: " · "))
                        .junoFont(size: 12, relativeTo: .footnote)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
            }
            if !message.sources.isEmpty {
                SourceFaviconStack(sources: message.sources, size: 16, overlap: 4, ring: .junoCanvas, showsMore: true)
            }
            if settled, warnings > 0 {
                JunoIconView(.warning, size: 12)
                    .foregroundStyle(Color.junoWarningInk)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: JunoSpace.snug)
            if settled {
                JunoIconView(.chevronRight, size: 10, weight: .bold)
                    .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .padding(.trailing, expanded ? 36 : 0)
            } else if elapsed >= NativeRunPacing.timerAfter {
                Text(NativeToolPresentation.clock(seconds: Int(elapsed)))
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minWidth: 40, alignment: .trailing)
                    // Clear of the "Open in panel" button the open timeline
                    // puts at the line's end.
                    .padding(.trailing, expanded ? 36 : 0)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: Self.height)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: settled)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: shownKey)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            NativeToolPresentation.accessibilityName(
                phase: phase,
                view: view,
                live: shownLine.isEmpty ? liveLine : shownLine,
                settled: summary,
                warnings: warnings
            )
        )
    }

    /// Live facts: the sources so far (SPEC §7.5), only when non-zero.
    private var liveFacts: [NativeRunPhrase] {
        let sources = max(message.sources.count, view.counts.sources)
        guard sources > 0 else { return [] }
        return [NativeRunPhrase([.count(sources, one: "source", other: "sources", approx: false)])]
    }

    /// The honest working time: the server's rows once they are here, this
    /// Mac's clock until then; frozen at the first answer text.
    private var workedMs: Int? {
        if let worked = view.timing.workedMs { return worked }
        guard let started = message.runStartedAt,
            let answered = message.answerStartedAt ?? (live ? nil : Optional(message.createdAt))
        else { return nil }
        return Int(max(0, answered.timeIntervalSince(started)) * 1_000)
    }

    private var summaryLine: NativeRunPhraseLine {
        switch phase {
        case .stopped: NativeToolPresentation.stoppedLine(workedMs: workedMs)
        case .failed: NativeToolPresentation.failedRunLine(workedMs: workedMs)
        default: NativeToolPresentation.summaryLine(view, workedMs: workedMs, sourceCount: message.sources.count)
        }
    }

    private var glyphPhase: JunoRunGlyphPhase {
        if recovering { return .thinking }
        switch phase {
        case .queued, .thinking: return .thinking
        case .searching: return .searching
        case .reading: return .reading
        case .tool: return .tool
        case .waiting: return .waiting
        case .failed: return .failed
        case .answering, .done, .stopped: return .settled
        }
    }
}

// MARK: - The peek

/// The two newest steps under the live line, in two fixed 28pt slots below an
/// 8pt margin (SPEC §7.5): tool rows with their own state, or the reasoning's
/// newest complete sentence. It opens once, when the first step exists, and
/// never resizes after that — new steps enter from below.
struct DesktopRunPeek: View {
    let steps: [NativeRunView.Item]
    /// Peek rows never loop (SPEC §7.9.1): their running marker is still.
    var loops = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let slot: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            ForEach(steps) { step in
                DesktopRunStepRow(item: step, compact: true)
                    .frame(height: Self.slot)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: JunoMotion.shift(Self.slot, reduceMotion: reduceMotion))),
                            removal: .opacity
                        )
                    )
            }
        }
        .padding(.leading, DesktopRunLine.textInset)
        .frame(height: 2 * Self.slot, alignment: .bottom)
        .padding(.top, JunoSpace.snug)
        .clipped()
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: steps.map(\.id))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Commentary

/// The model talking while it worked — text a round wrote before it called a
/// tool — directly above the answer, in the answer's own reading type so
/// nothing moves when it leaves the answer, in the muted ink (SPEC §7.5).
struct DesktopRunCommentary: View {
    let paragraphs: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                Self.text(paragraph)
                    .junoType(.reading)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Commentary is a sentence or two of the model's own words: its inline
    /// Markdown kept, in the muted ink the prose renderer does not take.
    static func text(_ markdown: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown))
    }
}

// MARK: - The timeline

/// Every step, in the order it happened (SPEC §7.8): reasoning as prose,
/// commentary as a quote, tool rows with their phrase, figure, state and
/// duration — approval receipts under the call they answered — and notices.
struct DesktopRunTimeline: View {
    let view: NativeRunView
    let message: NativeChatMessage
    let live: Bool
    let openPanel: ((String?) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            ForEach(view.items) { item in
                switch item {
                case .tool(_, let call, _):
                    Button {
                        openPanel?(call.callID)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            DesktopRunStepRow(item: item, compact: false)
                            if let receipt = DesktopApprovalReceipt.words(for: call) {
                                Text(receipt)
                                    .junoFont(size: 12, relativeTo: .footnote)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .padding(.leading, 14 + JunoSpace.snug)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .contentShape(.rect)
                    .disabled(openPanel == nil)
                    .help("Show in the activity panel")
                default:
                    DesktopRunStepRow(item: item, compact: false)
                }
            }
            ForEach(message.liveCommentary, id: \.round) { live in
                DesktopRunStepRow(item: .commentary(id: "live-\(live.round)", text: live.text, inline: live.inline), compact: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An approval's receipt, as the card collapses to it (SPEC §7.10).
enum DesktopApprovalReceipt {
    /// The receipt under a call — none while the call waits on it (the card
    /// is the live state), and none where the call's own words already say
    /// it (declined, expired).
    static func words(for call: NativeToolCall) -> String? {
        switch call.status {
        case .awaitingApproval, .queued, .running, .denied, .expired: return nil
        default: return words(call.approval)
        }
    }

    static func words(_ approval: NativeToolCall.Approval?) -> String? {
        guard let approval else { return nil }
        let time = approval.decidedAt.map { $0.formatted(date: .omitted, time: .shortened) }
        switch approval.status {
        case "allowed", "executing", "executed", "failed":
            let what = approval.decision == "allow_scope" ? "Always allowed" : "Allowed once"
            return time.map { "\(what) · \($0)" } ?? what
        case "denied": return "You declined this"
        case "superseded": return "Cancelled"
        case "blocked": return "Blocked by your settings"
        default: return "Approval expired"
        }
    }
}

/// One step, in the peek (one line) or the timeline (as much as it has).
struct DesktopRunStepRow: View {
    let item: NativeRunView.Item
    let compact: Bool
    @State private var showsAll = false

    var body: some View {
        switch item {
        case .reasoning(_, let text):
            if compact {
                Text(Self.latestSentence(text))
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    if let headline = NativeToolPresentation.headline(of: text) {
                        Text(headline)
                            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                            .foregroundStyle(Color.junoForeground.opacity(0.85))
                    }
                    Text(Self.body(text))
                        .junoType(JunoType(size: 13, lineHeight: 1.55, textStyle: .callout))
                        .foregroundStyle(Color.junoSecondaryInk)
                        .textSelection(.enabled)
                        .lineLimit(showsAll ? nil : 6)
                        .fixedSize(horizontal: false, vertical: true)
                    if !showsAll, text.count > 480 {
                        Button("Show more") { showsAll = true }
                            .buttonStyle(MessageGhostButtonStyle(fontSize: 11, horizontalPadding: 6))
                            .contentShape(.rect)
                            .padding(.leading, -6)
                    }
                }
            }
        case .commentary(_, let text, _):
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                Rectangle()
                    .fill(Color.junoBorder)
                    .frame(width: 2)
                Text(Self.plain(text))
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(compact ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: !compact)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .tool(_, let call, _):
            DesktopToolCallLine(call: call)
        case .notice(_, let notice, let title, let detail):
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.warning, size: 13)
                    .accessibilityHidden(true)
                Text(NativeToolPresentation.noticeLine(notice, title: title, detail: detail).text)
                    .junoFont(size: 13, relativeTo: .callout)
                    .lineLimit(compact ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: !compact)
            }
            .foregroundStyle(notice?.isMustAct ?? true ? Color.junoWarningInk : Color.junoSecondaryInk)
        }
    }

    /// The reasoning's newest complete sentence, for a one-line excerpt.
    static func latestSentence(_ text: String) -> String {
        let flat = plain(text).replacingOccurrences(of: "\n", with: " ")
        let trimmed = flat.trimmingCharacters(in: .whitespacesAndNewlines)
        var sentences: [String] = []
        trimmed.enumerateSubstrings(in: trimmed.startIndex..., options: .bySentences) { substring, _, _, _ in
            if let substring {
                let sentence = substring.trimmingCharacters(in: .whitespaces)
                if !sentence.isEmpty { sentences.append(sentence) }
            }
        }
        // The newest *complete* sentence: the last one that ends in its stop.
        if let complete = sentences.last(where: { $0.last.map { ".!?…。".contains($0) } ?? false }) {
            return complete
        }
        return sentences.last ?? trimmed
    }

    /// The reasoning without its headline line, when it has one.
    static func body(_ text: String) -> String {
        guard let headline = NativeToolPresentation.headline(of: text) else { return plain(text) }
        let lines = text.components(separatedBy: "\n")
        guard let index = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "**\(headline)**" }) else {
            return plain(text)
        }
        var rest = lines
        rest.remove(at: index)
        return plain(rest.joined(separator: "\n"))
    }

    /// Provider reasoning, with its Markdown emphasis marks taken off.
    static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A tool call's row: its glyph, its words for its state, its figure, and a
/// still running ring, the approval ring, or its duration. Failures read as
/// failures — the one failure ink, warning (SPEC §7.6.2), and the failure
/// phrase — and a denial as a denial, never green, never red.
struct DesktopToolCallLine: View {
    let call: NativeToolCall
    /// The Activity panel's running row owns the loop while the panel is open.
    var loops = false

    private var failed: Bool { NativeToolPresentation.readsAsFailure(call) }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(JunoIcon(rawValue: NativeToolPresentation.iconName(call)) ?? .tools, size: 14)
                .foregroundStyle(failed ? Color.junoWarningInk : Color.junoSecondaryInk)
                .accessibilityHidden(true)
            Text(NativeToolPresentation.phrase(call))
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(failed ? Color.junoWarningInk : Color.junoForeground.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.tail)
            if call.status == .succeeded, let figure = NativeToolPresentation.figure(call) {
                Text(figure)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.snug)
            switch call.status {
            case .running, .queued:
                JunoRunMarker(.running, loops: loops)
            case .awaitingApproval:
                JunoRunMarker(.waiting)
            default:
                if let ms = call.durationMs {
                    Text(NativeToolPresentation.duration(ms: ms))
                        .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
        .frame(minHeight: 24)
        .accessibilityElement(children: .combine)
    }
}
