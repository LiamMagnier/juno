import AVFoundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

/// Settings › Voice (`sections/voice.tsx`): the voice Juno reads answers in,
/// with a preview, and a footnote on dictation and voice conversations — in
/// the Mac's true words for dictation.
struct DesktopSettingsVoicePane: View {
    let context: DesktopSettingsContext

    /// The web's `VOICE_PREVIEW_TEXT`.
    static let previewText = "Hi, I'm Juno. This is how I sound when I read an answer aloud."

    /// `src/lib/voices.ts`, verbatim.
    static let voices: [(id: String, label: String, description: String)] = [
        ("alloy", "Alloy", "Neutral and crisp"),
        ("echo", "Echo", "Even and measured"),
        ("fable", "Fable", "Bright and expressive"),
        ("onyx", "Onyx", "Low and steady"),
        ("nova", "Nova", "Rounded and friendly"),
        ("shimmer", "Shimmer", "Light and airy"),
        ("coral", "Coral", "Warm and lively"),
        ("verse", "Verse", "Animated and varied"),
        ("ballad", "Ballad", "Soft and unhurried"),
        ("ash", "Ash", "Firm and direct"),
        ("sage", "Sage", "Calm and level"),
        ("marin", "Marin", "Relaxed and conversational"),
        ("cedar", "Cedar", "Smooth and easy-going"),
    ]

    @State private var preview = DesktopVoicePreview()
    /// The web's `voiceSounds` preference: a per-device switch, like there.
    @AppStorage(JunoVoiceCues.defaultsKey) private var voiceSounds = true

    /// Whether the plan includes voice. Unknown until the usage route answers,
    /// and then the picker shows, as it always has on the Mac.
    private var planHasVoice: Bool {
        guard let plan = context.planID else { return true }
        return JunoAccountPlan(serverID: plan).includes(.voice)
    }

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            Section {
                if planHasVoice {
                    voiceRow(settings)
                } else {
                    DesktopSettingRow(title: "Voice", description: JunoPlanFeature.voice.upgradePrompt)
                }
            } header: {
                DesktopSettingsGroupHeader(title: "Read aloud")
            } footer: {
                Text(
                    "Dictation uses this Mac’s own speech recognition. "
                        + (planHasVoice
                            ? "Voice conversations are included in your plan."
                            : "Voice conversations need a plan with voice.")
                )
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, JunoSpace.snug)
            }

            Section {
                DesktopSettingToggleRow(
                    title: "Voice sounds",
                    description: "A soft chime when a call can hear you, and another when it ends. On this Mac.",
                    isOn: $voiceSounds,
                    identifier: "juno.desktop.settings.voice-sounds"
                )
            } header: {
                DesktopSettingsGroupHeader(title: "Voice conversations")
            }
        }
        .task { if context.plan.value == nil { await context.loadPlan() } }
        .onDisappear { preview.stop() }
    }

    private func voiceRow(_ settings: NativeAccountSettings) -> some View {
        let active = settings.voiceID ?? "alloy"
        let voice = Self.voices.first { $0.id == active }
        let playing = preview.playingID == active
        return DesktopSettingRow(
            title: "Voice",
            description: voice?.description ?? "A voice Juno for Mac does not list. Choosing one replaces it.",
            status: context.saves.status("voiceId")
        ) {
            HStack(spacing: JunoSpace.snug) {
                Button {
                    Task { await togglePreview(active) }
                } label: {
                    Group {
                        if preview.loadingID == active {
                            ProgressView().controlSize(.small)
                        } else {
                            JunoIconView(playing ? .stop : .play, size: 13)
                        }
                    }
                    .foregroundStyle(Color.junoForeground)
                    .frame(width: 28, height: 28)
                    .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
                    .contentShape(Circle())
                }
                .buttonStyle(.junoPress)
                .help(playing ? "Stop" : "Preview")
                .accessibilityLabel(playing ? "Stop the preview" : "Play a preview")
                .disabled(context.services.messageActions == nil)

                Picker("Read-aloud voice", selection: Binding(
                    get: { active },
                    set: { id in
                        guard id != active else { return }
                        preview.stop()
                        context.save("voiceId", NativeSettingsPatch(voiceID: .some(id)))
                    }
                )) {
                    if voice == nil { Text(active).tag(active) }
                    ForEach(Self.voices, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .tint(nil)
                .fixedSize()
                .accessibilityIdentifier("juno.desktop.settings.voice")
            }
        }
    }

    private func togglePreview(_ voiceID: String) async {
        if preview.playingID == voiceID || preview.loadingID == voiceID {
            preview.stop()
            return
        }
        guard let client = context.services.messageActions else { return }
        preview.stop()
        preview.loadingID = voiceID
        do {
            let audio = try await client.speech(text: Self.previewText, voiceID: voiceID, for: context.accountID)
            guard preview.loadingID == voiceID else { return }
            guard let audio else { throw CancellationError() }
            try preview.play(audio, id: voiceID)
        } catch {
            guard preview.loadingID == voiceID || preview.playingID == nil else { return }
            preview.stop()
            context.toasts.post(.error("Couldn’t play that preview."))
        }
    }
}

/// One voice sample at a time.
@MainActor
@Observable
final class DesktopVoicePreview: NSObject, AVAudioPlayerDelegate {
    var loadingID: String?
    private(set) var playingID: String?
    @ObservationIgnored private var player: AVAudioPlayer?

    func play(_ data: Data, id: String) throws {
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        self.player = player
        loadingID = nil
        playingID = id
        player.play()
    }

    func stop() {
        player?.stop()
        player = nil
        loadingID = nil
        playingID = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }
}
