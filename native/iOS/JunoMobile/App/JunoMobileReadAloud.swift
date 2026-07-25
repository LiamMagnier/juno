import AVFoundation
import JunoChatKit
import JunoCore
import Observation
import SwiftUI

/// **Read aloud** for one transcript at a time.
///
/// Two paths, and which one runs is the server's call rather than a preference:
///
/// 1. **The account's own voice**, from `POST /api/voice/tts` — the same voice
///    the website reads with, so an answer sounds the same wherever it is heard.
/// 2. **The device synthesiser**, when that route answers 501. That status is
///    the documented "no TTS configured here" and the web falls back the same
///    way; treating it as an error would mean the feature simply does not exist
///    on a self-hosted deployment.
///
/// One speaker per chat screen, and starting a second reading stops the first.
/// Two answers talking over each other is the failure mode a per-row player
/// would have — and the reason this is a screen-level object rather than state
/// inside the message row.
@MainActor
@Observable
final class JunoMobileReadAloud: NSObject {
    /// The message currently being read, if any.
    private(set) var speakingMessageID: String?
    /// Set while the audio is being fetched, so the button can show it is
    /// working — server TTS is a round trip, unlike the device synthesiser.
    private(set) var preparingMessageID: String?
    private(set) var lastErrorDescription: String?

    private let client: NativeMessageActionsClient?
    private let accountID: AccountID?
    private var player: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()
    private var fetchTask: Task<Void, Never>?

    init(client: NativeMessageActionsClient?, accountID: AccountID?) {
        self.client = client
        self.accountID = accountID
        super.init()
        synthesizer.delegate = self
    }

    func isSpeaking(_ messageID: String) -> Bool { speakingMessageID == messageID }
    func isPreparing(_ messageID: String) -> Bool { preparingMessageID == messageID }

    /// Toggles: reading the message that is already being read stops it.
    func toggle(messageID: String, text: String, voiceID: String?) {
        if speakingMessageID == messageID || preparingMessageID == messageID {
            stop()
            return
        }
        stop()
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        lastErrorDescription = nil

        guard let client, let accountID else {
            speakOnDevice(spoken, messageID: messageID)
            return
        }
        preparingMessageID = messageID
        fetchTask = Task {
            do {
                let audio = try await client.speech(
                    text: spoken, voiceID: voiceID, for: accountID
                )
                guard !Task.isCancelled, preparingMessageID == messageID else { return }
                preparingMessageID = nil
                if let audio {
                    play(audio, messageID: messageID)
                } else {
                    // 501 — this deployment has no server TTS.
                    speakOnDevice(spoken, messageID: messageID)
                }
            } catch {
                guard !Task.isCancelled, preparingMessageID == messageID else { return }
                preparingMessageID = nil
                // The device synthesiser is a genuine answer to "read this to
                // me", so a failed fetch falls back rather than reporting. The
                // reason is kept for anything that wants to show it.
                lastErrorDescription = error.localizedDescription
                speakOnDevice(spoken, messageID: messageID)
            }
        }
    }

    func stop() {
        fetchTask?.cancel()
        fetchTask = nil
        preparingMessageID = nil
        player?.stop()
        player = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        speakingMessageID = nil
        deactivateSession()
    }

    // MARK: - Playback

    private func play(_ audio: Data, messageID: String) {
        do {
            // `.playback` with `.spokenAudio`: this is speech the reader asked
            // for, so it belongs in the same category as a podcast — it plays on
            // the silent switch and ducks nothing it should not.
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(data: audio)
            player.delegate = self
            guard player.play() else { throw ReadAloudError.playbackRefused }
            self.player = player
            speakingMessageID = messageID
        } catch {
            lastErrorDescription = error.localizedDescription
            speakingMessageID = nil
            deactivateSession()
        }
    }

    private func speakOnDevice(_ text: String, messageID: String) {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal: the synthesiser still speaks, it just may not duck.
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        speakingMessageID = messageID
        synthesizer.speak(utterance)
    }

    /// Handing the session back is what lets music resume after a reading. Never
    /// throws upward: failing to deactivate is not something a reader can act on.
    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation
        )
    }

    private enum ReadAloudError: LocalizedError {
        case playbackRefused
        var errorDescription: String? { "The audio could not be played." }
    }
}

// Both delegates are called off the main actor; hop before touching state.
extension JunoMobileReadAloud: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor [weak self] in self?.finish() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_: AVAudioPlayer, error: (any Error)?) {
        Task { @MainActor [weak self] in self?.finish() }
    }
}

extension JunoMobileReadAloud: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _: AVSpeechSynthesizer, didFinish _: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in self?.finish() }
    }

    nonisolated func speechSynthesizer(
        _: AVSpeechSynthesizer, didCancel _: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in self?.finish() }
    }
}

private extension JunoMobileReadAloud {
    func finish() {
        player = nil
        speakingMessageID = nil
        deactivateSession()
    }
}
