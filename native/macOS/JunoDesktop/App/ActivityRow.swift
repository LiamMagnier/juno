import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The run above an answer, from send to done — the rework's run block
/// (Tool calls & research DECISIONS U1–U2, SPEC §7), which the brief's
/// activity row defers to.
///
/// **Live**, one line: the run signature in the phase's pattern, the phase in
/// words — "Thinking", "Searching the web for “…”", "Reading nature.com",
/// "Waiting for your approval" — and the clock, after three seconds. Under it,
/// once there is a step to show, a two-slot **peek** of the latest steps: tool
/// rows with their own state, or the newest sentence of the reasoning.
///
/// **At the first answer token** the peek folds away and the line settles into
/// its summary — "Thought for 12s · 5 sources ›" — with the dots gathering
/// into one. A turn with nothing to show (no reasoning, no tools, no sources,
/// no notices) draws nothing at all.
///
/// **One click** on the line opens the whole timeline inline, in the order it
/// happened; a tool row there, or the panel button, opens the Activity panel.
///
/// Replaces the web-era pieces: `JunoAIcssReasoningStream`, the "Thinking about
/// your request" row, and the conversation-wide research GroupBox.
struct DesktopRunBlock: View {
    let message: NativeChatMessage
    /// The turn is still streaming.
    let live: Bool
    /// The stream dropped and the store is reconnecting to it.
    var recovering = false
    /// An approval card is open on this turn.
    var awaitingApproval = false
    /// Opens the Activity panel, on a call when one is given.
    var openPanel: ((String?) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotRunExpanded) private var snapshotExpanded
    @State private var expanded = false
    @State private var hovered = false
    /// The web's pacing: nothing for 150ms, no words for 400ms, so a fast
    /// answer never flashes "Thinking".
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

    var body: some View {
        let view = view
        let answerStarted = !message.content.isEmpty
            && !view.calls.contains { $0.status == .running || $0.status == .queued }
        let phase = NativeRunPhase.derive(
            view: view,
            live: live,
            failed: message.errorDescription != nil,
            finishReason: message.finishReason,
            answerStarted: answerStarted,
            awaitingApproval: awaitingApproval
        )
        let hasContent = view.hasContent(sourceCount: message.sources.count)
        if message.mediaProgress == nil, live ? (phase.isWorking || phase == .waiting || hasContent) : hasContent {
            VStack(alignment: .leading, spacing: 0) {
                line(view: view, phase: phase)
                if live, phase.isWorking || phase == .waiting, !isExpanded {
                    DesktopRunPeek(view: view)
                        .transition(.opacity)
                }
                if isExpanded {
                    DesktopRunTimeline(view: view, live: live, openPanel: openPanel)
                        .padding(.top, JunoSpace.tight)
                        .padding(.leading, DesktopRunLine.textInset)
                        .transition(.opacity.combined(with: .offset(y: JunoMotion.shift(-4, reduceMotion: reduceMotion))))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: phase.isWorking)
            .task(id: message.runStartedAt) {
                // Words only after 400ms of work, measured from the send.
                let started = message.runStartedAt ?? .distantPast
                let wait = 0.4 - Date().timeIntervalSince(started)
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                showsLabel = true
            }
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: The line

    private func line(view: NativeRunView, phase: NativeRunPhase) -> some View {
        // Answering, done, stopped or failed: the line is its summary.
        let settled = !phase.isWorking && phase != .waiting && !recovering
        return Button {
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
                settled: settled,
                showsLabel: showsLabel || !live,
                expanded: isExpanded,
                hovered: hovered,
                inHeader: false
            )
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
        .onHover { hovered = $0 }
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
                .accessibilityLabel("Open the activity panel")
                .transition(.opacity)
            }
        }
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint("Shows the steps")
    }
}

extension EnvironmentValues {
    /// Opens every run block's inline timeline — the snapshot harness's
    /// stand-in for a click it cannot make. Production never sets it.
    @Entry var junoSnapshotRunExpanded = false
}

/// The run's one line: signature, words, facts, logos, and the clock or the
/// chevron.
struct DesktopRunLine: View {
    let view: NativeRunView
    let message: NativeChatMessage
    let phase: NativeRunPhase
    let live: Bool
    let recovering: Bool
    let settled: Bool
    let showsLabel: Bool
    let expanded: Bool
    let hovered: Bool
    /// The Activity panel's title: no chevron (it toggles nothing there) and
    /// no logos (the Sources view has them).
    var inHeader = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Where the words start: the 18pt signature and its 10pt gap. The peek
    /// and the timeline hang from the same edge.
    static let textInset: CGFloat = JunoRunSignature.side + 10

