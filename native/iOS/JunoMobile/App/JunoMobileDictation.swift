import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

/// Dictate Mode: the composer's text field is replaced by a listening capsule.
///
/// Ported from the website's `ComposerDictation` — the same shape and the same
/// three exits, because the shape is the argument. A microphone that just streams
/// words into the text field gives no way to abandon a sentence you got wrong and
/// no way to send without reaching back to the keyboard. So the capsule offers
/// exactly three: **cancel** discards, **stop** hands the text to the composer to
/// edit, **send** submits it.
///
///     ✕   ▁▃▅█▅▃▁ ▁▂▄▆▄▂▁ ▁▃▅   ■   ↑
///
/// The live transcript floats *above* the capsule rather than filling it. Reading
/// what you just said while the meter shows you are still being heard is the whole
/// feedback loop; putting the text inside the capsule made it resize on every word.
struct JunoMobileDictation: View {
    /// Discard and return to typing.
    let onCancel: () -> Void
    /// Finish and hand the transcript to the composer for editing.
    let onStop: (String) -> Void
    /// Finish and send immediately.
    let onSend: (String) -> Void

    @State private var speech = JunoSpeechService()
    @State private var startFailure: String?
    @State private var finishing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var transcript: String { speech.transcript }

    private var averageLevel: Double {
        guard !speech.levelHistory.isEmpty else { return 0 }
        let sum = speech.levelHistory.reduce(0.0, +)
        return min(1.0, max(0.0, sum / Double(speech.levelHistory.count)))
    }

