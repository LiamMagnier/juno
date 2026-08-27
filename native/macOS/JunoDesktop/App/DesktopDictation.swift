import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

/// The iPhone and website Dictate Mode adapted without changing its shape:
/// live transcript above a fixed glass capsule with cancel, stop-to-edit, and
/// send exits.
struct DesktopDictation: View {
    let onCancel: () -> Void
    let onStop: (String) -> Void
    let onSend: (String) -> Void

    @State private var speech = JunoSpeechService()
    @State private var startFailure: String?
    @State private var finishing = false

    /// For the one hand-drawn translucent pane here: Reduce Transparency swaps
    /// the capsule's glass for an opaque backer on its own, but the transcript
    /// preview's custom `opacity(…)` fill it cannot see.
    @Environment(\.junoAccessibility) private var accessibility

    private var transcript: String { speech.transcript }

    private var averageLevel: Double {
        guard !speech.levelHistory.isEmpty else { return 0 }
        let sum = speech.levelHistory.reduce(0.0, +)
        return min(1.0, max(0.0, sum / Double(speech.levelHistory.count)))
    }

    var body: some View {
        VStack(spacing: 10) {
            if let startFailure {
                unavailable(startFailure)
            } else {
                transcriptPreview
                ZStack {
                    if !accessibility.reduceMotion {
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [
                                        Color.junoAccent.opacity(0.32 + averageLevel * 0.45),
                                        Color.junoAccent.opacity(0.08),
                                        Color.clear,
                                    ],
                                    center: .center,
                                    startRadius: 8,
                                    endRadius: 90
                                )
                            )
                            .frame(width: 260, height: 100)
                            .scaleEffect(1.0 + averageLevel * 0.32)
                            .animation(JunoMotion.reduced(JunoMotion.fast, when: accessibility.reduceMotion), value: averageLevel)
                    }
                    capsule
                }
            }
        }
        .task { await begin() }
        .accessibilityAddTraits(.isModal)
    }

    private var transcriptPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color.junoAccent)
                    .frame(width: 7, height: 7)
                    .opacity(speech.isListening ? 1 : 0.4)
                Text("Listening…")
                    .junoFont(size: 11, relativeTo: .caption, weight: .semibold)
                    .foregroundStyle(Color.junoAccent)
                    .textCase(.uppercase)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)

            ScrollView {
                Text(previewText)
                    .junoFont(size: 14, relativeTo: .body)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
            .frame(maxHeight: 100)
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.junoPopover.opacity(
                    accessibility.usesOpaqueTransientSurfaces ? 1 : 0.94
                ))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 0.75)
        )
        .shadow(color: Color.black.opacity(0.06), radius: 8, y: 3)
        .accessibilityLabel(transcript.isEmpty ? "Listening" : transcript)
        .accessibilityIdentifier("juno.desktop.dictation-preview")
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
        if !speech.finalizedText.isEmpty {
            result.append(AttributedString(" "))
        }
        var hypothesis = AttributedString(partial)
        hypothesis.foregroundColor = Color.junoMutedForeground
        result.append(hypothesis)
        return result
    }

    private var capsule: some View {
        HStack(spacing: 12) {
            circleButton(
                systemName: "xmark",
                label: "Cancel dictation",
                style: .outline,
                action: cancel
            )

            DesktopDictationMeter(levels: speech.levelHistory)
                .frame(maxWidth: .infinity)

            circleButton(
                systemName: "stop.fill",
                label: "Stop and edit",
                style: .neutral,
                glyphSize: 12,
                action: stop
            )

            circleButton(
                systemName: "arrow.up",
                label: "Send dictation",
                style: .accent,
                action: send
            )
            .disabled(transcript.isEmpty)
            .opacity(transcript.isEmpty ? 0.42 : 1)
        }
        .padding(.horizontal, 12)
        .frame(height: 60)
        .background(JunoGlassBackground(cornerRadius: 30))
        .overlay {
            Capsule()
                .strokeBorder(Color.junoHairline, lineWidth: 0.5)
        }
        .accessibilityIdentifier("juno.desktop.dictation")
    }

    private enum CircleStyle {
        case outline
        case neutral
        case accent
    }

    private func circleButton(
        systemName: String,
        label: String,
        style: CircleStyle,
        glyphSize: CGFloat = 14,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(systemImage: systemName)
                .junoFont(size: glyphSize, relativeTo: .body, weight: .semibold)
                .foregroundStyle(style == .accent ? Color.junoOnAccent : Color.junoForeground)
                .frame(width: 38, height: 38)
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
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(finishing)
        .accessibilityLabel(label)
    }

    private func unavailable(_ message: String) -> some View {
        HStack(spacing: 12) {
            JunoIconView(systemImage: "mic.slash")
                .junoFont(size: 15, relativeTo: .body)
                .foregroundStyle(Color.junoMutedForeground)
            Text(message)
                .junoBody()
                .foregroundStyle(Color.junoMutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
            circleButton(
                systemName: "xmark",
                label: "Close dictation",
                style: .outline,
                action: onCancel
            )
        }
        .padding(.leading, 18)
        .padding(.trailing, 12)
        .frame(height: 60)
        .background(JunoGlassBackground(cornerRadius: 30))
        .accessibilityIdentifier("juno.desktop.dictation-unavailable")
    }

    private func begin() async {
        guard await speech.requestPermission() else {
            startFailure =
                "Microphone or speech access was blocked — allow it in Privacy & Security to dictate."
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

private struct DesktopDictationMeter: View {
    let levels: [Double]

    private static let barCount = 38
    private static let barWidth: CGFloat = 3
    private static let spacing: CGFloat = 3
    private static let restingHeight: CGFloat = 4
    private static let maximumHeight: CGFloat = 26

    var body: some View {
        HStack(alignment: .center, spacing: Self.spacing) {
            ForEach(0..<Self.barCount, id: \.self) { index in
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.junoAccent.opacity(0.7 + level(at: index) * 0.3),
                                Color.primary.opacity(0.35 + level(at: index) * 0.5),
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

    private func height(at index: Int) -> CGFloat {
        Self.restingHeight
            + level(at: index) * (Self.maximumHeight - Self.restingHeight)
    }
}
