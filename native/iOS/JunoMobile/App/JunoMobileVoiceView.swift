import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
import UIKit

/// **Voice mode** — a spoken conversation with Juno.
///
/// The whole realtime stack already existed: `JunoRealtimeVoiceController` owns
/// the socket, the audio engine, the PCM conversion, the reconnect and the
/// on-device recognizer some providers need. What it had was **no caller**. The
/// composer's primary action has offered a voice glyph since it was written, but
/// only `if let openVoiceMode` — and nothing in the app ever passed one, so the
/// button silently fell through to a disabled Send. That is the bug this screen
/// closes: it is the missing half, not a new feature.
///
/// The screen deliberately draws almost nothing. A voice conversation is heard,
/// not read, so the only things on it are:
///
/// - **The aura** (``JunoVoiceAura``), driven by
///   ``JunoRealtimeVoiceController/level`` — one number, because only one party
///   holds the floor at a time. It is the meter that tells someone their
///   microphone is muted rather than broken, and its colour is who is talking.
/// - **The transcript**, which is the record, and the one thing worth scrolling.
/// - **Three controls**: mute, interrupt, hang up.
///
/// Errors are split the way the controller splits them. A denied microphone
/// offers Settings and *not* Retry — the system will never re-prompt, so a retry
/// button there is a button that cannot work.
struct JunoMobileVoiceView: View {
    @Bindable var controller: JunoRealtimeVoiceController
    /// Files the spoken turns into a chat. Nil where nothing can be saved — an
    /// unconfigured shell — in which case the screen says so on the way out
    /// rather than dropping the conversation in silence.
    var saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?
    /// Called when the reader hangs up. The sheet's dismissal is the caller's to
    /// arrange, so the session can be torn down before the screen goes.
    let close: () -> Void

