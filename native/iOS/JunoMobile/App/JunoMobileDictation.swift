import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
#if DEBUG
  import JunoPreviewSupport
#endif

/// Dictate Mode: the composer, listening.
///
/// **What this replaced.** A floating capsule that took the composer's place: a
/// different shape, a different material, a coral radial glow scaling behind
/// it, a 32-bar gradient meter, an uppercase "LISTENING…" eyebrow with a dot,
/// and the transcript floating in a second card above. Two new objects for one
/// fact — the microphone is on — and the words you were saying were in neither
/// of the places you were looking.
///
/// **What it is now** is the website's `ComposerDictation` with the iPhone's
/// ChatGPT/Claude feel: the same card as the composer (same glass, same 24pt
/// radius, same field inset, same 44pt row), so the swap reads as the field
/// changing what it holds rather than something arriving.
///
///     ┌─────────────────────────────────────────┐
///     │ The words, as they are heard…           │   the field slot
///     │ ✕   ▁▂▅▇▅▂▁▂▃▅▃▂ live waveform    ✓   ↑  │   the row
///     └─────────────────────────────────────────┘
///
/// - The words land **in the field**, final in full ink, the live hypothesis
///   in secondary until it settles, newest line pinned in view.
/// - The row is a live waveform that flows from the right as you speak, with
///   the three exits at the composer's own positions: ✕ discards (where `+`
///   was), ✓ puts the words in the field to edit, ↑ sends (where Send is).
/// - The card's edge carries the voice light in your ink, the same light a
///   call draws, rising with your voice and leaving the moment you finish.
///
/// Reduce Motion: the waveform holds still at rest height and only the edge
/// light's static pose says the microphone is live; the swap is a fade.
struct JunoMobileDictation: View {
    /// The words already typed, shown ahead of the live ones so the field does
    /// not appear to empty as the microphone opens. Not part of the transcript
    /// handed back — the composer appends to its own draft.
    var draft: String = ""
    /// Discard and return to typing.
    let onCancel: () -> Void
    /// Finish and hand the transcript to the composer for editing.
    let onStop: (String) -> Void
    /// Finish and send immediately.
    let onSend: (String) -> Void

    @State private var speech = JunoSpeechService()
    @State private var startFailure: String?
    @State private var finishing = false
    @State private var haptic = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    static let cornerRadius: CGFloat = 24

