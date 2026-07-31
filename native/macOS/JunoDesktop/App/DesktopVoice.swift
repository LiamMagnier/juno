import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoVoiceKit
import SwiftUI

/// One spoken conversation, owned by the screen that started it.
///
/// `id` doubles as the save's idempotency key. It used to be `@State` on the
/// voice view, which was safe only while that view was a sheet — a sheet is
/// created once and lives exactly as long as its session. The dock that replaced
/// it lives inside the chat column and can be rebuilt underneath a call (a
/// draft becoming a conversation is enough), and a fresh `sessionID` there would
/// file a retried save as a second conversation. Held here, it cannot move.
struct DesktopVoiceSession: Identifiable {
    let id = UUID()
    let controller: JunoRealtimeVoiceController
    let modelID: String
    let conversationID: String?
    let projectID: String?
}

enum DesktopVoiceError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "Voice transcript saving is unavailable for this account."
    }
}

/// Account-owned authorization adapter for the shared realtime audio engine.
///
/// The app supplies the bearer-authenticated request sender; JunoVoiceKit never
/// reaches into Keychain or creates a second backend client.
struct JunoDesktopVoiceAuthorization: JunoVoiceRelayAuthorizing {
    let sender: any NativeAuthenticatedRequestSending
    let accountID: AccountID

    func relayToken() async throws -> JunoVoiceRelayToken {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/relay-token",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw JunoDesktopVoiceAuthorizationError(
                message: serverMessage(response.body)
                    ?? fallbackMessage(statusCode: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            JunoVoiceRelayTokenResponse.self,
            from: response.body
        ), !decoded.token.isEmpty else {
            throw JunoDesktopVoiceAuthorizationError(
                message: "Juno returned an invalid voice credential."
            )
        }
        return decoded.resolved
    }

    private func serverMessage(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        if let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        if let error = object["error"] as? String,
            !error.isEmpty, !error.contains("_")
        {
            return error
        }
        return nil
    }

    private func fallbackMessage(statusCode: Int) -> String {
        switch statusCode {
        case 401: "Sign in again to start voice."
        case 402, 403: "Voice is not available on this account or plan."
        case 429: "Voice is busy. Wait a moment and try again."
        case 503: "Realtime voice is not configured for this environment."
        default: "Juno could not authorize the voice session."
        }
    }
}

private struct JunoDesktopVoiceAuthorizationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Everything a chat column needs to host a call in place: the session itself,
/// and the two things only the screen above knows — where a finished transcript
/// is filed, and what "close" means afterwards.
///
/// The two sites route a saved call differently on purpose. Chat passes the open
/// `conversationID` and selects the conversation the turns landed in; Projects
/// always passes `nil` and opens whatever the server created. They are not
/// unified here because they are not the same behaviour.
struct DesktopVoiceColumn {
    let sessionID: UUID
    let controller: JunoRealtimeVoiceController
    let saveTranscript:
        (UUID, [NativeVoiceTranscriptClient.Turn]) async throws -> String
    let close: () -> Void
}

extension View {
    /// Mounts a live call around this composer: the field behind it, the dock
    /// directly above it.
    ///
    /// Applied to the composer rather than to the screen, because the field has
    /// to be scoped to the chat column. A background on the window would wash
    /// the sidebar, which is the one thing the web is explicit about — the aura
    /// is a sibling of the composer there for exactly this reason.
    func junoVoiceColumn(_ column: DesktopVoiceColumn?) -> some View {
        modifier(DesktopVoiceColumnLayer(column: column))
    }
}

private struct DesktopVoiceColumnLayer: ViewModifier {
    let column: DesktopVoiceColumn?

