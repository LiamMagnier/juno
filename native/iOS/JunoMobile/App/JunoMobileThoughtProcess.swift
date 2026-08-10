import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The run trace above an answer — the phone's port of the website's
/// `ActivityTimeline` + `ThoughtProcessPanel` pair.
///
/// It replaces two separate controls that between them said very little: a
/// pulsing `sparkles` beside "Thinking about your request", and, once the answer
/// landed, a coral `brain` glyph labelled "Reasoning" over a `DisclosureGroup`.
/// The brain was a stock symbol for "AI" rather than anything of Juno's, coral
/// was spent on a passive label when the palette reserves it for what is active,
/// and neither ever said how long the run took.
///
/// The web's line is one object in two states, and that is what is ported here:
///
///     live    ⠿ dot-matrix   Thinking about your request · 4s
///     rest    ·              THOUGHT PROCESS                    8.4s  ›
///                            See how this response was made
///
/// The duration keeps the same slot and the same monospaced face in both states,
/// so the eye follows one continuous thing from meter to receipt. Settling is
/// four separate signals — the matrix stops, the number demotes, the nouns
/// appear, the chevron offers the detail — and the motion stopping is the least
/// of them.
struct JunoMobileThoughtProcessRow: View {
    /// Whether this answer is still being produced.
    let streaming: Bool
    /// True once the answer's own text has begun arriving, which is what
    /// separates "thinking" from "writing" on a client with no phase events.
    let writing: Bool
    /// The model's reasoning trace, when it sent one.
    let reasoning: String?
    /// This run's clock, measured by the transcript.
    let clock: JunoMobileRunClock

    /// The leading slot both states share — the web's `w-9`.
    private static let gutter: Double = 36

    @State private var showingPanel = false

