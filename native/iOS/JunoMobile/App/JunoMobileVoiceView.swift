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
    /// Files the spoken turns into a chat. Nil where nothing can be saved — an
    /// unconfigured shell — in which case the dock says so on the way out rather
    /// than dropping the conversation in silence.
    let saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?
    /// Drops the session from the shell. Called once the transcript is filed, or
    /// straight away when there is nothing to file.
    let close: () -> Void

    init(
        controller: JunoRealtimeVoiceController,
        saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?,
        close: @escaping () -> Void
    ) {
        self.controller = controller
        self.saveTranscript = saveTranscript
        self.close = close
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

    @State private var isSaving = false
    @State private var saveError: String?
    @State private var camera = JunoMobileVoiceCamera()
    @State private var screenShare = JunoMobileVoiceScreenShare()
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var controller: JunoRealtimeVoiceController { session.controller }

    var body: some View {
        VStack(spacing: 8) {
            if let message = failureMessage {
                failureBanner(message)
            }
            if let notice = controller.notice {
                Label(notice, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(Color.junoCaution)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
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
        // Ends the call when the chat goes — another section, or a sign-out —
        // because the alternative is an open microphone with nothing on screen
        // saying so. It deliberately does **not** start one: `start()` is legal
        // from `ended`, so a dock that dialled on appearance would silently
        // redial every time the reader came back to Chat.
        .onDisappear {
            camera.stop()
            screenShare.stop()
            controller.end()
        }
        .accessibilityIdentifier("juno.mobile.voice")
    }

    private var pill: some View {
        HStack(spacing: 0) {
            status
            controls
            #if os(iOS)
            speakerButton
            cameraButton
            screenShareButton
            #endif
            optionsMenu
            hangUpButton
        }
        .padding(4)
        .modifier(JunoGlassCapsule())
    }

    /// A camera that could not start says so where the call's other notices
    /// appear, and offers the only fix that works for a refusal.
    private func cameraNotice(_ message: String) -> some View {
        VStack(spacing: 8) {
            Label(message, systemImage: "video.slash")
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
                .font(.system(size: 14, weight: .medium))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .modifier(JunoGlassCapsule())
        .accessibilityIdentifier("juno.mobile.voice-camera-unavailable")
    }

    private func screenShareNotice(_ message: String) -> some View {
        Label(message, systemImage: "rectangle.dashed.badge.record")
            .font(.caption)
            .foregroundStyle(Color.junoCaution)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
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
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1)
                .contentTransition(.opacity)
            if let costLabel {
                Text(costLabel)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
        }
        .frame(width: 96, height: 34, alignment: .leading)
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
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
        VStack(spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(Color.junoCaution)
                .multilineTextAlignment(.center)

            // A save that failed is a conversation that exists nowhere — the
            // relay does not keep it — so this offers Retry and Discard rather
            // than closing, and the transcript is still in the controller behind
            // it. The Mac has no equivalent; it should.
            if saveError != nil {
                HStack(spacing: 14) {
                    Button("voice.save.retry") { hangUp() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                    Button("voice.save.discard") { session.close() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.junoMutedForeground)
                }
                .font(.system(size: 14, weight: .medium))
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
                .font(.system(size: 14, weight: .medium))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .modifier(JunoGlassCapsule())
        .accessibilityIdentifier("juno.mobile.voice-failure")
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        if isRestartable {
            circleButton(
                systemImage: "arrow.clockwise",
                label: "voice.start-again",
                identifier: "juno.mobile.voice-restart",
                tone: .prominent
            ) {
                saveError = nil
                Task { await controller.start() }
            }
        } else {
            // Barge-in, offered only while there is something to interrupt. A
            // permanently disabled glyph sitting through every pause is chrome
            // that means nothing.
            if controller.assistantSpeaking, session.isLive {
                // The label names the barge-in mode, because this control is the
                // one place the fact is about. Under `.automatic` the tap is a
                // shortcut for something a reader can also just do by talking;
                // under `.manualOnly` — which is what a phone reports, since the
                // voice-processing unit is only asked for on the Mac — it is the
                // only way, and saying so stops "talking over Juno does nothing"
                // reading as a bug.
                circleButton(
                    systemImage: "stop.fill",
                    label: controller.bargeIn == .automatic
                        ? "voice.interrupt.or-talk"
                        : "voice.interrupt",
                    identifier: "juno.mobile.voice-interrupt",
                    tone: .prominent
                ) {
                    controller.interrupt()
                }
                .transition(.scale.combined(with: .opacity))
            }
            circleButton(
                systemImage: controller.muted ? "mic.slash.fill" : "mic.fill",
                label: controller.muted ? "voice.unmute" : "voice.mute",
                identifier: "juno.mobile.voice-mute",
                tone: controller.muted ? .prominent : .quiet
            ) {
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
            systemImage: controller.speakerOutput
                ? "speaker.wave.2.fill" : "iphone.gen3.radiowaves.left.and.right",
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
                // Camera is the OS's affordance and keeps the OS's glyph — the
                // rule on ``JunoIcon`` names it explicitly.
                systemImage: camera.isLive ? "video.slash.fill" : "video.fill",
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
                systemImage: screenShare.isLive
                    ? "rectangle.inset.filled" : "rectangle.dashed.badge.record",
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
                Label("voice.camera.unsupported", systemImage: "video.slash")
            }
            Section("voice.provider") {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        if session.isLive {
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
                    .disabled(session.isLive && provider == controller.provider)
                }
            }
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.primary.opacity(0.75))
                .frame(width: 34, height: 34)
                .frame(width: 38, height: 44)
                .contentShape(Rectangle())
        }
        .tint(Color.primary)
        .accessibilityLabel("voice.options")
        .accessibilityIdentifier("juno.mobile.voice-provider")
    }

    private var hangUpButton: some View {
        Button {
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
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.junoCanvas)
                }
            }
            .frame(width: 34, height: 34)
            .background(Color.junoDanger, in: Circle())
            .frame(width: 38, height: 44)
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
        systemImage: String,
        label: LocalizedStringKey,
        identifier: String,
        tone: ControlTone,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(
                    tone == .prominent ? AnyShapeStyle(.background) : AnyShapeStyle(.primary)
                )
                .frame(width: 34, height: 34)
                .background(
                    tone == .prominent ? Color.primary : Color.primary.opacity(0.08),
                    in: Circle()
                )
                // The same 44pt-tall target the composer's own controls carry.
                .frame(width: 38, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Hang up

    /// Hang up, then file the conversation.
    ///
    /// **In that order, and the order is the point.** `end()` first, so the
    /// microphone and the socket are down the instant the reader asks — waiting
    /// on a network round trip with a live mic is the one thing a hang-up must
    /// never do. The save then runs against the transcript the controller
    /// already holds, and the dock stays up with a spinner while it does,
    /// because closing first would leave a failed save with nowhere to report.
    private func hangUp() {
        camera.stop()
        controller.end()
        guard let saveTranscript = session.saveTranscript, !savableTurns.isEmpty else {
            session.close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            let saved = await saveTranscript(
                JunoMobileVoiceTranscript(sessionID: session.id, turns: savableTurns)
            )
            isSaving = false
            guard saved != nil else {
                saveError = String(localized: "voice.save.failed")
                return
            }
            session.close()
        }
    }

    /// The finished lines, in order.
    ///
    /// Non-final lines are dropped: they are live hypotheses the recognizer is
    /// still rewriting, and saving one puts a half-heard sentence into the
    /// reader's permanent history. This filter is the whole reason the doc
    /// comment above existed — and until now it was only the doc comment. The
    /// Mac has always filtered; the phone was quietly persisting hypotheses.
    private var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !text.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: text
            )
        }
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
            withAnimation(JunoMotion.reduced(.easeOut(duration: 0.36), when: reduceMotion)) {
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