    var body: some View {
        if settled {
            // Nothing on a settled line ticks.
            content(now: .now)
        } else {
            // The one thing that changes each second — the clock, and the
            // rungs it crosses — so the line is the only view that redraws.
            TimelineView(.periodic(from: message.runStartedAt ?? .now, by: 1)) { context in
                content(now: context.date)
            }
        }
    }

    private func content(now: Date) -> some View {
        let elapsed = message.runStartedAt.map { now.timeIntervalSince($0) } ?? 0
        let calm = elapsed >= 20
        var facts = NativeToolPresentation.summaryFacts(view, sourceCount: message.sources.count)
        let label: String
        if settled {
            // No measured lead: the first fact leads, capitalised.
            if let lead = summaryLead {
                label = lead
            } else {
                let first = facts.isEmpty ? "Done" : facts.removeFirst()
                label = first.prefix(1).uppercased() + first.dropFirst()
            }
        } else {
            label = NativeToolPresentation.liveLabel(phase: phase, view: view, elapsed: elapsed, recovering: recovering)
        }
        return HStack(spacing: 10) {
            JunoRunSignature(phase: glyphPhase, calm: calm)
            HStack(spacing: 0) {
                if settled {
                    Text(label)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(hovered ? Color.junoForeground : Color.junoForeground.opacity(0.8))
                        .lineLimit(1)
                    if !facts.isEmpty {
                        Text(" · " + facts.joined(separator: " · "))
                            .junoFont(size: 13, relativeTo: .callout)
                            .monospacedDigit()
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                    }
                } else if showsLabel {
                    JunoRunLabel(label, shimmers: !calm && !recovering && phase != .waiting)
                        .junoType(.reading)
                        .id(label)
                        .transition(.opacity)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .layoutPriority(1)
            if !inHeader, !message.sources.isEmpty, settled || phase == .reading {
                SourceFaviconStack(sources: message.sources, size: 16, overlap: 4, ring: .junoCanvas)
            }
            if settled, view.counts.failedTools + view.counts.warnings > 0 {
                JunoIconView(.warning, size: 12)
                    .foregroundStyle(Color.junoWarningInk)
                    .accessibilityLabel("With warnings")
            }
            Spacer(minLength: JunoSpace.snug)
            if settled, inHeader {
                EmptyView()
            } else if settled {
                JunoIconView(.chevronRight, size: 10, weight: .bold)
                    .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .padding(.trailing, expanded ? 36 : 0)
            } else if elapsed >= 3 {
                Text(NativeToolPresentation.clock(seconds: Int(elapsed)))
                    .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minWidth: 40, alignment: .trailing)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 32)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: settled)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: label)
        .accessibilityElement(children: .combine)
    }

