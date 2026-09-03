import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
import UIKit

/// One spoken conversation, handed to the chat column through the environment.
///
/// A `@MainActor` class rather than a struct of closures, for two reasons. The
/// identity is what lets SwiftUI tell one call from the next without comparing
/// closures it cannot compare; and a globally-isolated class is `Sendable`
/// whatever it stores, which the same fields in a struct are not.
///
/// It travels through the environment because the composer is several files
/// below the shell that authorizes a session — the chat screen in between owns
/// neither and should not have to carry it.
@MainActor
@Observable
final class JunoMobileVoiceSession: Identifiable {
    /// Stable for the life of this call. The save route is idempotent per
    /// session, so a retry after a dropped network updates the same conversation
    /// instead of creating a second one.
    let id = UUID()
    /// When the call began. It exists to date the transient rows in
    /// ``liveMessages(conversationID:)`` with something that does not change on
    /// every read — see the note there.
    let startedAt = Date()
    let controller: JunoRealtimeVoiceController
    let accountID: AccountID
    /// Authenticated durable document retrieval for files shared during Voice.
    /// Nil only in the unauthenticated preview shell, where the file action is
    /// not offered.
    let attachmentContextClient: NativeVoiceAttachmentContextClient?
    /// Files the spoken turns into a chat. Nil where nothing can be saved — an
    /// unconfigured shell — in which case the dock says so on the way out rather
    /// than dropping the conversation in silence.
    let saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?
    /// Drops the session from the shell. Called once the transcript is filed, or
    /// straight away when there is nothing to file.
    let close: () -> Void
    /// The camera and the screen share, owned by the call rather than by the
    /// dock, so the full-screen mode and the dock show the same picture and
    /// neither can start a second capture the other cannot see.
    let camera = JunoMobileVoiceCamera()
    let screenShare = JunoMobileVoiceScreenShare()
    /// Interruptions and route changes, watched for the life of the call.
    let audioSession: JunoMobileVoiceAudioSession
    /// Whether the full-screen mode is showing over the chat.
    var isFullScreen = false
    /// Set by the dock while it files the transcript; read by both surfaces.
    var isSaving = false
    var saveError: String?

    init(
        controller: JunoRealtimeVoiceController,
        accountID: AccountID,
        attachmentContextClient: NativeVoiceAttachmentContextClient?,
        saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?,
        close: @escaping () -> Void
    ) {
        self.controller = controller
        self.accountID = accountID
        self.attachmentContextClient = attachmentContextClient
        self.saveTranscript = saveTranscript
        self.close = close
        self.audioSession = JunoMobileVoiceAudioSession(controller: controller)
    }

    /// Hang up, then file the conversation.
    ///
    /// **In that order, and the order is the point.** `end()` first, so the
    /// microphone and the socket are down the instant the reader asks — waiting
    /// on a network round trip with a live mic is the one thing a hang-up must
    /// never do. The save then runs against the transcript the controller
    /// already holds, and the dock stays up with a spinner while it does,
    /// because closing first would leave a failed save with nowhere to report.
    func hangUp() {
        camera.stop()
        screenShare.stop()
        isFullScreen = false
        controller.end()
        guard let saveTranscript, !savableTurns.isEmpty else {
            close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            let saved = await saveTranscript(
                JunoMobileVoiceTranscript(sessionID: id, turns: savableTurns)
            )
            isSaving = false
            guard saved != nil else {
                saveError = String(localized: "voice.save.failed")
                return
            }
            close()
        }
    }

