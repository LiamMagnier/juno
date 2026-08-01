import AVFoundation
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

/// **The camera during a spoken call** — "show Juno what you are looking at".
///
/// The phone's answer to the Mac's screen share, and the honest one: a desktop
/// can hand a model its screen, but the interesting thing in front of a phone is
/// never on the phone. Everything downstream of here already existed —
/// ``JunoRealtimeVoiceController/sendVideoFrame(_:)``, the relay's `video.frame`
/// and the provider fan-out have carried camera frames since they were written,
/// and its doc comment says so. What was missing was a producer, which is all
/// this is: a capture session whose frames go to the model instead of to a
/// message.
///
/// It owns its own ``JunoCameraCaptureService`` rather than sharing the
/// attachment panel's. Two reasons, and the second is the important one: the
/// two want different presets (see ``JunoCameraPurpose``), and the panel's
/// session is torn down every time the panel closes — a call whose camera died
/// because someone attached a photo would be a bug nobody could describe.
///
/// The phone still has one camera. Opening the attachment panel during a call
/// therefore interrupts this session rather than running beside it — iPhone
/// grants the device to one `AVCaptureSession` at a time, and only
/// `AVCaptureMultiCamSession` says otherwise. Nothing here pretends that away:
/// the reader gets a still preview and this one goes dark until they close the
/// panel and turn it on again.
///
/// **Off means off.** ``stop()`` drops the service, which stops the session,
/// which puts the hardware indicator out. Hiding the preview and leaving the
/// session running would be the cheaper implementation and a trust bug: a green
/// dot that stays lit after the reader turned the camera off is the app saying
/// one thing and the system saying another, and the system is the one people
/// believe.
@MainActor
@Observable
final class JunoMobileVoiceCamera {
    enum Phase: Equatable {
        case off
        case starting
        case live
        case unavailable(JunoCameraUnavailability)
    }

    private(set) var phase: Phase = .off
    private(set) var capabilities = JunoCameraCapabilities()

    /// Nil whenever the camera is off, which is what makes "off" true rather
    /// than merely invisible.
    private var service: JunoCameraCaptureService?

    var session: AVCaptureSession? { service?.session }
    var isLive: Bool { phase == .live }
    var isBusy: Bool { phase == .starting }

    /// Why there is no picture, if there is a reason worth saying.
    var unavailability: JunoCameraUnavailability? {
        if case .unavailable(let reason) = phase { return reason }
        return nil
    }

    /// Brings the camera up and points its frames at the live session.
    ///
    /// The controller is passed in rather than held: this outlives no call, and
    /// a stored strong reference to the thing that owns the microphone is how a
    /// hung-up session stays alive holding a camera.
    func start(sending to: JunoRealtimeVoiceController) async {
        guard phase != .starting, phase != .live else { return }
        phase = .starting
        let service = JunoCameraCaptureService(purpose: .frames)
        self.service = service

        switch await service.prepare() {
        case .success(let capabilities):
            // A permission prompt can easily outlive the call that raised it —
            // the reader can hang up while the alert is on screen. Without this
            // the session would come up behind an ended call, streaming a
            // camera nothing is listening to.
            guard self.service === service, phase == .starting else {
                await service.stop()
                return
            }
            self.capabilities = capabilities
            phase = .live
            service.startFrameStream { [weak to] jpeg in
                // The hop is the point: `sendVideoFrame` base64-encodes and
                // writes to the socket, and its own doc comment is explicit that
                // this belongs on the main actor and not on a capture thread.
                // A frame a second there costs nothing.
                Task { @MainActor in to?.sendVideoFrame(jpeg) }
            }
        case .failure(let reason):
            self.service = nil
            phase = .unavailable(reason)
        }
    }

    func stop() {
        guard phase != .off else { return }
        phase = .off
        capabilities = JunoCameraCapabilities()
        guard let service else { return }
        self.service = nil
        service.stopFrameStream()
        Task { await service.stop() }
    }

    func flip() async {
        guard phase == .live, capabilities.canFlip, let service else { return }
        capabilities = await service.flip()
    }
}

/// The self-view: a small picture-in-picture of what the model is being sent.
///
/// Small, and above the dock rather than over the chat, because the dock exists
/// so the conversation stays readable during a call — ``JunoMobileVoiceDock``
/// replaced a full-screen cover for exactly that reason. Reusing
/// ``JunoMobileCameraPanel`` here would have undone it: that panel covers the
/// lower half of the screen and carries a shutter and a dismiss-drag, neither of
/// which means anything when the camera is not taking a photo.
///
/// It is deliberately a *self*-view. Nothing else on screen says a camera is on;
/// a picture of yourself does, at a glance, from across a room.
struct JunoMobileVoiceSelfView: View {
    let camera: JunoMobileVoiceCamera
    let stop: () -> Void

    private static let width: CGFloat = 92
    private static let height: CGFloat = 122

    var body: some View {
        if let session = camera.session, camera.isLive {
            preview(session)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .transition(.scale(scale: 0.9, anchor: .bottomTrailing).combined(with: .opacity))
        }
    }

    private func preview(_ session: AVCaptureSession) -> some View {
        JunoCameraPreview(session: session)
            .frame(width: Self.width, height: Self.height)
            .clipShape(RoundedRectangle(cornerRadius: JunoCornerRadius.row, style: .continuous))
            .overlay(alignment: .top) { seeingBadge }
            .overlay(alignment: .bottom) { controls }
            .overlay {
                RoundedRectangle(cornerRadius: JunoCornerRadius.row, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("voice.camera.live")
            .accessibilityIdentifier("juno.mobile.voice-camera-preview")
    }

    /// Says what is happening in words as well as in pixels — a preview alone
    /// reads as "the app is using the camera", not as "this is being sent".
    private var seeingBadge: some View {
        HStack(spacing: JunoSpace.hairline) {
            Circle()
                .fill(Color.junoAccent)
                .frame(width: 5, height: 5)
            Text("voice.camera.live")
                .font(.system(size: 10, weight: .semibold))
        }
        .padding(.horizontal, JunoSpace.tight)
        .padding(.vertical, 3)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.top, JunoSpace.hairline)
        .accessibilityHidden(true)
    }

    private var controls: some View {
        HStack(spacing: JunoSpace.tight) {
            if camera.capabilities.canFlip {
                cornerButton(
                    // Front/back is the OS's own affordance and keeps the OS's
                    // own glyph, per the rule on ``JunoIcon``.
                    systemImage: "arrow.triangle.2.circlepath.camera",
                    label: "attachments.camera.flip",
                    identifier: "juno.mobile.voice-camera-flip"
                ) {
                    Task { await camera.flip() }
                }
            }
            cornerButton(
                systemImage: "xmark",
                label: "voice.camera.stop",
                identifier: "juno.mobile.voice-camera-stop",
                action: stop
            )
        }
        .padding(.bottom, JunoSpace.tight)
    }

    /// A stop control *on* the preview as well as in the dock, because the
    /// preview is where someone looks when they want the camera to be off.
    private func cornerButton(
        systemImage: String,
        label: LocalizedStringKey,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 26, height: 26)
                .background(.ultraThinMaterial, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