    /// `.voice-aura`'s `height: min(30rem, 46vh)`, resolved for a Mac window.
    ///
    /// The cap is what the number is *for*: the field's band reaches
    /// `min(height * 0.46, 150)`, so anything under about 330 quietly shortens
    /// the light and the effect stops reading as waves. The previous 260 sat
    /// well inside that — the same shape the browser draws, cropped to two
    /// thirds, which is most of why the Mac looked worse than the web.
    private static let fieldHeight: CGFloat = 460

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            if let column {
                DesktopVoiceDock(column: column)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.bottom, JunoSpace.snug)
                    .transition(.opacity)
            }
            content
        }
        // Behind the dock *and* the composer, which is the whole arrangement:
        // the web mounts the aura as a sibling at `z-index: -1` inside the host
        // that carries both, so the light passes under the pill as well as
        // under the composer. A `.background` on the pair is that, natively —
        // and anything drawn inside the dock would land in front of the thing
        // it is lighting.
        .background(alignment: .bottom) {
            if let column {
                DesktopVoiceField(controller: column.controller)
                    .frame(height: Self.fieldHeight)
                    // `bottom: -1.25rem`. The band's brightest edge belongs
                    // just past the composer, in the disclaimer's band, so the
                    // light looks like it is coming from under the column
                    // rather than stopping at a seam.
                    .offset(y: JunoSpace.roomy)
            }
        }
    }
}

/// The field, in a view of its own.
///
/// It is a leaf so that `level` — which the controller republishes about thirty
/// times a second — invalidates one `Canvas` and nothing else. Read from the
/// column's body instead, the same property would re-evaluate the composer, the
/// dock and everything else in the chat column on every audio frame.
private struct DesktopVoiceField: View {
    let controller: JunoRealtimeVoiceController

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Arriving mid-sentence is worse than arriving late, so the field fades up
    /// rather than appearing at full strength the frame the socket opens —
    /// `voice-aura-in` over `--dur-slow`. Held here rather than driven by a
    /// transition from the layer above, because the layer's animation would
    /// have to be one the composer shares, and the composer must not move.
    @State private var lit = false

    var body: some View {
        JunoVoiceAura(
            level: controller.level,
            speaking: controller.assistantSpeaking,
            active: controller.phase == .live || controller.phase == .reconnecting
        )
        .opacity(lit ? 1 : 0)
        .onAppear {
            withAnimation(JunoMotion.reduced(.easeOut(duration: 0.36), when: reduceMotion)) {
                lit = true
            }
        }
    }
}

/// **The voice dock** — a pill directly above the composer, over the chat the
/// call is about.
///
/// What this replaces was a 700×560 sheet, and removing it fixes a crash as well
/// as a design mistake. The sheet declared both an *ideal* size and
/// `.interactiveDismissDisabled()`, so when AppKit animated the window's frame —
/// entering full screen, a display change, a window restore — SwiftUI had to
/// re-solve a sheet size it could not satisfy and could not dismiss out of the
/// way, and `SheetBridge.sheetSize(presentationID:presenterSize:currentSize:)`
/// trapped on the main thread. A dock sized to its own content has no such
/// solve to fail.
///
/// The design mistake is the more interesting one. A spoken conversation is not
/// a *screen*: the moment voice takes the whole window, the message list, the
/// composer and every attachment control go with it, and "show Juno this
/// picture while we talk" becomes impossible. In place, all of that keeps
/// working and costs nothing to build. That is the web's arrangement
/// (`chat-view.tsx`), and this is the same one control for control.
///
/// The dock kept the words — what is happening, what it costs — and gave the
/// picture to ``JunoVoiceAura``, mounted as a sibling behind the composer. An
/// orb small enough to sit in a pill can only ever be decoration; the same
/// signal spread across the column is legible from across the room.
struct DesktopVoiceDock: View {
    let column: DesktopVoiceColumn

    @State private var isSaving = false
    /// A save that failed is a conversation that exists nowhere — the relay
    /// keeps nothing — so this stays on screen until it succeeds or the reader
    /// hangs up again.
    @State private var saveError: String?
    /// `motion-safe:animate-rise-in`. Self-driven rather than a `.transition`,
    /// because a transition only plays if whichever screen mounted the dock
    /// wrapped the change in `withAnimation` — and two screens mount it.
    @State private var risen = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var controller: JunoRealtimeVoiceController { column.controller }