    /// The finished lines, in order. Non-final lines are dropped: they are
    /// live hypotheses the recognizer is still rewriting, and saving one puts a
    /// half-heard sentence into the reader's permanent history.
    var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !text.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                attachmentIDs: line.attachmentIDs
            )
        }
    }

    /// True once audio is actually flowing. The one test worth sharing: the
    /// composer routes a typed turn through the relay only from here, and the
    /// dock offers barge-in only from here.
    var isLive: Bool { controller.phase == .live }

    /// **The call as it is being spoken, as ordinary chat messages.**
    ///
    /// The web's `voiceMessages` (`chat-view.tsx`), ported: spoken turns are
    /// appended after the persisted ones and rendered as ordinary bubbles,
    /// marked still-streaming until the recognizer settles them. There is no
    /// transcript pane on either client, and this is why — the words belong in
    /// the conversation they are part of, in the same shapes as everything else
    /// in it.
    ///
    /// **These rows are transient and must stay that way.** Nothing here writes
    /// to the store; ``JunoMobileVoiceDock`` files the finished turns on hang-up
    /// and a second writer would give the reader the conversation twice.
    ///
    /// A line is opened the instant a turn begins and carries no text for a
    /// beat, so blank ones are dropped rather than flickering an empty bubble
    /// ahead of every sentence.
    ///
    /// - Parameter conversationID: The chat these turns will eventually be filed
    ///   into. Empty from the home screen, where the call has no conversation
    ///   yet and the save route makes one. Nothing on screen reads it — the row
    ///   needs the field, not the value.
    func liveMessages(conversationID: String = "") -> [NativeChatMessage] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return NativeChatMessage(
                id: "voice-\(line.id.uuidString)",
                conversationID: conversationID,
                clientID: nil,
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                reasoning: nil,
                model: nil,
                // One date for the whole call rather than `Date()` per read.
                // This is rebuilt several times a second while someone is
                // talking, and a field that changes on every rebuild makes every
                // row differ from itself.
                createdAt: startedAt,
                revision: 0,
                // The web's `streaming: !line.final`. A non-final line is a live
                // hypothesis being rewritten, not something that was said.
                isPending: !line.final
            )
        }
    }
}

extension EnvironmentValues {
    /// The call in progress, if there is one. Nil is the normal state and means
    /// "this is an ordinary chat" — every voice-mode degradation in the composer
    /// keys off exactly this.
    @Entry var junoVoiceSession: JunoMobileVoiceSession?
}

/// **The voice dock** — a compact pill directly above the composer, inside the
/// chat, while a spoken conversation runs.
///
/// What this replaces was a `fullScreenCover`: a screen with its own aura, its
/// own transcript pane and its own three buttons. Taking the whole screen took
/// the chat with it — the message list, the composer, and with the composer
/// every attachment control — so "show Juno this photo while we talk" was not
/// something the app could express. Voice is a **layer over the normal chat**
/// here, exactly as it is on the web (`chat-view.tsx`), and the camera, the
/// photo picker and the text field all keep working for free. That is most of
/// the images-in-voice feature, and none of it is new code.
///
/// There is no orb and no transcript pane. The dock kept the words — what is
/// happening and what it costs — and gave the picture to ``JunoVoiceAura``,
/// which the composer mounts behind itself: a field spread across the column is
/// legible at arm's length and asks for none of your attention, while an orb
/// small enough to sit in a pill can only ever be decoration. The pane is gone
/// because the spoken turns now appear in the chat behind this, as ordinary
/// bubbles — see ``JunoMobileVoiceSession/liveMessages(conversationID:)``. Until
/// they did, this doc comment was the only place the transcript existed.
///
/// Two things here have no counterpart on the web and are kept because they are
/// better: the speaker/receiver toggle, which only a phone needs, and the
/// Retry/Discard recovery on a failed save — the relay keeps nothing, so a
/// dropped save is a conversation that no longer exists anywhere.
struct JunoMobileVoiceDock: View {
    let session: JunoMobileVoiceSession

    @AppStorage(JunoMobilePreferences.voicePushToTalk) private var pushToTalk = false
    @State private var muteHaptic = JunoMobileHapticTrigger()
    @State private var endHaptic = JunoMobileHapticTrigger()
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var controller: JunoRealtimeVoiceController { session.controller }
    private var camera: JunoMobileVoiceCamera { session.camera }
    private var screenShare: JunoMobileVoiceScreenShare { session.screenShare }
    private var isSaving: Bool { session.isSaving }
    private var saveError: String? { session.saveError }

