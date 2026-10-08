import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

/// A dictation in progress: the recognizer, and where it stands (§5.8,
/// Dictating).
///
/// A reference type because two slots of the one shell read it — the field
/// slot shows the words, the controls row shows the meter and the exits — and
/// `@State` cannot span two siblings. The composer owns exactly one while the
/// reader is dictating and drops it when they stop, which is what tears the
/// recognizer down.
@MainActor
@Observable
final class ComposerDictationSession {
    enum Phase: Equatable {
        /// Asking for permission and starting the recognizer.
        case starting
        case listening
        /// Could not start, and why. The words go in the field slot, where
        /// the reader is looking.
        case failed(String)
        /// Cancelled, stopped or sent: nothing more will arrive.
        case finished
    }

    let speech = JunoSpeechService()
    private(set) var phase: Phase = .starting

    /// Whether the microphone or recognizer was refused rather than failing
    /// some other way — the one failure the status names.
    private(set) var wasDenied = false

    func begin() async {
        guard phase == .starting else { return }
        guard await speech.requestPermission() else {
            wasDenied = true
            phase = .failed(
                "Alevr needs the microphone and speech recognition to dictate. Allow them in Privacy & Security, then try again."
            )
            return
        }
        // Cancelled while the permission prompt was up.
        guard phase == .starting else { return }
        do {
            try speech.start()
            phase = .listening
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// Throws away everything heard.
    func cancel() {
        phase = .finished
        speech.cancel()
    }

    /// Stops listening and returns what was heard.
    func finish() -> String {
        phase = .finished
        return speech.stopAndFreeze()
    }

    var isListening: Bool { phase == .listening }

    var hasWords: Bool {
        !speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - The field slot

/// The words being heard, where the draft's words were (§5.8).
///
/// Same inset, same 15pt body rung as the draft field — it *is* the field
/// slot — so the cross-fade reads as the field changing what it holds, not as
/// a panel replacing it. The web's version was a floating capsule with a coral
/// radial glow, an uppercase "LISTENING…" eyebrow and a 38-bar gradient
/// spectrum; the replacement is the object the reader was already typing in.
///
/// Final text is in the foreground ink, the recognizer's live hypothesis in
/// secondary: it is still being rewritten, and full strength would claim it
/// was said. A long dictation keeps its **newest** words on screen — the lines
/// are cut from the head — because the end of the sentence is the part being
/// checked while it is spoken.
struct ComposerDictationField: View {
    let session: ComposerDictationSession

    var body: some View {
        text
            .junoType(.body)
            .lineLimit(8)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("juno.desktop.dictation-preview")
    }

    @ViewBuilder
    private var text: some View {
        switch session.phase {
        case .failed(let message):
            Text(message)
                .foregroundStyle(Color.junoSecondaryInk)
        default:
            let final = session.speech.finalizedText.trimmingCharacters(in: .whitespaces)
            let partial = session.speech.partialText.trimmingCharacters(in: .whitespaces)
            if final.isEmpty, partial.isEmpty {
                // The web's words.
                Text("Speak now.")
                    .foregroundStyle(Color.junoSecondaryInk)
            } else if partial.isEmpty {
                Text(final)
                    .foregroundStyle(Color.junoForeground)
            } else {
                let separator = final.isEmpty ? "" : " "
                Text("\(final)\(separator)\(Text(partial).foregroundStyle(Color.junoSecondaryInk))")
                    .foregroundStyle(Color.junoForeground)
            }
        }
    }

    private var accessibilityText: String {
        if case .failed(let message) = session.phase { return message }
        let transcript = session.speech.transcript
        return transcript.isEmpty ? "Listening" : transcript
    }
}

// MARK: - The controls row

/// The controls row while dictating: ✕ where `+` was, the meter and what it
/// is doing, then Done and the send disc where the disc was (§5.8).
///
/// The row keeps the composer's own geometry, so the swap moves nothing but
/// what the controls say: the ✕ lands exactly on the `+`, and the disc is the
/// same 28pt circle in the same place.
struct ComposerDictationControls<Disc: View>: View {
    let session: ComposerDictationSession
    let cancel: () -> Void
    let stop: () -> Void
    @ViewBuilder let disc: () -> Disc

    var body: some View {
        HStack(spacing: JunoComposerMetrics.controlSpacing) {
            Button(action: cancel) {
                JunoIconView(session.wasDenied ? .micOff : .close, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(ComposerControlStyle())
            .help("Cancel  esc")
            .accessibilityLabel("Cancel dictation")
            .accessibilityIdentifier("juno.desktop.dictation-cancel")

            HStack(spacing: JunoSpace.snug) {
                if session.phase != .finished, !isFailed {
                    ComposerLevelMeter(level: session.speech.level, active: session.isListening)
                }
                if let status {
                    Text(status)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
            }
            .padding(.leading, JunoSpace.tight)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)

            Spacer(minLength: JunoSpace.snug)

            Button(action: stop) {
                Label {
                    Text("Done")
                } icon: {
                    JunoIconView(.check, size: 14, weight: .bold)
                }
                .labelStyle(.titleAndIcon)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .padding(.horizontal, JunoSpace.snug)
                .frame(height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
            }
            .buttonStyle(ComposerControlStyle())
            .disabled(!session.isListening)
            .help("Stop and edit")
            .accessibilityLabel("Stop dictation and edit the text")
            .accessibilityIdentifier("juno.desktop.dictation-stop")

            disc()
        }
    }

    private var isFailed: Bool {
        if case .failed = session.phase { true } else { false }
    }

    /// The one status word, which never claims more than is known: "Listening"
    /// only while the microphone is open.
    private var status: String? {
        switch session.phase {
        case .listening: "Listening"
        case .failed: session.wasDenied ? "Microphone blocked" : nil
        case .starting, .finished: nil
        }
    }
}

// MARK: - Level meter

/// Five bars reading one number (§5.8): the microphone is hearing you.
///
/// Five gains on one scalar, not a pretend spectrum — the 38 bars this replaced
/// drew one loudness number 38 times, in a coral-to-ink gradient. Staggered
/// gains make five bars read as a needle with weight; identical bars would read
/// as a broken equaliser. Monochrome, 3pt capsules, 6 to 18pt tall.
///
/// Shared by dictation and the call bar, which both have exactly this one
/// fact to show. Under Reduce Motion the bars rest at their floor and only the
/// ink says whether the microphone is live: that it hears you is state, the
/// bouncing is decoration.
struct ComposerLevelMeter: View {
    /// 0…1.
    let level: Double
    let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let gains: [Double] = [0.55, 0.8, 1, 0.8, 0.55]
    static let barWidth: CGFloat = 3
    static let minimumHeight: CGFloat = 6
    static let maximumHeight: CGFloat = 18
    /// Below this is room tone: the meter must be still in a quiet room.
    static let noiseFloor: Double = 0.035

    /// A bar's height for a level — pure, so it can be checked without a view.
    static func height(level: Double, gain: Double) -> CGFloat {
        let heard = level < noiseFloor ? 0 : min(1, max(0, level))
        return minimumHeight + CGFloat(heard * gain) * (maximumHeight - minimumHeight)
    }

    var body: some View {
        HStack(spacing: Self.barWidth) {
            ForEach(Self.gains.indices, id: \.self) { index in
                Capsule()
                    .fill(active ? Color.junoForeground : Color.junoSecondaryInk.opacity(0.5))
                    .frame(
                        width: Self.barWidth,
                        height: reduceMotion || !active
                            ? Self.minimumHeight
                            : Self.height(level: level, gain: Self.gains[index])
                    )
            }
        }
        .frame(height: Self.maximumHeight)
        // Republished about thirty times a second: an animation restarted that
        // often never arrives anywhere, so the bars follow the level directly.
        .animation(nil, value: level)
        .accessibilityHidden(true)
    }
}