    private var hasReasoning: Bool {
        !(reasoning ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The lines AIcss's viewport shows — a display chunking of what the provider
    /// sent, never a claim about where its steps were. See
    /// `JunoAIcssReasoningLines`.
    private var reasoningLines: [String] {
        guard streaming else { return [] }
        return JunoAIcssReasoningLines.lines(text: reasoning)
    }

    var body: some View {
        // Resting with nothing to show is no row at all — not an empty strip.
        // A model that returns no reasoning trace has nothing to disclose, and
        // the answer itself is the whole receipt.
        if streaming {
            VStack(alignment: .leading, spacing: 6) {
                liveStrip
                liveTrace
            }
            .padding(.bottom, 12)
        } else if hasReasoning {
            restingStrip
        }
    }

    /// THE LIVE TRACE, which this row used to refuse to show.
    ///
    /// The refusal was right about the CONTAINER and got read as being about the
    /// content: provider summaries arrive as half sentences and stray code, and a
    /// raw growing block of that reflowed the transcript on every delta. AIcss's
    /// viewport answers it — 40pt slots clamped to two lines, capped at 180pt and
    /// then masked, with the newest line translated into view rather than scrolled
    /// to. Nothing under the reader moves.
    ///
    /// Hidden from the accessibility tree deliberately. The strip above is inside
    /// an updating status and already carries the state in its label; exposed, a
    /// screen reader would read the model's entire private reasoning aloud,
    /// twice-revised, before ever reaching the answer.
    @ViewBuilder
    private var liveTrace: some View {
        let lines = reasoningLines
        if !lines.isEmpty {
            JunoAIcssReasoningStream(lines: lines, streaming: true, showsHeader: false)
                .padding(.leading, Self.gutter + 12)
                .accessibilityHidden(true)
        }
    }

    // MARK: - Live

    /// The contract, in one line: what it is doing, and for how long. The trace
    /// itself sits below in `liveTrace`, in a container that cannot reflow — which
    /// is what this row previously had no way to provide, and why it used to show
    /// the sentence alone.
    private var liveStrip: some View {
        HStack(spacing: 12) {
            // The same 36pt gutter the resting dot uses. The web puts the matrix
            // at its natural 18pt here and only widens the slot once the run
            // settles, so its sentence slides 18pt left→right at the moment the
            // strip changes state. One gutter for both states keeps the text on a
            // single axis, which is the point of the two states being one object.
            JunoThinkingMatrix()
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: Self.gutter)
            liveCopy
            Spacer(minLength: 0)
        }
        .frame(minHeight: 40)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thought process — in progress")
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// The sentence and the clock in one text run, so the ` · 4s` never wraps
    /// away from the phrase it belongs to.
    @ViewBuilder
    private var liveCopy: some View {
        if let startedAt = clock.startedAt {
            // One tick a second: the number is seconds-resolution, so a display
            // link would redraw the row sixty times to change nothing.
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                liveText(elapsed: context.date.timeIntervalSince(startedAt))
            }
        } else {
            liveText(elapsed: nil)
        }
    }

    private func liveText(elapsed: TimeInterval?) -> some View {
        let phrase = JunoMobileRunCopy.live(elapsed: elapsed, writing: writing)
        // AIcss's Thinking State, in place of the opacity breathe this used to
        // carry. Both say "still here" without spending coral on it, but the
        // breathe dimmed the whole sentence — including the part being read —
        // where the shine moves a valley of alpha THROUGH text that stays at full
        // weight. Reduce Motion is handled inside the modifier, which is why the
        // `reduceMotion` gate that used to live here is gone.
        return JunoAIcssThinkingLabel(
            elapsed == nil ? phrase : "\(phrase) · \(JunoMobileRunCopy.liveSpan(elapsed!))",
            size: 17
        )
        .lineLimit(1)
        .truncationMode(.tail)
    }

    // MARK: - Resting

    private var restingStrip: some View {
        Button { showingPanel = true } label: {
            HStack(spacing: 12) {
                // The web's `w-9` slot with its 1.5×1.5 point at the centre: what
                // nine travelling points collapse to once there is nothing left
                // to travel.
                Circle()
                    .fill(Color.junoMutedForeground.opacity(0.45))
                    .frame(width: 6, height: 6)
                    .frame(width: Self.gutter)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Thought process")
                        .font(JunoSerif.font(size: 13, relativeTo: .footnote, face: .medium))
                        .kerning(0.13)
                        .foregroundStyle(Color.junoMutedForeground)
                    Text("See how this response was made")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.primary.opacity(0.78))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let duration = clock.duration {
                    Text(JunoMobileRunCopy.span(duration))
                        .font(.system(size: 11, design: .monospaced))
                        .kerning(0.22)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoMutedForeground)
                        .padding(.horizontal, 1)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.junoMutedForeground)
            }
            .frame(minHeight: 48)
            .padding(.horizontal, 8)
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        }
        .buttonStyle(JunoMobileThoughtRowStyle())
        // The press wash bleeds past the transcript's own inset, as the web's
        // hover does: `-mx-2 px-2`.
        .padding(.horizontal, -8)
        .padding(.bottom, 12)
        .accessibilityLabel(
            [
                "Open thought process — complete",
                clock.duration.map(JunoMobileRunCopy.span),
            ]
            .compactMap { $0 }
            .joined(separator: ", ")
        )
        .accessibilityIdentifier("juno.mobile.thought-process")
        .sheet(isPresented: $showingPanel) {
            JunoMobileThoughtProcessPanel(
                reasoning: reasoning ?? "",
                duration: clock.duration
            )
        }
    }
}

/// A press wash rather than a tint change: the row is a disclosure, and it should
/// read as one surface lighting up under a finger.
private struct JunoMobileThoughtRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoMuted.opacity(configuration.isPressed ? 0.9 : 0))
            )
            .animation(JunoMotion.fast, value: configuration.isPressed)
    }
}


// MARK: - Clock

/// One run's timing, measured by the transcript rather than carried on the
/// message.
///
/// The web reads durations off the activity events the server persists with each
/// reply; the native message model has no such events, so the only honest source
/// is the clock in front of the reader. That means a duration exists for a run
/// **this session watched** and for no other: reopening an old conversation shows
/// the strip with no number, which is exactly what the web does for a reply whose
/// events it cannot find.
struct JunoMobileRunClock: Equatable, Sendable {
    /// When the current run began, while it is still running.
    var startedAt: Date?
    /// How long the run took, once it has settled.
    var duration: TimeInterval?

    static let none = JunoMobileRunClock()
}