    private var transcript: String {
        speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var listening: Bool { speech.isListening && !finishing && startFailure == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            field
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.comfy)
                .padding(.bottom, JunoSpace.tight)
            row
                .padding(.horizontal, JunoSpace.tight)
                .padding(.bottom, JunoSpace.tight)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoGlass(in: RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .overlay {
            JunoVoiceGlow(
                mode: listening ? .you : .off,
                you: { [speech] in speech.loudness },
                cornerRadius: Self.cornerRadius
            )
        }
        .sensoryFeedback(.impact(weight: .light), trigger: haptic)
        .task { await begin() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Dictation")
        .accessibilityIdentifier("juno.mobile.dictation")
    }

    // MARK: - The field slot

    private var field: some View {
        ScrollView {
            fieldText
                .junoFont(size: 17, relativeTo: .body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: transcript)
        }
        .defaultScrollAnchor(.bottom)
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        // Six lines, the text field's own ceiling: a long take scrolls inside
        // the card rather than pushing the conversation off the screen.
        .frame(maxHeight: 132)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(accessibilityTranscript)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("juno.mobile.dictation-preview")
    }

    private var fieldText: Text {
        if let startFailure {
            return Text(startFailure).foregroundStyle(Color.junoSecondaryInk)
        }
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let lead = typed.isEmpty
            ? Text(verbatim: "")
            : Text(verbatim: "\(typed) ").foregroundStyle(Color.junoSecondaryInk)
        let final = speech.finalizedText.trimmingCharacters(in: .whitespaces)
        let partial = speech.partialText.trimmingCharacters(in: .whitespaces)
        if final.isEmpty, partial.isEmpty {
            return typed.isEmpty
                ? Text("Speak now, in any language.").foregroundStyle(Color.junoSecondaryInk)
                : lead
        }
        let separator = final.isEmpty || partial.isEmpty ? "" : " "
        return Text("\(lead)\(Text(verbatim: final).foregroundStyle(Color.junoForeground))\(separator)\(Text(verbatim: partial).foregroundStyle(Color.junoSecondaryInk))")
    }

    private var accessibilityTranscript: Text {
        if let startFailure { return Text(startFailure) }
        return transcript.isEmpty ? Text("Listening") : Text(verbatim: transcript)
    }

    // MARK: - The row

    private var row: some View {
        HStack(spacing: JunoSpace.tight) {
            Button(action: cancel) {
                JunoIconView(.close, size: 19)
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.junoQuietPress)
            .accessibilityLabel("Cancel dictation")
            .accessibilityIdentifier("juno.mobile.dictation-cancel")

            if startFailure == nil {
                JunoMobileDictationWaveform(samples: speech.loudnessHistory, active: listening)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .transition(.opacity.combined(with: .scale(scale: 0.6, anchor: .leading)))

                Button(action: stop) {
                    JunoIconView(.check, size: 17, weight: .bold)
                        .foregroundStyle(Color.primary)
                        .frame(width: 36, height: 36)
                        .modifier(JunoComposerGlassCircle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(finishing)
                .accessibilityLabel("Stop and edit")
                .accessibilityIdentifier("juno.mobile.dictation-stop")

                Button(action: send) {
                    JunoIconView(.arrowUp, size: 18, weight: .bold)
                        .foregroundStyle(canSend ? Color.junoCanvas : Color.junoSecondaryInk)
                        .frame(width: 36, height: 36)
                        .modifier(JunoComposerSendBackground(active: canSend, tint: Color.primary))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .animation(JunoMotion.reduced(JunoMotion.sendMorph, when: reduceMotion, tier: .tint), value: canSend)
                .accessibilityLabel("Send dictation")
                .accessibilityIdentifier("juno.mobile.dictation-send")
            } else {
                Spacer(minLength: 0)
                Button {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                } label: {
                    Text("Open Settings")
                        .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, JunoSpace.regular)
                        .frame(height: 36)
                        .modifier(JunoGlassCapsule())
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.dictation-settings")
            }
        }
    }

    private var canSend: Bool { !transcript.isEmpty && !finishing }

    // MARK: - Actions

    private func begin() async {
        #if DEBUG
            // `--juno-preview-dictation idle|listening|transcribed`: a take with
            // no microphone behind it, for screenshots on a simulator.
            if let state = JunoComposerPreviewFlags.value("--juno-preview-dictation") {
                switch state {
                case "idle":
                    speech.beginPreviewSession(speaking: false)
                case "transcribed":
                    speech.beginPreviewSession(
                        final: "Can you move the design review to Thursday afternoon and",
                        partial: "let the team know"
                    )
                    speech.seedPreviewHistory()
                default:
                    speech.beginPreviewSession(final: "", partial: "Move the design review to")
                    speech.seedPreviewHistory(phase: 1.3)
                }
                return
            }
        #endif
        guard await speech.requestPermission() else {
            startFailure = String(localized: "Alevr needs the microphone and speech recognition to dictate. Allow them in Settings.")
            return
        }
        do {
            try speech.start()
        } catch {
            startFailure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func cancel() {
        finishing = true
        haptic += 1
        speech.cancel()
        onCancel()
    }

    private func stop() {
        finishing = true
        haptic += 1
        onStop(speech.stopAndFreeze())
    }

    private func send() {
        finishing = true
        haptic += 1
        let text = speech.stopAndFreeze()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onCancel()
            return
        }
        onSend(text)
    }
}

/// The live waveform: your voice over the last second and a half, flowing in
/// from the right, one bar per meter tick.
///
/// Bars rather than a line because a bar per moment is what the eye reads as
/// "this is being recorded" (Voice Memos, ChatGPT, Claude), and because a
/// still room has to look still: below speech loudness a bar sits at its
/// floor, so the row only moves when you do. The oldest bars fade at the
/// leading edge instead of being cut off.
struct JunoMobileDictationWaveform: View {
    /// Speech loudness, 0...1, newest last.
    let samples: [Double]
    let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let barWidth: CGFloat = 3
    static let gap: CGFloat = 3
    static let minimumHeight: CGFloat = 3
    static let maximumHeight: CGFloat = 26

    /// A sample's bar height. Below the floor is a room, not a voice; above
    /// it a soft curve, so a word's onset rises rather than switching on.
    static func height(for loudness: Double) -> CGFloat {
        let floor = 0.14
        guard loudness > floor else { return minimumHeight }
        let x = min(1, (loudness - floor) / (0.82 - floor))
        return minimumHeight + CGFloat(pow(x, 0.85)) * (maximumHeight - minimumHeight)
    }

    var body: some View {
        Canvas { context, size in
            let pitch = Self.barWidth + Self.gap
            let count = max(1, Int((size.width + Self.gap) / pitch))
            let recent = Array(samples.suffix(count))
            let ink = active ? Color.primary : Color.junoSecondaryInk.opacity(0.6)
            let midY = size.height / 2
            for slot in 0..<count {
                // Right-aligned: the newest sample sits against the ✓.
                let sampleIndex = recent.count - count + slot
                let loudness = sampleIndex >= 0 && !reduceMotion && active ? recent[sampleIndex] : 0
                let height = Self.height(for: loudness)
                let x = CGFloat(slot) * pitch
                let rect = CGRect(x: x, y: midY - height / 2, width: Self.barWidth, height: height)
                // The leading quarter fades out, so the past leaves softly.
                let fade = min(1, Double(slot) / max(1, Double(count) * 0.25))
                context.fill(
                    Path(roundedRect: rect, cornerRadius: Self.barWidth / 2),
                    with: .color(ink.opacity(0.25 + 0.75 * fade))
                )
            }
        }
        .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("Dictation waveform") {
    VStack(spacing: JunoSpace.section) {
        JunoMobileDictationWaveform(
            samples: (0..<48).map { 0.3 + 0.5 * abs(sin(Double($0) / 3)) }, active: true
        )
        .frame(height: 44)
        JunoMobileDictationWaveform(samples: [], active: true).frame(height: 44)
    }
    .padding()
    .background(Color.junoCanvas)
}
#endif