    /// "Thought for 12s", frozen at the first answer token: measured from the
    /// server's rows once they are here, from this Mac's clock until then.
    private var summaryLead: String? {
        var worked = view.timing.workedMs
        if worked == nil, let started = message.runStartedAt,
            let answered = message.answerStartedAt ?? (live ? nil : Optional(message.createdAt))
        {
            worked = Int(max(0, answered.timeIntervalSince(started)) * 1_000)
        }
        switch phase {
        case .stopped:
            return worked.map { "Stopped after \(NativeToolPresentation.duration(ms: $0))" } ?? "Stopped"
        case .failed:
            return worked.map { "Couldn’t finish after \(NativeToolPresentation.duration(ms: $0))" } ?? "Couldn’t finish"
        default:
            return NativeToolPresentation.summaryLead(view, workedMs: worked)
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

/// The two newest steps under the live line, in two fixed 28pt slots: tool
/// rows with their own state, or the reasoning's newest complete sentence. It
/// opens once, when the first step exists, and never resizes after that — new
/// steps enter from below.
struct DesktopRunPeek: View {
    let view: NativeRunView
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var steps: [NativeRunView.Item] {
        var latest: [NativeRunView.Item] = []
        for item in view.items.reversed() {
            switch item {
            case .reasoning:
                // Only the newest reasoning shows, as one excerpt.
                if !latest.contains(where: { if case .reasoning = $0 { return true } else { return false } }) {
                    latest.append(item)
                }
            case .tool, .notice:
                latest.append(item)
            case .commentary:
                continue
            }
            if latest.count == 2 { break }
        }
        return latest.reversed()
    }

    var body: some View {
        let steps = steps
        if !steps.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(steps) { step in
                    DesktopRunStepRow(item: step, compact: true)
                        .frame(height: 28)
                        .transition(
                            .asymmetric(
                                insertion: .opacity.combined(with: .offset(y: JunoMotion.shift(28, reduceMotion: reduceMotion))),
                                removal: .opacity
                            )
                        )
                }
            }
            .padding(.leading, DesktopRunLine.textInset)
            .padding(.top, JunoSpace.hairline)
            .frame(height: 2 * 28 + JunoSpace.hairline, alignment: .top)
            .clipped()
            .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: steps.map(\.id))
            .accessibilityElement(children: .contain)
        }
    }
}

// MARK: - The timeline

/// Every step, in the order it happened: reasoning as prose, commentary as a
/// quote, tool rows with their phrase, figure and state, notices.
struct DesktopRunTimeline: View {
    let view: NativeRunView
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
                        DesktopRunStepRow(item: item, compact: false)
                    }
                    .buttonStyle(.plain)
                    .contentShape(.rect)
                    .disabled(openPanel == nil)
                    .help("Show in the activity panel")
                default:
                    DesktopRunStepRow(item: item, compact: false)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    Text(Self.plain(text))
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
        case .commentary(_, let text):
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                Rectangle()
                    .fill(Color.junoBorder)
                    .frame(width: 2)
                Text(text)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(compact ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: !compact)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .tool(_, let call, _):
            DesktopToolCallLine(call: call)
        case .notice(_, let title, let detail):
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.warning, size: 13)
                Text(detail.map { "\(title) — \($0)" } ?? title)
                    .junoFont(size: 13, relativeTo: .callout)
                    .lineLimit(compact ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: !compact)
            }
            .foregroundStyle(Color.junoWarningInk)
        }
    }

    /// The reasoning's newest complete sentence, for a one-line excerpt.
    static func latestSentence(_ text: String) -> String {
        let flat = plain(text).replacingOccurrences(of: "\n", with: " ")
        let trimmed = flat.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(of: #"[^.!?]*[.!?](?=[^.!?]*$)"#, options: .regularExpression) else {
            return trimmed
        }
        let sentence = trimmed[range].trimmingCharacters(in: .whitespaces)
        return sentence.isEmpty ? trimmed : sentence
    }

    /// Provider reasoning, with its Markdown emphasis marks taken off.
    static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A tool call's row: its glyph, its phrase for its state, its figure, and a
/// running ring or its duration. Failures read as failures — the destructive
/// ink and the failure phrase — and a denial as a denial, never green.
struct DesktopToolCallLine: View {
    let call: NativeToolCall
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var failed: Bool { call.status == .failed }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(JunoIcon(rawValue: NativeToolPresentation.iconName(call)) ?? .tools, size: 14)
                .foregroundStyle(failed ? Color.junoDestructiveInk : Color.junoSecondaryInk)
            Text(NativeToolPresentation.phrase(call))
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(failed ? Color.junoDestructiveInk : Color.junoForeground.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.tail)
            if let figure = NativeToolPresentation.figure(call), call.status == .succeeded {
                Text(figure)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.snug)
            switch call.status {
            case .running, .queued:
                JunoRunSignature(phase: .tool, calm: true)
                    .scaleEffect(0.67)
                    .frame(width: 12, height: 12)
            case .awaitingApproval:
                Text("Waiting")
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoWarningInk)
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