    var body: some View {
        VStack(spacing: JunoSpace.snug) {
            if let message = failureMessage {
                failureBanner(message)
            }
            if let notice = controller.notice {
                JunoIconLabel(verbatim: notice, icon: .error, size: 14)
                    .font(.caption)
                    .foregroundStyle(Color.junoCaution)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .modifier(JunoGlassCapsule())
            }
            if let message = camera.unavailability?.message {
                cameraNotice(message)
            }
            if let message = screenShare.message {
                screenShareNotice(message)
            }
            JunoMobileVoiceSelfView(camera: camera) { camera.stop() }
            pill
        }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
            value: controller.assistantSpeaking
        )
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: camera.phase)
        // A camera outlives nothing. The moment the audio stops being live —
        // hang-up, session limit, a dropped socket — the frames have nowhere to
        // go, and a preview still running past the end of the call would be the
        // app filming for no one.
        .onChange(of: session.isLive) { _, live in
            if !live {
                camera.stop()
                screenShare.stop()
            }
        }
        // The call survives the dock. It used to end here — on navigating to
        // another section, or on the chat re-rendering underneath — which is
        // how "I opened Projects for a second" hung up on people. The
        // microphone is not left unannounced: the shell keeps the session
        // published and the system's own recording indicator stays lit. Only
        // the camera stops, because a preview with nobody watching is the
        // app filming for no one. Hang-up and sign-out are the two ends.
        .onDisappear {
            camera.stop()
            screenShare.stop()
        }
        .junoHaptic(JunoMobileHaptic.mute, trigger: muteHaptic)
        .junoHaptic(JunoMobileHaptic.stop, trigger: endHaptic)
        .sensoryFeedback(JunoMobileHaptic.connect, trigger: session.isLive) { _, live in live }
        // Swipe up on the dock opens the full-screen mode.
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard value.translation.height < -50,
                        abs(value.translation.height) > abs(value.translation.width)
                    else { return }
                    withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) {
                        session.isFullScreen = true
                    }
                }
        )
        .accessibilityIdentifier("juno.mobile.voice")
    }

    /// A phone holds status, mute, camera, full screen, options and hang up:
    /// 112pt of words and five 44pt targets, which is what a 402pt screen
    /// has room for. Speaker and screen share move into the options menu
    /// there — with a provider that can see, the eight-control pill ran to
    /// 420pt, and `safeAreaBar` widened the whole chat column to carry it,
    /// so the transcript behind the call was clipped on both sides. iPad
    /// keeps every control in the pill.
    private var showsEveryControl: Bool { sizeClass == .regular }

    private var pill: some View {
        HStack(spacing: 0) {
            status
            controls
            #if os(iOS)
            if showsEveryControl { speakerButton }
            cameraButton
            if showsEveryControl { screenShareButton }
            #endif
            expandButton
            optionsMenu
            hangUpButton
        }
        .padding(JunoSpace.hairline)
        .modifier(JunoGlassCapsule())
    }

    /// A camera that could not start says so where the call's other notices
    /// appear, and offers the only fix that works for a refusal.
    private func cameraNotice(_ message: String) -> some View {
        VStack(spacing: JunoSpace.snug) {
            JunoIconLabel(verbatim: message, icon: .photos, size: 14)
                .font(.caption)
                .foregroundStyle(Color.junoCaution)
                .multilineTextAlignment(.center)
            if camera.unavailability?.isRecoverableInSettings == true {
                Button("attachments.camera.open-settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                .contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .modifier(JunoGlassCapsule())
        .accessibilityIdentifier("juno.mobile.voice-camera-unavailable")
    }

    private func screenShareNotice(_ message: String) -> some View {
        JunoIconLabel(verbatim: message, icon: .artifactsTool, size: 14)
            .font(.caption)
            .foregroundStyle(Color.junoCaution)
            .multilineTextAlignment(.center)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .modifier(JunoGlassCapsule())
            .accessibilityIdentifier("juno.mobile.voice-screen-share-unavailable")
    }

    // MARK: - Words

    /// Status and cost, in a fixed-width column.
    ///
    /// Fixed so that a status changing length — "Listening" to "Juno is
    /// speaking" — cannot slide every control sideways mid-sentence, and held to
    /// the control row's height so the cost line cannot grow the pill. The cost
    /// carries no live announcement: it reprices every few seconds and would
    /// talk over the conversation it is measuring.
    private var status: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(statusTitle)
                .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                .lineLimit(1)
                .contentTransition(.opacity)
            if let costLabel {
                Text(costLabel)
                    .junoFont(size: 11, relativeTo: .caption2)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
        }
        .frame(width: 96, height: 34, alignment: .leading)
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.hairline)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityHint(bargeInHint)
    }

    /// Which barge-in mode this call is actually in, said where the Mac says it.
    ///
    /// `DesktopVoice` puts the same sentence in the status tooltip. A phone has no
    /// tooltip, so it goes on the status element's hint — the label itself is
    /// 96pt and fixed, and a status that grew to explain itself would slide every
    /// control in the pill sideways mid-sentence.
    ///
    /// **It is worth saying on a phone now that it can differ from call to call.**
    /// Whether talking over Juno interrupts it is a fact about this device's audio
    /// hardware and never a preference: the voice-processing unit is requested on
    /// iOS as well as macOS, and a route that cannot host it — some Bluetooth HFP
    /// headsets, a session another app is holding — drops the same phone back to
    /// manual. Without a canceller the microphone hears the speakers, so acting on
    /// it would be a call that interrupts itself on its own first syllable.
    ///
    /// Empty rather than absent off a live call: applying the modifier
    /// conditionally would change the view's identity every time the phase moved,
    /// and `Text(verbatim:)` keeps the placeholder out of the strings catalog.
    private var bargeInHint: Text {
        guard session.isLive else { return Text(verbatim: "") }
        return controller.bargeIn == .automatic
            ? Text("voice.barge-in.automatic")
            : Text("voice.barge-in.manual")
    }

    /// The web's ladder, so the phone and the browser describe the same call in
    /// the same words.
    private var statusTitle: LocalizedStringKey {
        switch controller.phase {
        case .idle, .connecting: "voice.status.connecting"
        case .reconnecting: "voice.status.reconnecting"
        case .error: "voice.status.unavailable"
        case .ended: "voice.status.session-ended"
        case .live: liveStatusTitle
        }
    }

    /// The three states a live call is actually in, where
    /// ``JunoRealtimeVoiceController/Phase/live`` is one.
    ///
    /// `interrupting` earns its own line: it is the round trip between the
    /// interrupt going out and the relay confirming it dropped the turn, and the
    /// speakers are already silent for it. Left saying "Juno is speaking" it
    /// reads as an interruption that was ignored, which is what someone
    /// concludes when they tap the button and the words do not change.
    private var liveStatusTitle: LocalizedStringKey {
        if controller.sessionPhase == .interrupting { return "voice.status.interrupting" }
        if controller.assistantSpeaking { return "voice.status.speaking" }
        return controller.muted ? "voice.status.muted" : "voice.status.listening"
    }

    /// Relay list prices, not billing — hence the tilde. The relay owns the
    /// provider connection and the per-provider rates, so this is shown as it
    /// arrives rather than estimated here from elapsed wall time.
    private var costLabel: String? {
        guard let usage = controller.usage, usage.estCostUsd > 0 else { return nil }
        return "~" + Self.usd(usage.estCostUsd)
    }

    /// `formatUsd` from `src/lib/utils.ts`, digit for digit. A session that has
    /// cost a tenth of a cent has to read as a tenth of a cent on both clients,
    /// or one of them looks like it is charging differently.
    private static func usd(_ amount: Double) -> String {
        guard amount.isFinite, amount > 0 else { return "$0" }
        if amount < 0.0001 { return "<$0.0001" }
        if amount < 0.01 { return String(format: "$%.4f", amount) }
        if amount < 1 { return String(format: "$%.3f", amount) }
        return String(format: "$%.2f", amount)
    }

    /// Why the call is not running, or why the last one could not be filed. A
    /// failed save wins: it is the only one of the two that still has something
    /// to lose.
    private var failureMessage: String? {
        if saveError != nil { return saveError }
        switch controller.phase {
        case .error(let error): return error.errorDescription
        case .ended(let reason):
            return switch reason {
            case .sessionLimit: String(localized: "voice.ended.limit")
            case .provider: String(localized: "voice.ended.provider")
            case .error: String(localized: "voice.ended.error")
            case .client: nil
            }
        default: return nil
        }
    }

    /// Failures speak rather than hide in a tooltip: the line names the fix, and
    /// the control that applies it sits with it.
    @ViewBuilder
    private func failureBanner(_ message: String) -> some View {
        VStack(spacing: JunoSpace.snug) {
            JunoIconLabel(verbatim: message, icon: .error, size: 14)
                .font(.caption)
                .foregroundStyle(Color.junoCaution)
                .multilineTextAlignment(.center)

            // A save that failed is a conversation that exists nowhere — the
            // relay does not keep it — so this offers Retry and Discard rather
            // than closing, and the transcript is still in the controller behind
            // it. The Mac has no equivalent; it should.
            if saveError != nil {
                HStack(spacing: JunoSpace.regular) {
                    Button("voice.save.retry") { session.hangUp() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                    .contentShape(.rect)
                    Button("voice.save.discard") { session.close() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.junoMutedForeground)
                    .contentShape(.rect)
                }
                .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                .accessibilityIdentifier("juno.mobile.voice-save-error")
            } else if case .error(let error) = controller.phase, error.isPermissionDenial {
                // A denied microphone is fixed in Settings and never by trying
                // again — the system will not re-prompt — so this is the one
                // failure that offers a deep link instead of a restart.
                Button("voice.open-settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                .contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .modifier(JunoGlassCapsule())
        .accessibilityIdentifier("juno.mobile.voice-failure")
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        if isRestartable {
            circleButton(
                icon: .refresh,
                label: "voice.start-again",
                identifier: "juno.mobile.voice-restart",
                tone: .prominent
            ) {
                session.saveError = nil
                Task { await controller.start() }
            }
        } else {
            circleButton(
                icon: .mic,
                label: controller.muted ? "voice.unmute" : "voice.mute",
                identifier: "juno.mobile.voice-mute",
                tone: controller.muted ? .prominent : .quiet
            ) {
                muteHaptic.fire()
                controller.setMuted(!controller.muted)
            }
            .disabled(!session.isLive)
        }
    }

    /// Restart is offered from a finished or failed session — except after a
    /// refusal, where ``failureBanner(_:)`` offers Settings instead.
    private var isRestartable: Bool {
        switch controller.phase {
        case .ended: true
        case .error(let error): !error.isPermissionDenial
        default: false
        }
    }

    #if os(iOS)
    /// Speaker vs. receiver. Routing only, so it can be flipped mid-sentence —
    /// and the one control on this dock a desktop has no use for.
    private var speakerButton: some View {
        circleButton(
            icon: .volume,
            label: controller.speakerOutput ? "voice.speaker.on" : "voice.speaker.off",
            identifier: "juno.mobile.voice-speaker",
            tone: .quiet
        ) {
            controller.toggleSpeaker()
        }
    }

    /// **Show Juno what you are looking at.**
    ///
    /// Present only where the provider can actually see. The gate is
    /// `videoInput`, not `screenInput` — a camera frame and a screen are two
    /// different permissions on the relay, and OpenAI takes the first and
    /// refuses the second, so this control is offered on providers where the
    /// Mac's screen share is not. When the gate is closed the button is not
    /// drawn dim, it is not drawn at all, and ``optionsMenu`` says why in the
    /// one place someone would go looking.
    @ViewBuilder
    private var cameraButton: some View {
        if canSee {
            circleButton(
                icon: .photos,
                label: camera.isLive ? "voice.camera.stop" : "voice.camera.start",
                identifier: "juno.mobile.voice-camera",
                tone: camera.isLive ? .prominent : .quiet
            ) {
                toggleCamera()
            }
            .disabled(!session.isLive || camera.isBusy)
            .transition(.scale.combined(with: .opacity))
        }
    }

    /// Shares the visible iPhone app surface through the same provider video
    /// input used by the camera. Camera and screen share are mutually exclusive
    /// in the dock so there is one clear privacy indicator at a time.
    @ViewBuilder
    private var screenShareButton: some View {
        if canSee {
            circleButton(
                icon: .artifactsTool,
                label: screenShare.isLive
                    ? "Stop screen sharing" : "Start screen sharing",
                identifier: "juno.mobile.voice-screen-share",
                tone: screenShare.isLive ? .prominent : .quiet
            ) {
                toggleScreenShare()
            }
            .disabled(!session.isLive || screenShare.isBusy)
            .transition(.scale.combined(with: .opacity))
        }
    }
    #endif

    /// Whether this call's provider accepts pictures at all.
    private var canSee: Bool { controller.capabilities?.videoInput == true }

    private func toggleCamera() {
        if camera.isLive {
            camera.stop()
        } else {
            Task { await camera.start(sending: controller) }
        }
    }

    private func toggleScreenShare() {
        if screenShare.isLive {
            screenShare.stop()
        } else {
            camera.stop()
            Task { await screenShare.start(sending: controller) }
        }
    }

    /// Providers are not interchangeable — some do true speech-to-speech, some
    /// need this client's own transcript, and only some can see — so the choice
    /// stays visible rather than being an account setting made once and
    /// forgotten. Switching while live goes over the open socket: the relay keeps
    /// the conversation, so the audio path never comes down.
    private var optionsMenu: some View {
        Menu {
            // Not a disabled button: a switch that cannot move still reads as a
            // setting, and the reason it cannot move is the useful part — and
            // the fix, switching provider, is the very next section.
            if !canSee {
                JunoIconLabel("voice.camera.unsupported", icon: .photos)
            }
            Section("voice.provider") {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        controller.switchProvider(provider)
                    } label: {
                        if provider == controller.provider {
                            JunoIconLabel(verbatim: provider.displayName, icon: .check)
                        } else {
                            Text(provider.displayName)
                        }
                    }
                    .disabled(provider == controller.provider)
                }
            }
            #if os(iOS)
            // The two controls a phone's pill has no room for; see `pill`.
            if !showsEveryControl {
                Section {
                    Button {
                        controller.toggleSpeaker()
                    } label: {
                        JunoIconLabel(
                            controller.speakerOutput ? "voice.speaker.on" : "voice.speaker.off",
                            icon: .volume
                        )
                    }
                    if canSee {
                        Button {
                            toggleScreenShare()
                        } label: {
                            JunoIconLabel(
                                screenShare.isLive ? "Stop screen sharing" : "Start screen sharing",
                                icon: .artifactsTool
                            )
                        }
                        .disabled(!session.isLive || screenShare.isBusy)
                    }
                }
            }
            #endif
            Section {
                Toggle(isOn: $pushToTalk) {
                    Label("Push to talk", systemImage: "hand.tap")
                }
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) {
                        session.isFullScreen = true
                    }
                } label: {
                    Label("Full screen", systemImage: "arrow.up.left.and.arrow.down.right")
                }
            }
        } label: {
            // An ellipsis, not a chevron: beside the full-screen chevron a
            // second one read as "collapse", and it opened a menu.
            JunoIconView(.ellipsis, size: 15)
                .foregroundStyle(Color.primary.opacity(0.75))
                .frame(width: 34, height: 34)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .tint(Color.primary)
        .accessibilityLabel("voice.options")
        .accessibilityIdentifier("juno.mobile.voice-provider")
    }

    /// Opens the full-screen mode — the orb, captions, and the controls at
    /// thumb height. The same call, seen rather than heard past.
    private var expandButton: some View {
        circleButton(
            icon: .chevronUp,
            label: "Full screen",
            identifier: "juno.mobile.voice-expand",
            tone: .quiet
        ) {
            withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) {
                session.isFullScreen = true
            }
        }
    }

    private var hangUpButton: some View {
        Button {
            endHaptic.fire()
            hangUp()
        } label: {
            // `junoDanger` rather than `Color.red`, and `junoCanvas` rather than
            // `.white` on top of it. The ramp's red is the one this product uses
            // for a failed run and a destructive confirm, so the hang-up matches
            // them; and a hard white glyph clears AA on the light red (6.3:1)
            // but only reaches 2.8:1 on the *dark* appearance's lifted red,
            // which is exactly the case the ramp lifts for. The canvas colour
            // inverts with the appearance, so it is near-white on the dark red
            // and near-black on the light one: 5.8:1 and 6.4:1.
            Group {
                if isSaving {
                    ProgressView().tint(Color.junoCanvas)
                } else {
                    JunoIconView(.close, size: 15)
                        .foregroundStyle(Color.junoCanvas)
                }
            }
            .frame(width: 34, height: 34)
            .background(Color.junoDanger, in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .accessibilityLabel("voice.end")
        .accessibilityIdentifier("juno.mobile.voice-end")
    }

    private enum ControlTone {
        case quiet
        case prominent
    }

    private func circleButton(
        icon: JunoIcon,
        label: LocalizedStringKey,
        identifier: String,
        tone: ControlTone,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 15)
                .foregroundStyle(
                    tone == .prominent ? AnyShapeStyle(.background) : AnyShapeStyle(.primary)
                )
                .frame(width: 34, height: 34)
                .background(
                    tone == .prominent ? Color.primary : Color.primary.opacity(0.08),
                    in: Circle()
                )
                // The same 44pt-tall target the composer's own controls carry.
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Hang up

    /// Hang up, then file the conversation — see ``JunoMobileVoiceSession/hangUp()``.
    private func hangUp() {
        session.hangUp()
    }
}

/// The field, in a view of its own.
///
/// A leaf, so that `level` — which the controller republishes about thirty times
/// a second — invalidates one `Canvas` and nothing else. Read from the
/// composer's body instead, the same property would re-measure the text field,
/// the chips and the whole control row on every audio frame.
///
/// **The box is the whole design here.** ``JunoVoiceAura`` derives everything —
/// how far the band climbs, how high the two arms reach — from the rectangle it
/// is handed, so a field given the composer's own strip draws two flames beside
/// the text field, and one given the column draws light around the conversation.
/// The web sizes it `min(30rem, 46vh)` of the chat column and anchors it a
/// little below the column's bottom (`.voice-aura`, `globals.css`); this takes
/// the same fractions of the column's measured height.
struct JunoMobileVoiceField: View {
    let controller: JunoRealtimeVoiceController
    /// The chat column's own height, measured by the screen that owns it. Zero
    /// only for the frame or two before the first geometry callback.
    var columnHeight: CGFloat = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    /// `height: min(30rem, 46vh)`, in order.
    private static let maximumHeight: CGFloat = 480
    private static let columnShare: CGFloat = 0.46
    /// `bottom: -1.25rem`: the band's core sits just below the column so what
    /// shows is light spilling up it rather than a bright rule across its foot.
    private static let underhang: CGFloat = 20
    /// Before the column has been measured. Deliberately the strip this replaced
    /// rather than zero: a host that forgets to pass a height should look like
    /// the old build, not like a broken one.
    private static let unmeasuredHeight: CGFloat = 260

    private var height: CGFloat {
        guard columnHeight > 0 else { return Self.unmeasuredHeight }
        return min(Self.maximumHeight, columnHeight * Self.columnShare)
    }

    var body: some View {
        JunoVoiceAura(
            level: controller.level,
            speaking: controller.assistantSpeaking,
            active: controller.phase == .live || controller.phase == .reconnecting
        )
        .frame(height: height)
        // Negative, so the aura keeps its full height while the box the layout
        // sees ends 20pt higher — bottom-aligned, that hangs the band below the
        // composer exactly as the web's negative `bottom` does.
        .padding(.bottom, -Self.underhang)
        // `voice-aura-in`: arriving mid-sentence is worse than arriving late, so
        // the field fades up instead of appearing at full strength the frame the
        // socket opens. Reduce Motion keeps the field and drops only the fade —
        // a live microphone has to stay visible.
        .opacity(appeared ? 1 : 0)
        .task {
            withAnimation(
                JunoMotion.reduced(
                    JunoMotion.outSoft(JunoMotion.Duration.slow), when: reduceMotion
                )
            ) {
                appeared = true
            }
        }
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
