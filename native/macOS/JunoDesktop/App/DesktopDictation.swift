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

    private var transcript: String { speech.transcript }

    var body: some View {
        VStack(spacing: 10) {
            if let startFailure {
                unavailable(startFailure)
            } else {
                transcriptPreview
                capsule
            }
        }
        .task { await begin() }
        .accessibilityAddTraits(.isModal)
    }

    private var transcriptPreview: some View {
        ScrollView {
            Text(previewText)
                .font(.system(size: 14))
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
        }
        .frame(maxHeight: 112)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.junoPopover.opacity(0.94))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.junoHairline, lineWidth: 0.75)
        )
        .accessibilityLabel(transcript.isEmpty ? "Listening" : transcript)
        .accessibilityIdentifier("juno.desktop.dictation-preview")
    }

    private var previewText: AttributedString {
        guard !transcript.isEmpty else {
            var listening = AttributedString("Listening…")
            listening.foregroundColor = Color.junoMutedForeground.opacity(0.65)
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
            Image(systemName: systemName)
                .font(.system(size: glyphSize, weight: .semibold))
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
            Image(systemName: "mic.slash")
                .font(.system(size: 15))
                .foregroundStyle(Color.junoMutedForeground)
            Text(message)
                .font(.system(size: 13))
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
    private static let barWidth: CGFloat = 2.5
    private static let spacing: CGFloat = 3
    private static let restingHeight: CGFloat = 4
    private static let maximumHeight: CGFloat = 24

    var body: some View {
        HStack(alignment: .center, spacing: Self.spacing) {
            ForEach(0..<Self.barCount, id: \.self) { index in
                Capsule()
                    .fill(Color.primary.opacity(0.35 + level(at: index) * 0.5))
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
