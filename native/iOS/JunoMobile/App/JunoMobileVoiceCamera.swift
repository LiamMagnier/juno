import CoreImage
import CoreMedia
import AVFoundation
import JunoDesignSystem
import JunoVoiceKit
@preconcurrency import ReplayKit
import SwiftUI
import UIKit

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

/// App-screen sharing for an iPhone voice call.
///
/// ReplayKit gives the user an explicit system capture prompt and streams the
/// app's visible screen. Frames are reduced to the same one-per-second JPEG
/// budget used by the Mac's screen capture, then use the existing voice relay's
/// `video.frame` path. It is intentionally separate from the camera service:
/// the two capture APIs have different lifetimes and must never fight over the
/// camera session.
@MainActor
@Observable
final class JunoMobileVoiceScreenShare {
    enum Phase: Equatable {
        case off
        case starting
        case live
        case unavailable(String)
    }

    private(set) var phase: Phase = .off
    private var recorder: RPScreenRecorder?
    private var controller: JunoRealtimeVoiceController?

    var isLive: Bool { phase == .live }
    var isBusy: Bool { phase == .starting }
    var message: String? {
        if case .unavailable(let message) = phase { return message }
        return nil
    }

    func start(sending to: JunoRealtimeVoiceController) async {
        guard phase != .starting, phase != .live else { return }
        guard to.phase == .live, to.capabilities?.videoInput == true else {
            phase = .unavailable("Screen sharing is not available for this voice provider.")
            return
        }
        guard RPScreenRecorder.shared().isAvailable else {
            phase = .unavailable("Screen sharing is unavailable on this device.")
            return
        }

        let recorder = RPScreenRecorder.shared()
        self.recorder = recorder
        controller = to
        phase = .starting
        let gate = FrameGate()
        let error = await beginCapture(recorder, gate: gate, sending: to)

        guard self.recorder === recorder, phase == .starting else { return }
        if let error {
            self.recorder = nil
            controller = nil
            phase = .unavailable(
                "Screen sharing could not start: \(error.localizedDescription)"
            )
        } else {
            phase = .live
        }
    }

    func stop() {
        guard phase != .off else { return }
        phase = .off
        let recorder = self.recorder
        self.recorder = nil
        controller = nil
        recorder?.stopCapture()
    }

    private func beginCapture(
        _ recorder: RPScreenRecorder,
        gate: FrameGate,
        sending controller: JunoRealtimeVoiceController
    ) async -> Error? {
        await withCheckedContinuation { continuation in
            recorder.startCapture(
                handler: { [weak self, weak controller] sampleBuffer, type, error in
                    guard error == nil, type == .video, gate.allowsNextFrame(),
                          let jpeg = Self.jpeg(from: sampleBuffer)
                    else { return }
                    Task { @MainActor in
                        guard let self, self.phase == .live || self.phase == .starting else {
                            return
                        }
                        controller?.sendVideoFrame(jpeg)
                    }
                },
                completionHandler: { error in
                    continuation.resume(returning: error)
                }
            )
        }
    }

    private static func jpeg(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let longestEdge = max(image.extent.width, image.extent.height)
        let scale = min(1, 1_024 / max(longestEdge, 1))
        let resized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let extent = resized.extent.integral
        guard let cgImage = CIContext().createCGImage(resized, from: extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.6)
    }

    /// ReplayKit supplies many frames per second; the relay and model need one.
    private final class FrameGate: @unchecked Sendable {
        private let lock = NSLock()
        private var lastFrame = Date.distantPast

        func allowsNextFrame() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            let now = Date()
            guard now.timeIntervalSince(lastFrame) >= 1 else { return false }
            lastFrame = now
            return true
        }
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
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
            .overlay(alignment: .top) { seeingBadge }
            .overlay(alignment: .bottom) { controls }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
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