/// The copy and the number formats, ported verbatim from `activity-timeline.tsx`
/// and `thought-process-panel.tsx` so the two clients never disagree about how
/// long something took.
enum JunoMobileRunCopy {
    /// Progressive copy, because a long silent reasoning stretch otherwise reads
    /// as hung — and because a reader who is going to wait minutes should be told
    /// they can leave.
    static func live(elapsed: TimeInterval?, writing: Bool) -> String {
        if writing { return "Writing the response" }
        let elapsed = elapsed ?? 0
        if elapsed >= 600 {
            return "Still thinking deeply — safe to leave; the answer will be here when you return"
        }
        if elapsed >= 120 { return "Still thinking — working in the background" }
        return "Thinking about your request"
    }

    /// Whole seconds while the run is live: a tenth of a second ticking under a
    /// sentence is noise.
    static func liveSpan(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }

    /// The settled receipt, which earns a decimal under ten seconds.
    static func span(_ interval: TimeInterval) -> String {
        if interval < 10 { return String(format: "%.1fs", interval) }
        if interval < 60 { return "\(Int(interval.rounded()))s" }
        let total = Int(interval.rounded())
        return "\(total / 60)m \(total % 60)s"
    }
}

// MARK: - Panel

/// The full trace. The web docks this beside the chat column; a phone has no
/// column to dock beside, so it is a sheet — which is the same contract (the
/// transcript stays where it was, and dismissing puts the reader back on it).
private struct JunoMobileThoughtProcessPanel: View {
    let reasoning: String
    let duration: TimeInterval?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    summary
                    reasoningSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .junoScreenCanvas()
            .navigationTitle("Thought process")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // A bare glyph: from OS 26 the toolbar draws its own glass
                    // capsule behind every item.
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .accessibilityLabel("Close thought process")
                    .accessibilityIdentifier("juno.mobile.thought-process-close")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// "What did it do?" answered at the top, where a run summary belongs, with
    /// the duration as a chip rather than as body text.
    private var summary: some View {
        JunoCard(padding: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Run summary")
                        .font(JunoSerif.font(size: 13, relativeTo: .footnote, face: .medium))
                        .kerning(0.13)
                        .foregroundStyle(Color.junoMutedForeground)
                    Text("Response complete")
                        .font(JunoSerif.font(size: 18, relativeTo: .headline, face: .semibold))
                        .foregroundStyle(Color.primary.opacity(0.9))
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let duration {
                    Text(JunoMobileRunCopy.span(duration))
                        .font(.system(size: 11, design: .monospaced))
                        .kerning(0.22)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoMutedForeground)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.junoMuted, in: Capsule())
                }
            }
        }
    }

    private var reasoningSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("REASONING")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .kerning(0.5)
                .foregroundStyle(Color.junoMutedForeground)

            // The trace leads; the prose is the evidence behind it. The question
            // that made someone open this sheet is "what did it do?", and a wall of
            // serif answers that worse than the model's own lines do — so the lines
            // come first, foldable, and the full text stays below them.
            let lines = JunoAIcssReasoningLines.lines(text: reasoning)
            if !lines.isEmpty {
                JunoCard(padding: 14) {
                    JunoAIcssReasoningStream(
                        lines: lines,
                        streaming: false,
                        duration: duration.map(JunoMobileRunCopy.span)
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            JunoCard(padding: 14) {
                // The serif, at reading size, because this is the model's own
                // prose rather than product chrome — the same call the web makes.
                Text(reasoning)
                    .font(JunoSerif.font(size: 14, relativeTo: .subheadline))
                    .lineSpacing(5)
                    .foregroundStyle(Color.primary.opacity(0.72))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

#if DEBUG
#Preview("Thought process") {
    VStack(alignment: .leading, spacing: 28) {
        JunoMobileThoughtProcessRow(
            streaming: true,
            writing: false,
            reasoning: nil,
            clock: JunoMobileRunClock(startedAt: Date().addingTimeInterval(-4))
        )
        JunoMobileThoughtProcessRow(
            streaming: true,
            writing: true,
            reasoning: "…",
            clock: JunoMobileRunClock(startedAt: Date().addingTimeInterval(-142))
        )
        JunoMobileThoughtProcessRow(
            streaming: false,
            writing: false,
            reasoning: "First I considered the shape of the request…",
            clock: JunoMobileRunClock(duration: 8.42)
        )
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Color.junoCanvas)
}
#endif