    /// `realtime-voice.tsx`'s metrics, in points. Named rather than inlined
    /// because the same numbers have to agree in four places — a status column
    /// that is not exactly the control row's height is what lets the cost line
    /// grow the pill.
    private enum Metric {
        /// `size-9`. Also the smallest circle a pointer finds without aiming;
        /// the 30pt this replaces was under the platform's own minimum.
        static let control: CGFloat = 36
        /// `gap-0.5`.
        static let controlGap: CGFloat = 2
        /// `sm:w-[7.5rem]`. The narrow `w-[5.75rem]` case is a phone breakpoint
        /// with no equivalent here.
        static let statusWidth: CGFloat = 120
        /// `max-w-md`, the cap on anything that carries a sentence.
        static let messageWidth: CGFloat = 448
    }

    var body: some View {
        VStack(spacing: JunoSpace.tight) {
            // Failures speak rather than hide in a tooltip: the line names the
            // fix, and the control that applies it sits with it.
            if let message = failureMessage {
                failureBanner(message)
            }
            if let notice = controller.notice {
                noticeBanner(notice)
            }
            pill
        }
        .frame(maxWidth: 720)
        .opacity(risen ? 1 : 0)
        .offset(y: risen ? 0 : 8)
        .onAppear {
            withAnimation(
                JunoMotion.reduced(
                    .timingCurve(0.32, 0.72, 0, 1, duration: 0.32),
                    when: reduceMotion
                )
            ) {
                risen = true
            }
        }
        // Ends the call when the chat column goes — switching to Projects, or
        // signing out — because the alternative is a microphone that is open
        // with nothing on screen saying so. It deliberately does **not** start
        // one: `start()` is allowed from `ended`, so a dock that restarted on
        // appearance would silently redial every time the reader came back.
        // Starting is the screen's job, at the moment the button is pressed.
        .onDisappear { controller.end() }
        .accessibilityIdentifier("juno.desktop.voice")
    }

    /// `rounded-full`, not a large radius. A 24pt corner on a 44pt-tall pill is
    /// nearly a capsule and reads as *nearly* — the flat run along the top and
    /// bottom is exactly what makes a pill look hand-drawn next to the
    /// composer's own geometry.
    private var pill: some View {
        HStack(spacing: Metric.controlGap) {
            status
            controls
            optionsMenu
            hangUpButton
        }
        .padding(JunoSpace.hairline)
        .junoGlass(in: Capsule(style: .continuous))
        // The web lifts this pill further off the page than the composer below
        // it, and it has to: the dock is the transient thing, and depth is what
        // says so when the two surfaces are the same material.
        .shadow(color: .black.opacity(0.1), radius: 1, y: 1)
        .shadow(color: .black.opacity(0.18), radius: 12, y: 8)
    }

    // MARK: - Words