    /// Stable for the life of this call. The save route is idempotent per
    /// session, so a retry after a dropped network updates the same conversation
    /// instead of creating a second one.
    @State private var sessionID = UUID()
    @State private var isSaving = false
    @State private var saveError: String?
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            header
            Spacer(minLength: 0)
            status
            Spacer(minLength: 0)
            transcript
            controls
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(alignment: .bottom) {
            // Behind the whole screen, never over it. The transcript and the
            // three controls have to stay readable at full amplitude — this
            // reports state, it does not compete for the surface.
            JunoVoiceAura(
                level: controller.level,
                speaking: controller.assistantSpeaking,
                active: isLive
            )
            .frame(height: 320)
        }
        .background(Color.junoCanvas)
        .task {
            // Started from here, not from the caller: the session's lifetime is
            // this screen's lifetime, and starting it before the screen exists
            // would bring an audio engine up behind a sheet that has not
            // appeared yet.
            await controller.start()
        }
        .onDisappear { controller.end() }
        .accessibilityIdentifier("juno.mobile.voice")
    }

    private var isLive: Bool {
        controller.phase == .live || controller.phase == .reconnecting
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            providerMenu
            Spacer(minLength: 0)
            #if os(iOS)
            Button {
                controller.toggleSpeaker()
            } label: {
                Image(
                    systemName: controller.speakerOutput
                        ? "speaker.wave.2.fill" : "iphone.gen3.radiowaves.left.and.right"
                )
                .font(.system(size: 15))
                .foregroundStyle(Color.primary.opacity(0.75))
                .frame(width: 36, height: 36)
                .modifier(JunoGlassCircle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                controller.speakerOutput ? "voice.speaker.on" : "voice.speaker.off"
            )
            #endif
            Button(action: close) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .frame(width: 36, height: 36)
                    .modifier(JunoGlassCircle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("voice.close")
            .accessibilityIdentifier("juno.mobile.voice-close")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    /// Providers are not interchangeable — some do true speech-to-speech, some
    /// need this client's own transcript — so the choice stays visible rather
    /// than being an account setting made once and forgotten. Switching while
    /// live goes over the open socket: the relay keeps the conversation, so the
    /// audio path never comes down.
    private var providerMenu: some View {
        Menu {
            ForEach(JunoVoiceProvider.allCases) { provider in
                Button {
                    if isLive {
                        controller.switchProvider(provider)
                    } else {
                        Task { await controller.start(provider: provider) }
                    }
                } label: {
                    if provider == controller.provider {
                        Label(provider.displayName, systemImage: "checkmark")
                    } else {
                        Text(provider.displayName)
                    }
                }
            }
        } label: {
            JunoMobileMetaChip(
                title: controller.provider.displayName,
                systemImage: "waveform"
            )
        }
        .tint(Color.primary)
        .accessibilityLabel("voice.provider")
        .accessibilityIdentifier("juno.mobile.voice-provider")
    }

    // MARK: - Status

    @ViewBuilder
    private var status: some View {
        VStack(spacing: 8) {
            Text(statusTitle)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.primary)
                .contentTransition(.opacity)

            if let detail = statusDetail {
                Text(detail)
                    .font(.system(size: 13))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.junoMutedForeground)
                    .padding(.horizontal, 32)
            }

            if let notice = controller.notice {
                Label(notice, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            // A save that failed is a conversation that exists nowhere — the
            // relay does not keep it. So this offers Retry and Discard rather
            // than dismissing, and the transcript is still on screen behind it.
            if let saveError {
                VStack(spacing: 8) {
                    Label(saveError, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                    HStack(spacing: 14) {
                        Button("voice.save.retry") { hangUp() }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.junoAccent)
                        Button("voice.save.discard") { close() }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.junoMutedForeground)
                    }
                    .font(.system(size: 14, weight: .medium))
                }
                .padding(.horizontal, 32)
                .accessibilityIdentifier("juno.mobile.voice-save-error")
            }

            recovery
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var statusTitle: LocalizedStringKey {
        switch controller.phase {
        case .idle: "voice.status.starting"
        case .connecting: "voice.status.connecting"
        case .reconnecting: "voice.status.reconnecting"
        case .ended: "voice.status.ended"
        case .error: "voice.status.failed"
        case .live:
            controller.assistantSpeaking
                ? "voice.status.speaking"
                : (controller.muted ? "voice.status.muted" : "voice.status.listening")
        }
    }

    private var statusDetail: String? {
        switch controller.phase {
        case .error(let error): error.errorDescription
        case .ended(let reason):
            switch reason {
            case .sessionLimit: String(localized: "voice.ended.limit")
            case .provider: String(localized: "voice.ended.provider")
            case .error: String(localized: "voice.ended.error")
            case .client: nil
            }
        default: usageLine
        }
    }

    /// The relay is the only honest source for cost — it owns the provider
    /// connection and the per-provider pricing — so this is shown verbatim
    /// rather than estimated from elapsed wall time.
    private var usageLine: String? {
        guard let usage = controller.usage else { return nil }
        let spoken = Int((usage.audioInSec + usage.audioOutSec).rounded())
        guard spoken > 0 else { return nil }
        let cost = usage.estCostUsd
        let money = cost >= 0.01
            ? String(format: "$%.2f", cost)
            : String(format: "$%.3f", cost)
        return "\(spoken)s · \(money)"
    }

    /// The one distinction that matters in a failure: a denied permission is
    /// fixed in Settings and never by trying again.
    @ViewBuilder
    private var recovery: some View {
        switch controller.phase {
        case .error(let error) where error.isPermissionDenial:
            Button("voice.open-settings") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                openURL(url)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .padding(.top, 4)
        case .error, .ended:
            Button("voice.start-again") {
                Task { await controller.start() }
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .padding(.top, 4)
            .accessibilityIdentifier("juno.mobile.voice-restart")
        default:
            EmptyView()
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        if !controller.transcript.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(controller.transcript) { line in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(
                                    line.role == .user
                                        ? "voice.speaker.you" : "voice.speaker.juno"
                                )
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .kerning(0.4)
                                .foregroundStyle(Color.junoMutedForeground.opacity(0.65))
                                Text(line.text)
                                    .font(.system(size: 15))
                                    .lineSpacing(2)
                                    // A live hypothesis is not yet a claim about
                                    // what was said, and it is rewritten in place
                                    // several times a second. Dimming it is what
                                    // stops the reader trusting a half-heard word.
                                    .foregroundStyle(
                                        line.final ? Color.primary : Color.primary.opacity(0.55)
                                    )
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .id(line.id)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                }
                .frame(maxHeight: 220)
                .scrollIndicators(.hidden)
                .mask(
                    // The fade is what lets the transcript end without a hard
                    // edge against the controls beneath it.
                    LinearGradient(
                        colors: [.clear, .black, .black],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .onChange(of: controller.transcript.last?.id) { _, id in
                    guard let id else { return }
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
            .accessibilityIdentifier("juno.mobile.voice-transcript")
        }
    }

    // MARK: - Controls

    private var controls: some View {
        HStack(spacing: 18) {
            circleButton(
                systemImage: controller.muted ? "mic.slash.fill" : "mic.fill",
                label: controller.muted ? "voice.unmute" : "voice.mute",
                identifier: "juno.mobile.voice-mute",
                tint: controller.muted ? Color.orange : Color.primary.opacity(0.8)
            ) {
                controller.setMuted(!controller.muted)
            }
            .disabled(!isLive)

            // Barge-in. Only offered while there is something to interrupt —
            // a disabled hand glyph sitting there through every pause is chrome
            // that means nothing.
            if controller.assistantSpeaking {
                circleButton(
                    systemImage: "hand.raised.fill",
                    label: "voice.interrupt",
                    identifier: "juno.mobile.voice-interrupt",
                    tint: Color.primary.opacity(0.8)
                ) {
                    controller.interrupt()
                }
                .transition(.scale.combined(with: .opacity))
            }

            Button {
                hangUp()
            } label: {
                Group {
                    if isSaving {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 62, height: 62)
                .background(Color.red, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityLabel("voice.end")
            .accessibilityIdentifier("juno.mobile.voice-end")
        }
        .padding(.top, 16)
        .padding(.bottom, 28)
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
            value: controller.assistantSpeaking
        )
    }

    /// Hang up, then file the conversation.
    ///
    /// **In that order, and the order is the point.** `end()` first, so the
    /// microphone and the socket are down the instant the reader asks — waiting
    /// for a network round trip with a live mic is the one thing a hang-up button
    /// must never do. The save then runs against the transcript the controller
    /// already holds, and the screen stays up with a spinner while it does,
    /// because dismissing first would leave a failed save with nowhere to report.
    ///
    /// A failure keeps the screen open with Retry rather than discarding: the
    /// relay does not keep the transcript, so a dropped save is a conversation
    /// that no longer exists anywhere.
    private func hangUp() {
        controller.end()
        guard let saveTranscript, !savableTurns.isEmpty else {
            close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            let saved = await saveTranscript(
                JunoMobileVoiceTranscript(sessionID: sessionID, turns: savableTurns)
            )
            isSaving = false
            guard saved != nil else {
                saveError = String(localized: "voice.save.failed")
                return
            }
            close()
        }
    }

    /// The finished lines, in order.
    ///
    /// Non-final lines are dropped: they are live hypotheses the recognizer is
    /// still rewriting, and saving one puts a half-heard sentence into the
    /// reader's permanent history. The web applies the same filter before it
    /// posts.
    private var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: text
            )
        }
    }

    private func circleButton(
        systemImage: String,
        label: LocalizedStringKey,
        identifier: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18))
                .foregroundStyle(tint)
                .frame(width: 54, height: 54)
                .modifier(JunoGlassCircle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// One voice call's worth of transcript, ready to be filed.
///
/// The session id travels with it because the save is idempotent per session:
/// a retry after a dropped network has to be recognised as the *same* save, or
/// the reader ends up with the conversation twice.
struct JunoMobileVoiceTranscript {
    let sessionID: UUID
    let turns: [NativeVoiceTranscriptClient.Turn]
}