    var body: some View {
        VStack(spacing: JunoSpace.cozy) {
            if let startFailure {
                unavailable(startFailure)
            } else {
                preview
                ZStack {
                    if !reduceMotion {
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [
                                        Color.junoAccent.opacity(0.35 + averageLevel * 0.45),
                                        Color.junoAccent.opacity(0.1),
                                        Color.clear,
                                    ],
                                    center: .center,
                                    startRadius: 8,
                                    endRadius: 90
                                )
                            )
                            .frame(width: 220, height: 110)
                            .scaleEffect(1.0 + averageLevel * 0.35)
                            .animation(.easeOut(duration: 0.12), value: averageLevel)
                    }
                    capsule
                }
            }
        }
        .task { await begin() }
        .accessibilityAddTraits(.isModal)
    }

    // MARK: - Preview

    /// Committed words in full contrast, the live hypothesis dimmed — so the
    /// reader can see which part of the sentence is still being revised.
    private var preview: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color.junoAccent)
                    .frame(width: 7, height: 7)
                    .opacity(speech.isListening ? 1 : 0.4)
                Text("Listening…")
                    .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
                    .foregroundStyle(Color.junoAccent)
                    .textCase(.uppercase)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.cozy)

            ScrollView {
                Text(previewText)
                    .junoFont(size: 15, relativeTo: .subheadline)
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.bottom, JunoSpace.cozy)
            }
            .frame(maxHeight: 120)
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.junoPopover.opacity(0.94))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.08), radius: 10, y: 4)
        .accessibilityLabel(transcript.isEmpty ? "Listening" : transcript)
        .accessibilityIdentifier("juno.mobile.dictation-preview")
    }

    private var previewText: AttributedString {
        guard !transcript.isEmpty else {
            var listening = AttributedString("Speak now, Juno is listening…")
            listening.foregroundColor = Color.junoMutedForeground
            return listening
        }
        var result = AttributedString(speech.finalizedText)
        let partial = speech.partialText.trimmingCharacters(in: .whitespaces)
        guard !partial.isEmpty else { return result }
        if !speech.finalizedText.isEmpty { result.append(AttributedString(" ")) }
        var hypothesis = AttributedString(partial)
        hypothesis.foregroundColor = Color.junoMutedForeground
        result.append(hypothesis)
        return result
    }

    // MARK: - Capsule

    private var capsule: some View {
        HStack(spacing: JunoSpace.cozy) {
            circleButton(
                systemName: "xmark",
                label: "Cancel dictation",
                identifier: "juno.mobile.dictation-cancel",
                style: .outline,
                action: cancel
            )

            JunoMobileDictationMeter(levels: speech.levelHistory)
                .frame(maxWidth: .infinity)

            circleButton(
                systemName: "stop.fill",
                label: "Stop and edit",
                identifier: "juno.mobile.dictation-stop",
                style: .neutral,
                glyphSize: 13,
                action: stop
            )

            circleButton(
                systemName: "arrow.up",
                label: "Send dictation",
                identifier: "juno.mobile.dictation-send",
                style: .accent,
                action: send
            )
            .disabled(transcript.isEmpty)
            .opacity(transcript.isEmpty ? 0.4 : 1)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 64)
        .background(JunoGlassBackground(cornerRadius: 32))
        .accessibilityIdentifier("juno.mobile.dictation")
    }

    private enum CircleStyle { case outline, neutral, accent }

    private func circleButton(
        systemName: String,
        label: String,
        identifier: String,
        style: CircleStyle,
        glyphSize: Double = 15,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            #endif
            action()
        }) {
            Image(systemName: systemName)
                .junoFont(size: glyphSize, relativeTo: .subheadline, weight: .semibold)
                .foregroundStyle(style == .accent ? Color.junoOnAccent : Color.primary)
                .frame(width: 40, height: 40)
                .background {
                    switch style {
                    case .outline:
                        Circle().strokeBorder(Color.junoHairline, lineWidth: 1)
                    case .neutral:
                        Circle().fill(Color.junoMuted)
                    case .accent:
                        Circle().fill(Color.junoAccent)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(finishing)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Unavailable

    private func unavailable(_ message: String) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: "mic.slash")
                .junoFont(size: 15, relativeTo: .subheadline)
                .foregroundStyle(Color.junoMutedForeground)
            Text(message)
                .junoFont(size: 13, relativeTo: .footnote)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
            circleButton(
                systemName: "xmark",
                label: "Close dictation",
                identifier: "juno.mobile.dictation-cancel",
                style: .outline,
                action: onCancel
            )
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.cozy)
        .frame(height: 64)
        .background(JunoGlassBackground(cornerRadius: 32))
        .accessibilityIdentifier("juno.mobile.dictation-unavailable")
    }

    // MARK: - Actions

    private func begin() async {
        guard await speech.requestPermission() else {
            startFailure = "Microphone or speech access was blocked — allow it in Settings to dictate."
            return
        }
        do {
            try speech.start()
        } catch {
            startFailure = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    private func cancel() {
        finishing = true
        speech.cancel()
        onCancel()
    }

    private func stop() {
        finishing = true
        onStop(speech.stopAndFreeze())
    }

    private func send() {
        finishing = true
        let text = speech.stopAndFreeze()
        guard !text.isEmpty else {
            onCancel()
            return
        }
        onSend(text)
    }
}

struct JunoMobileDictationMeter: View {
    let levels: [Double]

    private static let barCount = 32
    private static let barWidth: Double = 3.5
    private static let spacing: Double = 3
    private static let restingHeight: Double = 4
    private static let maximumHeight: Double = 28

    var body: some View {
        HStack(alignment: .center, spacing: Self.spacing) {
            ForEach(0..<Self.barCount, id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.junoAccent.opacity(0.7 + level(at: index) * 0.3),
                                Color.primary.opacity(0.4 + level(at: index) * 0.5),
                            ],
                            startPoint: .bottom,
                            endPoint: .top
                        )
                    )
                    .frame(width: Self.barWidth, height: height(at: index))
            }
        }
        .frame(height: Self.maximumHeight)
        .animation(nil, value: levels)
        .accessibilityHidden(true)
    }

    private func level(at index: Int) -> Double {
        let offset = Self.barCount - 1 - index
        let position = levels.count - 1 - offset
        guard position >= 0, position < levels.count else { return 0 }
        return min(1, max(0, levels[position]))
    }

    private func height(at index: Int) -> Double {
        Self.restingHeight
            + level(at: index) * (Self.maximumHeight - Self.restingHeight)
}

#if DEBUG
#Preview("Dictation meter") {
    VStack(spacing: JunoSpace.section) {
        JunoMobileDictationMeter(levels: (0..<48).map { _ in Double.random(in: 0...1) })
        JunoMobileDictationMeter(levels: [])
    }
    .padding()
    .background(Color.junoCanvas)
}
#endif