    /// Status and cost, in a fixed-width column.
    ///
    /// Held to the control row's height so the cost line cannot grow the pill,
    /// and to a fixed width so a status that changes length — "Listening" to
    /// "Juno is speaking" — does not slide every control sideways mid-sentence.
    private var status: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(statusTitle)
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .help(failureMessage ?? statusTitle)
            if let costLabel {
                Text(costLabel)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.6))
                    .lineLimit(1)
                    .help(costDetail)
            }
        }
        .frame(width: Metric.statusWidth, height: Metric.control, alignment: .leading)
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.tight)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// The web's ladder, verbatim, so the two products describe the same call in
    /// the same words.
    private var statusTitle: String {
        switch controller.phase {
        case .idle, .connecting: "Connecting"
        case .reconnecting: "Reconnecting…"
        case .error: "Voice unavailable"
        case .ended: "Session ended"
        case .live:
            controller.assistantSpeaking
                ? "Juno is speaking"
                : (controller.muted ? "Microphone off" : "Listening")
        }
    }

    /// Relay list prices, not billing — hence the tilde, and hence no
    /// announcement: this reprices every few seconds and would talk over the
    /// conversation it is measuring.
    private var costLabel: String? {
        guard let usage = controller.usage, usage.estCostUsd > 0 else { return nil }
        return "~" + Self.usd(usage.estCostUsd)
    }

    private var costDetail: String {
        guard let usage = controller.usage,
            let input = usage.estCostInUsd,
            let output = usage.estCostOutUsd
        else { return "Estimated session cost" }
        return "Estimated session cost · you ~\(Self.usd(input)) · Juno ~\(Self.usd(output))"
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

    /// The one line explaining why the call is not running, or why the last one
    /// could not be filed. A failed save wins: it is the only one of the two
    /// that still has something to lose.
    private var failureMessage: String? {
        if let saveError { return saveError }
        switch controller.phase {
        case .error(let error): return error.errorDescription
        case .ended(let reason):
            return switch reason {
            case .sessionLimit: "This voice session reached its time limit."
            case .provider: "The voice provider ended this session."
            case .error: "The voice relay ended this session after an error."
            case .client: nil
            }
        default: return nil
        }
    }

    /// A destructive-tinted strip, not a plate.
    ///
    /// The shipped build put this message on floating chrome at the dock's full
    /// width, so an audio-engine failure arrived as a wide unstyled rectangle
    /// above the pill — louder than the conversation it interrupted and, on a
    /// light window, near-white. The web's own treatment is the opposite of
    /// that and is what this is: `max-w-md`, small centred text, a hairline of
    /// `--destructive` and a wash of it behind, lifted by nothing more than
    /// `shadow-soft`. It is a remark, and it is coloured like a problem.
    private func failureBanner(_ message: String) -> some View {
        messageStrip(tint: Color.junoDanger) {
            Text(message)
                .font(.system(size: 12))
                .lineSpacing(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            // A denied microphone is fixed in Settings and never by trying
            // again — the system will not re-prompt — so this is the one
            // failure that offers a deep link instead of a retry.
            if case .error(let error) = controller.phase, error.isPermissionDenial {
                Button("Open Privacy Settings") {
                    let pane = error == .micPermissionDenied
                        ? "Privacy_Microphone" : "Privacy_SpeechRecognition"
                    if let url = URL(
                        string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"
                    ) {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.link)
                .font(.system(size: 12, weight: .medium))
            }
        }
        .accessibilityIdentifier("juno.desktop.voice-failure")
    }

    /// The relay's own asides — a provider degraded, a feature declined. Same
    /// strip, cautionary rather than destructive, so the column reads as one
    /// thing with two severities instead of two unrelated boxes.
    private func noticeBanner(_ notice: String) -> some View {
        messageStrip(tint: Color.junoCaution) {
            Label(notice, systemImage: "exclamationmark.circle")
                .font(.system(size: 12))
                .lineSpacing(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The shared shape of both strips.
    ///
    /// The one surface in this dock that is **not** Liquid Glass, and the
    /// exception is the point: glass has no way to say "destructive" quietly —
    /// a tint strong enough to read through it is a red pane, and anything
    /// weaker says nothing at all. A material with a semantic wash and a
    /// coloured rim says it at 7% and 30%, which is what the web does. The
    /// material stays because, unlike the browser's, this strip is over a
    /// scrolling transcript rather than over the page.
    ///
    /// `maxWidth` sits *outside* the tinted background on purpose: applied
    /// inside it, the frame would take the cap as its width and a four-word
    /// notice would arrive as a 448pt plate with a word in the middle of it.
    /// Out here the strip hugs its sentence and the frame only centres it and
    /// decides where the text wraps.
    private func messageStrip(
        tint: Color,
        @ViewBuilder content: () -> some View
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: JunoCornerRadius.row, style: .continuous)
        return VStack(spacing: JunoSpace.hairline, content: content)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .background(tint.opacity(0.07), in: shape)
            .background(.regularMaterial, in: shape)
            .overlay(shape.strokeBorder(tint.opacity(0.3), lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 5, y: 3)
            .frame(maxWidth: Metric.messageWidth)
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        if isRestartable {
            control("arrow.clockwise", label: "Restart voice", tone: .prominent) {
                saveError = nil
                Task { await controller.start() }
            }
            .accessibilityIdentifier("juno.desktop.voice-restart")
        } else {
            // Barge-in, offered only while there is something to interrupt. A
            // permanently disabled square is chrome that means nothing.
            if controller.assistantSpeaking, controller.phase == .live {
                control("stop.fill", label: "Interrupt Juno", tone: .prominent) {
                    controller.interrupt()
                }
                .accessibilityIdentifier("juno.desktop.voice-interrupt")
                .transition(.scale.combined(with: .opacity))
            }
            control(
                controller.muted ? "mic.slash.fill" : "mic.fill",
                label: controller.muted ? "Turn microphone on" : "Turn microphone off",
                tone: controller.muted ? .prominent : .quiet
            ) {
                controller.toggleMute()
            }
            .disabled(controller.phase != .live)
            .accessibilityIdentifier("juno.desktop.voice-mute")
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

    /// The chevron, with a circle under it.
    ///
    /// The circle is not decoration. Without it the menu's label was the glyph
    /// alone, so the only clickable pixels in a 36pt slot were the arrow's own
    /// strokes — the control looked like its neighbours and behaved like a
    /// link. The label now fills the slot and carries the hit shape, which is
    /// also what `bg-muted/45` does on the web.
    private var optionsMenu: some View {
        Menu {
            Section("Voice model") {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        if controller.phase == .live {
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
                    .disabled(controller.phase == .live && provider == controller.provider)
                }
            }
            // Only Gemini and Qwen accept a screen; OpenAI does not. Gated on
            // what the relay actually said in `session.ready` rather than on a
            // list kept here, which would be a second copy to drift.
            if controller.capabilities?.screenInput == true {
                Divider()
                Button {
                    if controller.screenSharing {
                        controller.stopScreenShare()
                    } else {
                        controller.startScreenShare()
                    }
                } label: {
                    Label(
                        controller.screenSharing ? "Stop sharing screen" : "Share screen",
                        systemImage: controller.screenSharing ? "rectangle.slash" : "rectangle.on.rectangle"
                    )
                }
                .accessibilityIdentifier("juno.desktop.voice-share-screen")
            }
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 13, weight: .medium))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.junoMuted.opacity(0.45), in: Circle())
                .contentShape(Circle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: Metric.control, height: Metric.control)
        .accessibilityLabel("Voice options")
        .accessibilityIdentifier("juno.desktop.voice-options")
    }

    private var hangUpButton: some View {
        Button {
            hangUp()
        } label: {
            Group {
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: Metric.control, height: Metric.control)
            .background(Color.junoDanger, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .help("End and save")
        .accessibilityLabel("End voice conversation")
        .accessibilityIdentifier("juno.desktop.voice-end")
    }

    private enum ControlTone {
        /// `bg-foreground text-background` — the one control that is the
        /// obvious next move.
        case prominent
        /// `bg-muted/65` — present, and not asking for anything.
        case quiet
    }

    private func control(
        _ symbol: String,
        label: String,
        tone: ControlTone,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                // `Color.junoCanvas`, never the `.background` shape style: that
                // one resolves against whatever surface the control is sitting
                // on, and on glass it comes back translucent — a filled black
                // circle with a grey-looking glyph, which is precisely how the
                // one enabled control in an errored session ended up reading as
                // disabled.
                .foregroundStyle(tone == .prominent ? Color.junoCanvas : Color.primary)
                .frame(width: Metric.control, height: Metric.control)
                .background(
                    tone == .prominent ? Color.primary : Color.junoMuted.opacity(0.65),
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
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
        controller.end()
        let turns = savableTurns
        guard !turns.isEmpty else {
            column.close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            do {
                _ = try await column.saveTranscript(column.sessionID, turns)
                column.close()
            } catch {
                saveError = error.localizedDescription
                isSaving = false
            }
        }
    }

    /// The finished lines, in order. Non-final lines are live hypotheses the
    /// recognizer is still rewriting, and saving one puts a half-heard sentence
    /// into the reader's permanent history.
    private var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let content = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !content.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: content
            )
        }
    }
}
